import type { RuntimeSnapshot } from "../runtime/runtime-snapshot.js";
import type { SecurityContext } from "../security/security-context.js";
import type { DataClassification, JsonValue } from "../shared/json.js";
import type { SessionContextView } from "./context-compaction.js";
import { assertValidCoreEventDraft } from "./core-event-validation.js";

export interface EventDraft {
  readonly type: string; readonly schemaVersion?: number; readonly turnId?: string; readonly stepId?: string;
  readonly requestId?: string; readonly callId?: string; readonly attemptId?: string;
  readonly classification?: DataClassification; readonly payload: JsonValue;
}
function freezeDraft<T>(value: T): T {
  const pending: object[] = [];
  if (value && typeof value === "object") pending.push(value);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }
  return value;
}
/** Takes an immutable JSON snapshot before adapters cross an asynchronous boundary. */
export function snapshotEventDraft(draft: EventDraft): EventDraft {
  let serialized: string;
  try {
    serialized = JSON.stringify(draft);
    if (serialized === undefined) throw new Error();
  } catch {
    throw new Error("Event draft must be JSON serializable");
  }
  const snapshot = JSON.parse(serialized) as EventDraft;
  assertValidCoreEventDraft(snapshot);
  return freezeDraft(snapshot);
}
export interface SessionEvent extends EventDraft {
  readonly eventId: string; readonly sessionId: string; readonly seq: number; readonly occurredAt: string;
  readonly recordedAt: string; readonly tenantId: string; readonly actorId: string; readonly correlationId: string;
  readonly runtimeSnapshotId: string; readonly integrityHash: string;
}

export interface TurnLease {
  readonly sessionId: string; readonly turnId: string; readonly ownerId: string;
  /** Opaque monotonic value. Consumers must not coerce it to a JavaScript number. */
  readonly fencingToken: string; readonly expiresAt: string;
}

export interface TurnClaimCommand {
  readonly sessionId: string; readonly turnId: string; readonly ownerId: string;
  readonly idempotencyKey: string; readonly requestFingerprint: string;
  /** Permanently binds the conversation aggregate to one routed assistant profile. */
  readonly agentProfileId?: string;
  readonly leaseTtlMs: number; readonly startEvents: readonly EventDraft[];
}

export type TurnClaimResult =
  | { readonly kind: "acquired"; readonly lease: TurnLease; readonly seq: number }
  | { readonly kind: "completed"; readonly turnId: string; readonly seq: number }
  | { readonly kind: "in-progress"; readonly turnId: string; readonly retryAfterMs: number }
  | { readonly kind: "failed"; readonly turnId: string; readonly code: string };

/** Most events one bounded read may return: `loadRecent`, `loadSince` and the `loadContext` tail. */
export const MAX_SESSION_READ_EVENTS = 1_000;

export interface SessionReader {
  /** Optional for legacy/custom stores. Each page is scoped to the authenticated owner. */
  listSessions?(query: import("./session-directory.js").SessionDirectoryQuery, security: SecurityContext): Promise<readonly import("./session-directory.js").SessionDirectoryEntry[]>;
  load(sessionId: string, security: SecurityContext): Promise<readonly SessionEvent[]>;
  /** Newest bounded events in chronological order for delivery/history projections. */
  loadRecent(sessionId: string, limit: number, security: SecurityContext): Promise<readonly SessionEvent[]>;
  /** Latest checkpoint plus a newest bounded raw tail; core validates before applying coverage. */
  loadContext(sessionId: string, security: SecurityContext): Promise<SessionContextView>;
  /**
   * Events with `seq > afterSeq`, oldest first, at most `limit` (1 to MAX_SESSION_READ_EVENTS).
   *
   * How a view that already holds the session's tail catches up with what was written since,
   * without reading the tail again. A caller that receives exactly `limit` events cannot tell
   * whether more exist and reloads with `loadContext()` instead of paging: paging through a
   * long gap is the full read this method exists to avoid.
   */
  loadSince(sessionId: string, afterSeq: number, security: SecurityContext, limit: number): Promise<readonly SessionEvent[]>;
}

export interface SessionWriter {
  append(sessionId: string, expectedSeq: number, events: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number>;
  claimTurn(command: TurnClaimCommand, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<TurnClaimResult>;
  appendLeased(lease: TurnLease, expectedSeq: number, events: readonly EventDraft[], idempotencyKey: string, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number>;
  renewTurn(lease: TurnLease, ttlMs: number, security: SecurityContext): Promise<TurnLease>;
  finishTurn(lease: TurnLease, expectedSeq: number, terminal: EventDraft, context: { security: SecurityContext; runtime: RuntimeSnapshot }): Promise<number>;
}

/** Additive aggregate for adapters that provide both reader and writer capabilities. */
export interface SessionStore extends SessionReader, SessionWriter {}
