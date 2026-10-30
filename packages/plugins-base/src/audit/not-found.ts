import type { JsonValue, SessionEvent } from "@0xsyncroot/contracts";

/** A search of the task that came back empty: the tool, and what it was asked to search for (its result's `searched`). */
export interface NothingFound {
  readonly tool: string;
  readonly searched?: JsonValue;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};

/**
 * The task's searches that came back empty, for each tool whose every succeeded result in the task carries `notFound: true`
 * (the result convention in `@0xsyncroot/contracts`): the source was searched and holds nothing above its threshold for this
 * request. A tool that returned items even once has nothing settled by this fact: an answer that says "nothing there" while
 * a search did return something goes through the normal judgments. A structured fact of the tool, never the answer's prose:
 * without it an honest "nothing in the documents answers this" after a real search goes back as not delivered, as a
 * hand-back, and for citations it has nothing to cite.
 */
export function nothingFound(events: readonly SessionEvent[], task: ReadonlySet<string>): readonly NothingFound[] {
  const succeeded = events.filter((event) => event.type === "tool/result" && task.has(event.turnId ?? "")).map((event) => record(event.payload))
    .filter((payload) => payload.dispatched === true && payload.state === "succeeded");
  const found = new Set(succeeded.filter((payload) => record(payload.result).notFound !== true).map((payload) => String(payload.toolId ?? "")));
  return succeeded.flatMap((payload) => {
    const tool = String(payload.toolId ?? ""), result = record(payload.result);
    if (result.notFound !== true || found.has(tool)) return [];
    return [{ tool, ...(result.searched !== undefined ? { searched: result.searched as JsonValue } : {}) }];
  });
}
