import type { TurnApplicationContext } from "./agent.js";
import type { TurnAttachment } from "./attachment.js";
import type { SecurityContext } from "../security/security-context.js";
import type { SessionEvent } from "../sessions/session.js";
import type { DataClassification, JsonValue } from "../shared/json.js";

export type TurnContextOperation = "run-turn" | "resume-approval" | "resume-interaction";

export interface TurnContextPreparationInput {
  readonly operation: TurnContextOperation;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentProfileId: string;
  readonly content: string;
  /** The manifest the user attached to this turn, when the operation is a new user message. */
  readonly attachments?: readonly TurnAttachment[];
  readonly applicationContext?: TurnApplicationContext;
  readonly security: SecurityContext;
  /**
   * The operation's bounded journal view: the newest raw tail of the session (at most
   * MAX_SESSION_READ_EVENTS, oldest first), extended with what this operation wrote. Older
   * events are not here. Providers return a bounded projection, never a transcript copy.
   */
  readonly events: readonly SessionEvent[];
  /**
   * The task this turn belongs to: the current turn plus the turns it continues (approval and
   * question resumes), within the view. A new user message starts a new task; a pause the
   * runtime closed because the user moved on never extends one.
   */
  readonly taskTurnIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface TurnContextContribution {
  readonly snapshot: JsonValue;
  /** Optional bounded model projection. The exact snapshot remains in the journal for recovery. */
  readonly modelSnapshot?: JsonValue;
  readonly classification: DataClassification;
}

/** Trusted direct-composition seam for product-owned durable task context. */
export interface TurnContextProvider {
  readonly id: string;
  readonly revision: string;
  prepare(input: TurnContextPreparationInput): Promise<TurnContextContribution | undefined>;
}

export function turnContextSnapshotEventType(providerId: string): string {
  return `extension/${providerId}/task-snapshot`;
}
