import { randomUUID } from "node:crypto";
import { LLM_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { AgenticError, parseTurnAttachments, turnAttachmentsPayload, type RunTurnInput, type RunTurnResult, type SessionStore, type ToolExecutionPolicy } from "@0xsyncroot/contracts";
import { UnlimitedTurnAdmissionController } from "../admission/turn-admission.js";
import { sha256 } from "../hash.js";
import type { RuntimeProvider, RuntimeViewLease } from "../runtime-provider.js";
import { PermissionToolExecutionPolicy } from "../security/permission-tool-execution-policy.js";
import type { AgentRuntimeDependencies, AgentRuntimeOptions } from "./agent-options.js";
import { runAgentOperation, type AgentOperationContext } from "./agent-operation.js";
import { runClaimedTurn, type ClaimedTurn } from "./claimed-turn.js";
import { toJsonValue } from "./json-value.js";
import { report } from "./operation-observers.js";
import { closeOpenPauses } from "./pause-closure.js";
import { snapshotRunTurnInput } from "./run-turn-input-policy.js";
import { TurnJournalView } from "./turn-journal-view.js";
import { replayClaimedTurn } from "./turn-replay.js";
import { prepareTurnSetup } from "./turn-setup.js";
import { TurnStepLoop } from "./turn-step-loop.js";
import { JudgmentMemo } from "./judgment-memo.js";
import { FirstEventModel } from "./first-event-model.js";
import { startOpeningLine, type OpeningLine } from "./opening-line.js";

export class RunTurnUseCase {
  readonly #toolPolicy: ToolExecutionPolicy;
  readonly #operation: AgentOperationContext;
  readonly #stepLoop: TurnStepLoop;

  constructor(
    runtimeProvider: RuntimeProvider,
    private readonly sessions: SessionStore,
    private readonly options: AgentRuntimeOptions,
    private readonly dependencies: AgentRuntimeDependencies,
    private readonly runtimeOwnerId: string,
    /** The judge's verdicts, shared by the loop's three operations so a resume reuses what its turn asked. */
    judgments = new JudgmentMemo(),
    /** What the runtime has learned of its models' first events, shared by the three operations (`FirstEventModel`). */
    firstEvents = new FirstEventModel(),
  ) {
    this.#toolPolicy = dependencies.toolExecutionPolicy ?? new PermissionToolExecutionPolicy();
    this.#operation = {
      operation: "run-turn", runtimeProvider, telemetry: dependencies.telemetry,
      admission: dependencies.admissionController ?? new UnlimitedTurnAdmissionController(),
    };
    this.#stepLoop = new TurnStepLoop(options, dependencies, judgments, firstEvents);
  }

  async execute(input: RunTurnInput): Promise<RunTurnResult> {
    const command = snapshotRunTurnInput(input);
    if (command.content.length > this.options.maxInputChars) throw new AgenticError("validation", `Input exceeds ${this.options.maxInputChars} characters`);
    const keyed = { ...command, idempotencyKey: command.idempotencyKey ?? randomUUID() };
    return runAgentOperation(this.#operation, keyed, async (acquire) => this.#executeWithRuntime(keyed, await acquire()));
  }

  async #executeWithRuntime(input: RunTurnInput, runtimeLease: RuntimeViewLease): Promise<RunTurnResult> {
    const runtime = runtimeLease.snapshot;
    const turnId = randomUUID();
    // A new turn only: a resume's synthesized RunTurnInput never carries attachments, so this is
    // undefined for every resume without needing an operation check here.
    const attachments = input.attachments !== undefined ? parseTurnAttachments(input.attachments) : undefined;
    const executionKey = input.idempotencyKey ?? turnId;
    const requestFingerprint = sha256({
      tenantId: input.security.tenantId, actorId: input.security.actorId,
      grantRevision: input.security.grantRevision ?? "unspecified", sessionId: input.sessionId,
      agentProfileId: input.agentProfileId ?? "default", content: input.content.replace(/\r\n/g, "\n").trim(),
      applicationContext: input.applicationContext ?? null,
      // Ids alone: an idempotency key reused with the same words but a different file must not
      // replay the previous turn's answer, which was about a different document.
      attachments: attachments ? attachments.map((attachment) => attachment.id) : null,
    });
    const claim = await this.sessions.claimTurn({
      sessionId: input.sessionId, turnId, ownerId: this.runtimeOwnerId,
      idempotencyKey: executionKey, requestFingerprint, agentProfileId: input.agentProfileId ?? "default",
      leaseTtlMs: this.options.leaseTtlMs,
      startEvents: [
        { type: "turn/start", turnId, payload: toJsonValue({
          inputIdempotencyKey: executionKey,
          runtimeBinding: runtimeLease.binding,
        }) },
        ...(input.applicationContext ? [{
          type: "application/context", turnId, classification: "confidential" as const,
          payload: toJsonValue(input.applicationContext),
        }] : []),
        { type: "user/input", turnId, payload: {
          content: input.content, source: "external",
          ...(attachments !== undefined ? { attachments: turnAttachmentsPayload(attachments) } : {}),
        } },
      ],
    }, { security: input.security, runtime });
    if (claim.kind === "in-progress") throw new AgenticError("conflict", `Session turn is still in progress: ${claim.turnId}; retry after ${claim.retryAfterMs}ms`);
    if (claim.kind === "failed") throw new AgenticError("conflict", `Previous idempotent turn failed: ${claim.turnId} (${claim.code})`);
    // The operation's one bounded read, taken after the claim so it already holds this turn's start.
    const view = await TurnJournalView.open(this.sessions, input.sessionId, input.security);
    if (claim.kind === "completed") {
      const replay = await replayClaimedTurn({ view, store: this.sessions, sessionId: input.sessionId, security: input.security, turnId: claim.turnId });
      if (!replay) throw new AgenticError("conflict", `Completed turn cannot be reconstructed: ${claim.turnId}`);
      const steps = replay.events.filter((event) => event.type === "step/start").length;
      report(input, { type: "turn-completed", turnId: replay.turnId, steps, outcome: replay.outcome, replayed: true });
      return replay;
    }
    report(input, { type: "turn-started", turnId });
    return runClaimedTurn({
      sessions: this.sessions, options: this.options,
      input: attachments !== undefined ? { ...input, attachments } : input,
      turnId, claim, view, runtimeLease, operation: "run-turn",
      ...(this.dependencies.telemetry ? { telemetry: this.dependencies.telemetry } : {}),
      ...(this.dependencies.turnControlPolicy ? { turnControlPolicy: this.dependencies.turnControlPolicy } : {}),
      ...(this.dependencies.continueQuestion ? { continueQuestion: this.dependencies.continueQuestion } : {}),
    }, async (turn) => {
      // Before anything else, and beside all of it: the user's request is acknowledged while the turn prepares.
      const opening = this.#openingLine(turn);
      try {
        // What the previous turn left waiting on the user is closed before anything reads the journal.
        await closeOpenPauses(turn);
        return await this.#stepLoop.execute({
          turn,
          setup: await prepareTurnSetup(turn, {
            options: this.options, toolPolicy: this.#toolPolicy,
            ...(this.dependencies.toolExecutionBroker ? { toolExecutionBroker: this.dependencies.toolExecutionBroker } : {}),
            ...(this.dependencies.toolResultSpool ? { toolResultSpool: this.dependencies.toolResultSpool } : {}),
            ...(this.dependencies.toolGroups ? { toolGroups: this.dependencies.toolGroups } : {}),
            ...(this.dependencies.standingApproval ? { standingApproval: this.dependencies.standingApproval } : {}),
          }),
        });
      } finally {
        await opening?.close();
      }
    });
  }

  /** Only a turn the user started has an opening line: a resume answers a card, and its request was acknowledged when it was made. */
  #openingLine(turn: ClaimedTurn): OpeningLine | undefined {
    const instruction = this.dependencies.modelInstructions?.openingLine;
    const llm = turn.runtimeLease.capabilities.optional(LLM_CAPABILITY);
    return instruction && llm && turn.input.content.trim() ? startOpeningLine(turn, llm, instruction) : undefined;
  }
}
