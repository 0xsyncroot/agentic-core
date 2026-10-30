import { AgenticError, type AgentOperation, type AgentTelemetrySink, type LlmUsage, type RunTurnInput, type RunTurnResult, type TurnAdmissionController } from "@0xsyncroot/contracts";
import { acquireRuntimeView, type RuntimeProvider, type RuntimeViewLease } from "../runtime-provider.js";
import { observe } from "./operation-observers.js";

/**
 * Leases the operation's one runtime view. `pin` is core's own, read from the journal by a resume once it has found its
 * pause; a request never supplies it. A second call in the same operation is refused.
 */
export type RuntimeAcquire = (pin?: string) => Promise<RuntimeViewLease>;

export interface AgentOperationContext {
  readonly operation: AgentOperation;
  readonly runtimeProvider: RuntimeProvider;
  readonly admission: TurnAdmissionController;
  readonly telemetry: AgentTelemetrySink | undefined;
}

/**
 * The envelope every agent operation runs in: admitted, observed, and pinned to one runtime view.
 *
 * Admission is settled with the operation's real outcome and usage, telemetry always sees a
 * finished event balancing the started one, and the runtime lease is released however the work
 * ends. `command.idempotencyKey` is what admission is keyed on, so the caller sets it first.
 * The work acquires the lease itself, at most once, so a resume can read its pause before it
 * chooses the route; whatever it acquired is released here, never by the work.
 */
export async function runAgentOperation(
  context: AgentOperationContext,
  command: RunTurnInput,
  work: (acquire: RuntimeAcquire) => Promise<RunTurnResult>,
): Promise<RunTurnResult> {
  const startedAt = Date.now();
  const { operation, telemetry } = context;
  const admission = await context.admission.acquire({
    security: command.security, sessionId: command.sessionId, idempotencyKey: command.idempotencyKey!,
    agentProfileId: command.agentProfileId ?? "default",
  }, command.signal);
  const identity = {
    operation, tenantId: command.security.tenantId, sessionId: command.sessionId, correlationId: command.security.correlationId,
  };
  observe(telemetry, { type: "agent.operation.started", ...identity, occurredAt: new Date(startedAt).toISOString() });
  let acquired: Promise<RuntimeViewLease> | undefined;
  const acquire: RuntimeAcquire = (pin) => {
    if (acquired) return Promise.reject(new AgenticError("permanent", "An agent operation acquires its runtime once"));
    acquired = acquireRuntimeView(context.runtimeProvider, {
      security: command.security, ...(command.agentProfileId ? { agentProfileId: command.agentProfileId } : {}),
      ...(pin !== undefined ? { pin } : {}),
    });
    return acquired;
  };
  let outcome: RunTurnResult["outcome"] | "failed" = "failed";
  let usage: LlmUsage | undefined;
  try {
    const result = await work(acquire);
    outcome = result.outcome;
    usage = result.usage;
    return result;
  } finally {
    // A refused acquisition leased nothing: acquireRuntimeView released what it refused.
    if (acquired) (await acquired.catch(() => undefined))?.release();
    try { await admission.settle({ outcome, ...(usage ? { usage } : {}) }); }
    finally {
      observe(telemetry, {
        type: "agent.operation.finished", ...identity, outcome,
        durationMs: Math.max(0, Date.now() - startedAt), ...(usage ? { usage } : {}), occurredAt: new Date().toISOString(),
      });
    }
  }
}
