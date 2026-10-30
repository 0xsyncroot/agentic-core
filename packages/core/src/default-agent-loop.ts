import { randomUUID } from "node:crypto";
import { AgenticError, type ResumableAgent, type ResumeHumanInteractionInput, type ResumeTurnInput, type RunTurnInput, type RunTurnResult, type SessionStore, validateToolGroupCatalog } from "@0xsyncroot/contracts";
import {
  resolveAgentOptions,
  type AgentRuntimeDependencies,
  type AgentRuntimeOptions,
} from "./agent/agent-options.js";
import { RunTurnUseCase } from "./agent/run-turn-use-case.js";
import { ApprovalResumeUseCase } from "./agent/approval-resume-use-case.js";
import type { RuntimeProvider } from "./runtime-provider.js";
import { HumanInteractionResumeUseCase } from "./agent/human-interaction-resume-use-case.js";
import { JudgmentMemo } from "./agent/judgment-memo.js";
import { FirstEventModel } from "./agent/first-event-model.js";

export type { AgentRuntimeDependencies, AgentRuntimeOptions, RunTurnInput, RunTurnResult };

/** Public concurrency facade over the default turn application service. */
export class DefaultAgentLoop implements ResumableAgent {
  readonly #activeSessions = new Set<string>();
  readonly #runTurn: RunTurnUseCase;
  readonly #resumeTurn: ApprovalResumeUseCase;
  readonly #resumeInteraction: HumanInteractionResumeUseCase;

  constructor(
    runtimeProvider: RuntimeProvider,
    sessions: SessionStore,
    options: number | Partial<AgentRuntimeOptions> = {},
    dependencies: AgentRuntimeDependencies = {},
  ) {
    const resolved = resolveAgentOptions(options);
    if (dependencies.toolGroups) validateToolGroupCatalog(dependencies.toolGroups);
    const runtimeOwnerId = randomUUID();
    // One memory of the judge's verdicts for all three: a resume is a new turn of the same request (`JudgmentMemo`).
    const judgments = new JudgmentMemo();
    // One learner of how long a model's first event takes, for all three: the model and the gateway are the runtime's, not the
    // operation's. Per use case, a runtime that mostly resumes would never reach the five samples and hedge at the prior.
    const firstEvents = new FirstEventModel();
    this.#runTurn = new RunTurnUseCase(runtimeProvider, sessions, resolved, dependencies, runtimeOwnerId, judgments, firstEvents);
    this.#resumeTurn = new ApprovalResumeUseCase(runtimeProvider, sessions, resolved, dependencies, runtimeOwnerId, judgments, firstEvents);
    this.#resumeInteraction = new HumanInteractionResumeUseCase(runtimeProvider, sessions, resolved, dependencies, runtimeOwnerId, judgments, firstEvents);
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const sessionScope = JSON.stringify([input.security.tenantId, input.sessionId]);
    if (this.#activeSessions.has(sessionScope)) {
      throw new AgenticError("conflict", `Session ${input.sessionId} already has a writer`);
    }
    this.#activeSessions.add(sessionScope);
    try { return await this.#runTurn.execute(input); }
    finally { this.#activeSessions.delete(sessionScope); }
  }

  async resumeTurn(input: ResumeTurnInput): Promise<RunTurnResult> {
    const sessionScope = JSON.stringify([input.security.tenantId, input.sessionId]);
    if (this.#activeSessions.has(sessionScope)) throw new AgenticError("conflict", `Session ${input.sessionId} already has a writer`);
    this.#activeSessions.add(sessionScope);
    try { return await this.#resumeTurn.execute(input); }
    finally { this.#activeSessions.delete(sessionScope); }
  }

  async resumeInteraction(input: ResumeHumanInteractionInput): Promise<RunTurnResult> {
    const sessionScope = JSON.stringify([input.security.tenantId, input.sessionId]);
    if (this.#activeSessions.has(sessionScope)) throw new AgenticError("conflict", `Session ${input.sessionId} already has a writer`);
    this.#activeSessions.add(sessionScope);
    try { return await this.#resumeInteraction.execute(input); }
    finally { this.#activeSessions.delete(sessionScope); }
  }
}
