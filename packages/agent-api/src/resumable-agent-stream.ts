import { createHash } from "node:crypto";
import type { ClosableInterjections } from "./interjection-queue.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgenticError, canonicalJson, type SecurityContext } from "@0xsyncroot/contracts";

export interface ResumableAgentStreamKey {
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly requestId: string;
}

export interface ResumableAgentStreamEvent {
  readonly id: number;
  readonly event: string;
  readonly data: string;
}

export interface ResumableAgentStreamObserver {
  event(event: ResumableAgentStreamEvent): void;
  end(): void;
}

export interface ResumableAgentStreamOperation {
  readonly key: ResumableAgentStreamKey;
  readonly lastEventId: number;
  readonly terminal: boolean;
  start(): void;
  subscribe(afterEventId: number, observer: ResumableAgentStreamObserver): Promise<() => void>;
}

export interface ResumableAgentStreamRegistry {
  /** True only when operation ownership and replay journals are shared across production API nodes. */
  readonly productionSafe: boolean;
  acquire(input: {
    readonly key: ResumableAgentStreamKey;
    readonly fingerprint: string;
    /**
     * `interjections` is what the user has said since the turn started, for the runner to drain at
     * its own boundaries. It comes from here, not from the request that started the turn, because
     * the words arrive on a *different* request — exactly like a cancel, and found the same way:
     * by this operation's key, on whichever node happens to receive them.
     */
    readonly run: (
      publish: (event: string, payload: unknown) => void,
      signal: AbortSignal,
      interjections: ClosableInterjections,
    ) => Promise<void>;
  }): Promise<{ readonly operation: ResumableAgentStreamOperation; readonly created: boolean }>;
  cancel(key: ResumableAgentStreamKey): Promise<boolean>;
  /**
   * Hands a running turn something the user said after it began. False when there is nothing
   * running to hand it to, or when this turn is already holding as many unread interjections as
   * it will take — both of which the caller must tell the user, because a sentence they typed to
   * correct the agent that silently went nowhere is worse than a refusal they can act on.
   */
  interject(key: ResumableAgentStreamKey, content: string): Promise<boolean>;
  /**
   * Graceful shutdown for this node: stop creating new operations it would own (`acquire` of a key
   * this node would newly own rejects as transient; attaching to an existing operation still
   * works), wait until every operation this node owns has published its terminal event or
   * `graceMs` elapses, then abort those still running and wait briefly for their terminal event.
   * Does not close shared resources (a Redis client, for instance) — that is the caller's own to
   * close, after `drain` returns. Idempotent; concurrent calls share one drain.
   */
  drain(graceMs: number): Promise<void>;
  close(): Promise<void>;
}

export function resumableAgentStreamKey(
  security: SecurityContext,
  input: { readonly sessionId: string; readonly requestId: string },
): ResumableAgentStreamKey {
  return { tenantId: security.tenantId, actorId: security.actorId, sessionId: input.sessionId, requestId: input.requestId };
}

export function resumableAgentStreamFingerprint(
  security: SecurityContext,
  input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly content: string;
    readonly agentProfileId?: string;
    readonly agentContext?: unknown;
  },
): string {
  return resumableAgentOperationFingerprint(security, input, "turn", {
    content: input.content,
    agentProfileId: input.agentProfileId ?? "default",
    agentContext: input.agentContext ?? null,
  });
}

/** Binds a resumable delivery journal to one authenticated, typed public operation. */
export function resumableAgentOperationFingerprint(
  security: SecurityContext,
  input: { readonly sessionId: string; readonly requestId: string },
  operation: string,
  payload: unknown,
): string {
  return createHash("sha256").update(canonicalJson({
    tenantId: security.tenantId,
    actorId: security.actorId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    operation,
    payload,
    permissions: [...security.permissions].sort(),
    roles: [...(security.roles ?? [])].sort(),
    grantRevision: security.grantRevision ?? null,
    authentication: security.authentication ?? null,
    authorizedAgentProfiles: [...(security.authorizedAgentProfiles ?? [])].sort(),
    trustedContext: security.trustedContext ?? null,
  })).digest("hex");
}

export function requestedLastEventId(request: IncomingMessage): number {
  const value = request.headers["last-event-id"];
  if (value === undefined || value === "") return 0;
  if (Array.isArray(value) || !/^\d+$/.test(value)) throw new AgenticError("validation", "Last-Event-ID must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AgenticError("validation", "Last-Event-ID exceeds the supported range");
  return parsed;
}

export async function pipeResumableAgentStream(
  operation: ResumableAgentStreamOperation,
  response: ServerResponse,
  afterEventId: number,
): Promise<void> {
  let detach: () => void = () => undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      let settled = false;
      finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
    });
    response.once("close", finish);
    heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(": keep-alive\n\n");
    }, 15_000);
    heartbeat.unref();
    detach = await operation.subscribe(afterEventId, {
      event: (item) => {
        if (!response.writableEnded && !response.destroyed) {
          response.write(`id: ${item.id}\nevent: ${item.event}\ndata: ${item.data}\n\n`);
        }
      },
      end: () => {
        if (!response.writableEnded && !response.destroyed) response.end();
        finish();
      },
    });
    operation.start();
    await completion;
  } finally {
    detach();
    if (heartbeat) clearInterval(heartbeat);
  }
}
