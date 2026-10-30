import type { JsonValue } from "../shared/json.js";

/** Who may read a stored result back: the tenant and session whose turn produced it, nobody else. */
export interface ToolResultScope {
  readonly tenantId: string;
  readonly sessionId: string;
}

/**
 * Where the runtime keeps the whole of a tool result it had to cut, so the model can read the rest.
 *
 * A result over budget used to be cut and the cut part thrown away: the model was told "56 of 113
 * were read" and had no way to read the other 57. Keeping the original under an id and letting the
 * model page through it is how other agent harnesses handle an oversized result.
 */
export interface ToolResultSpool {
  /** Stores a result and returns the id the model reads it back by. */
  put(scope: ToolResultScope, entry: { readonly toolId: string; readonly value: JsonValue }): string;
  /** The stored result, or `undefined` when the id is unknown, expired, or belongs to another scope. */
  get(scope: ToolResultScope, id: string): { readonly toolId: string; readonly value: JsonValue } | undefined;
  /** The ids still stored for this scope, newest last, so a refusal can name the one a mistyped id meant. */
  list?(scope: ToolResultScope): readonly { readonly id: string; readonly toolId: string }[];
}

/**
 * Why an id was not found, naming the stored ids closest to it. A model copies ids from memory and gets a character wrong;
 * told only to read the page again, it re-reads every page instead of fixing that one character.
 */
export function missingResultText(spool: ToolResultSpool, scope: ToolResultScope, id: string): string {
  const stored = spool.list?.(scope) ?? [];
  const near = stored.map((entry) => ({ ...entry, distance: editDistance(entry.id, id) })).filter((entry) => entry.distance <= 3)
    .sort((a, b) => a.distance - b.distance).slice(0, 3);
  const said = `Result ${JSON.stringify(id.slice(0, 40))} is not stored.`;
  return near.length
    ? `${said} Did you mean ${near.map((entry) => `${entry.id} (${entry.toolId})`).join(", ")}? Use the id exactly as it was returned.`
    : `${said} It expired or the service restarted: read the source again and use the new resultId.`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}
