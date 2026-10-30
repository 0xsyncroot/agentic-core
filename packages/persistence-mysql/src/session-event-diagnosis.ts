import type { JsonValue } from "@0xsyncroot/contracts";
import { decodeEventRow, type EventRow } from "./event-row.js";
import { sessionEventHashFormat } from "./session-event-integrity.js";
import type { MySqlSessionWriteRepository } from "./session-write-repository.js";

const ID_COLUMNS = [["turn_id", "turnId"], ["step_id", "stepId"], ["request_id", "requestId"], ["call_id", "callId"], ["attempt_id", "attemptId"]] as const;
const MAX_REPORTED_PATHS = 10;

/** Which reading of a stored event reproduces its stored hash — the question a mismatch leaves open. */
export type EventDiagnosis =
  | { readonly result: "canonical" | "legacy-mysql" }
  | { readonly result: "empty-id"; readonly hash: "canonical" | "legacy-mysql"; readonly fields: readonly string[] }
  | { readonly result: "no-big-number-reviver"; readonly hash: "canonical" | "legacy-mysql" }
  | { readonly result: "mismatch"; readonly explanation: string; readonly nonIntegerNumbers: { readonly count: number; readonly paths: readonly string[] } };

/**
 * Tries each known way a stored hash can disagree with the row, and names the first that agrees.
 *
 * A SHA-256 cannot say which field differs, so the only honest answer is to rebuild the candidates
 * and compare: the row as the reader decodes it (canonical, then the original adapter's key order),
 * the row with its empty ids put back, and the payload decoded without mysql2's big-number
 * reviver. When none agrees the payload itself changed after it was hashed, and the report says how
 * many non-integer numbers it holds — the usual victim of a JSON column re-printing a double.
 * Reports ids, paths and counts; never a value of the document.
 *
 * `payloadText` is the column read as text (`CAST(payload AS CHAR)`), which no driver option can reshape.
 */
export async function diagnoseEventRow(row: EventRow, writes: MySqlSessionWriteRepository, payloadText: string): Promise<EventDiagnosis> {
  const body = await decodeEventRow(row, writes);
  const plain = sessionEventHashFormat(body, row.integrity_hash);
  if (plain !== "mismatch") return { result: plain };

  const absent = ID_COLUMNS.filter(([column]) => row[column] === null);
  for (const fields of subsets(absent.map(([, field]) => field))) {
    const restored = { ...body, ...Object.fromEntries(fields.map((field) => [field, ""])) };
    const hash = sessionEventHashFormat(restored, row.integrity_hash);
    if (fields.length > 0 && hash !== "mismatch") return { result: "empty-id", hash, fields };
  }

  const unrevived = await decodeEventRow({ ...row, payload: payloadText }, writes);
  const hash = sessionEventHashFormat(unrevived, row.integrity_hash);
  if (hash !== "mismatch") return { result: "no-big-number-reviver", hash };

  const paths = nonIntegerPaths(body.payload);
  return {
    result: "mismatch", explanation: `payload đã đổi; có ${paths.length} số không nguyên${paths.length > 0 ? " (nghi round-trip số thực)" : ""}`,
    nonIntegerNumbers: { count: paths.length, paths: paths.slice(0, MAX_REPORTED_PATHS) },
  };
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]]);
}

function nonIntegerPaths(value: JsonValue, path = "$"): string[] {
  if (typeof value === "number") return Number.isInteger(value) ? [] : [path];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => nonIntegerPaths(child, `${path}.${key}`));
}
