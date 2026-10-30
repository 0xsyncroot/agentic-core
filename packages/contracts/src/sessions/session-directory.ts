import type { JsonValue } from "../shared/json.js";

/** Stable newest-created ordering; updating an old conversation never moves a cursor boundary. */
export interface SessionDirectoryCursor { readonly createdAt: string; readonly sessionId: string }
export interface SessionDirectoryQuery {
  readonly limit: number;
  readonly before?: SessionDirectoryCursor;
  readonly agentProfileId?: string;
}
export interface SessionDirectoryEntry extends SessionDirectoryCursor {
  readonly firstInput?: JsonValue;
}
