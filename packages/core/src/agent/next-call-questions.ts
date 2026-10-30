import type { JsonValue, JudgmentAnswer, JudgmentQuestion, SessionEvent, ToolNextCallReads } from "@0xsyncroot/contracts";
import { attachmentManifestFromPayload } from "./attachment-manifest.js";

/** The judge must be at least this sure of each condition the read needs (`wanted`)... */
export const NEXT_CALL_SURE = 0.9;
/** ...and at most this sure of each condition that makes it needless. */
export const NEXT_CALL_UNLIKELY = 0.1;

/** How much of the result that named the call the judge reads, and of the latest requests. */
const RESULT_CHARS = 6_000;
const REQUEST_CHARS = 2_000;
/** The latest requests the judge reads: the turn's own and the two before it. */
const RECENT_REQUESTS = 3;

/** One narrow question about a follow-up read, put to the judge in its own call with a state built for it alone. */
export interface NextCallAsk {
  readonly id: string;
  readonly question: JudgmentQuestion;
  readonly state: JsonValue;
  /** True: the read needs the judge to say yes (p ≥ `NEXT_CALL_SURE`). False: it needs a no (p ≤ `NEXT_CALL_UNLIKELY`). */
  readonly wanted: boolean;
}

/** What the session says beside the candidate: its latest requests, its attached files, and where else its data lives. */
export interface NextCallContext {
  /** The latest requests joined, oldest first, cut to their last characters. */
  readonly request: string;
  readonly messages: readonly string[];
  readonly attachments: readonly { readonly id: string; readonly name: string }[];
  /** The composition's other places the data lives, by name, each described in one sentence. */
  readonly sources: Readonly<Record<string, string>>;
}

const noul = (instructions: string, yes: string, no: string): JudgmentQuestion => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

export const NEXT_CALL_NEEDS_FILE = noul(
  "Does the task in `request` name an attached file (the file, the sheet, or what the user sent) as the source of the data it works on?",
  "The task says to read, compare, check, list or enter data from the attached file, the file the user sent, or a sheet of it.",
  "The task refers only to the software, the screen, the month's sheet in the software, a regulation, or figures it gives itself; it does not point at an attached file as its source.",
);
export const NEXT_CALL_FILE_IS_TARGET = noul(
  "Of the files in `attachments`, is `target` the file the task in `request` is about?",
  "The task names or describes this file (by its month, kind or sender), or it is the only attached file that holds what the task needs.",
  "The task names or describes another file (another month, another kind such as a decision, another sender), or no attached file is what it asks about.",
);
/** Asked in the words of the source's own parts (`reads.unit`): "sheet" for a workbook. */
export const nextCallPartIsTarget = (unit: string): JudgmentQuestion => noul(
  `Of the ${unit}s in \`source.${unit}s\`, is \`target.${unit}\` the ${unit} the task in \`request\` asks to read?`,
  `The task is about the table in this ${unit}: it names it, describes it, or this is the ${unit} that holds what the task needs.`,
  `The task names or describes another ${unit} of the source, or only another ${unit} holds what it asks.`,
);
export const NEXT_CALL_PREVIEW_ENOUGH = noul(
  "Can the task in `request` be completed from `readSoFar.result` as it is, without reading the rest of the table (`readSoFar.shown.of` rows, of which `readSoFar.shown.rows` were read)?",
  "The task asks only whether the file opens, what it is, which sheets or columns it has, how many rows it has, or a value, note or person that the rows already read show.",
  "The task needs rows beyond those read: a reconciliation or comparison of the whole table, a total or count over all rows, a full list, a person or section not shown.",
);
export const NEXT_CALL_USER_STOPPED = noul(
  "Does the latest message in `messages` stop, pause or set aside the task the earlier messages asked for?",
  "The user says not to continue, asks to wait, postpones, closes the task with thanks, asks a different question instead, or says the attached file is wrong.",
  "The user asks to continue or finish the task, asks for more of it, asks about its progress, or `messages` holds one message only.",
);

const payloadOf = (event: SessionEvent) => event.payload as Record<string, unknown>;
/** A judge state built here from JSON data alone (journal payloads and the contract's `reads`). */
const asState = (state: Readonly<Record<string, unknown>>): JsonValue => state as unknown as JsonValue;

/** The session's latest requests and attached files, from its `user/input` events alone, with the composition's other sources. */
export function nextCallContext(events: readonly SessionEvent[], sources: Readonly<Record<string, string>>): NextCallContext {
  const inputs = events.filter((event) => event.type === "user/input");
  const recent = inputs.map((event) => String(payloadOf(event).content ?? "")).slice(-RECENT_REQUESTS);
  const attachments = new Map<string, string>();
  for (const event of inputs) for (const file of attachmentManifestFromPayload(payloadOf(event).attachments)) if (!attachments.has(file.id)) attachments.set(file.id, file.name);
  return {
    request: recent.join("\n").slice(-REQUEST_CHARS), messages: recent.map((text) => text.slice(-REQUEST_CHARS)),
    attachments: [...attachments].map(([id, name]) => ({ id, name })), sources,
  };
}

/**
 * The five questions a follow-up read is put to, each with only what it needs, the request first: does the task work on an
 * attached file; is this the file; is this part of it the one the task reads (in the source's own word for a part); does
 * the result that named the call already settle the task; did the latest message set the task aside. The result is read
 * whole up to `RESULT_CHARS` characters of JSON, else as that much of its JSON.
 */
export function nextCallAsks(reads: ToolNextCallReads, result: JsonValue | undefined, context: NextCallContext): readonly NextCallAsk[] {
  const { request, messages, attachments } = context;
  const parts = `${reads.unit}s`;
  const others = Object.fromEntries(Object.entries(context.sources).filter(([name]) => name !== "attachedFiles"));
  const read = JSON.stringify(result ?? null);
  return [
    { id: "needsFile", wanted: true, question: NEXT_CALL_NEEDS_FILE, state: asState({ request, sources: { attachedFiles: attachments, ...others } }) },
    { id: "fileIsTarget", wanted: true, question: NEXT_CALL_FILE_IS_TARGET, state: asState({ request, attachments, target: { id: reads.source.id, name: reads.source.name,
      ...(reads.source.heading !== undefined ? { heading: reads.source.heading } : {}), [parts]: reads.catalog.map((part) => part.name) } }) },
    { id: `${reads.unit}IsTarget`, wanted: true, question: nextCallPartIsTarget(reads.unit),
      state: asState({ request, source: { name: reads.source.name, [parts]: reads.catalog }, target: { [reads.unit]: reads.target } }) },
    { id: "previewEnough", wanted: false, question: NEXT_CALL_PREVIEW_ENOUGH, state: asState({ request, readSoFar: {
      result: read.length <= RESULT_CHARS ? result ?? null : read.slice(0, RESULT_CHARS), ...(reads.shown ? { shown: reads.shown } : {}) } }) },
    { id: "userStopped", wanted: false, question: NEXT_CALL_USER_STOPPED, state: asState({ messages }) },
  ];
}

/** Whether the answer clears its question for the read; undefined when there is no such answer. */
export function nextCallClears(ask: NextCallAsk, answer: JudgmentAnswer | undefined): boolean | undefined {
  if (answer?.type !== "noul") return undefined;
  return ask.wanted ? answer.noul >= NEXT_CALL_SURE : answer.noul <= NEXT_CALL_UNLIKELY;
}

export const nextCallThreshold = (ask: NextCallAsk): number => ask.wanted ? NEXT_CALL_SURE : NEXT_CALL_UNLIKELY;

/** The read runs only when every question was answered and every answer clears it: one missing, failed or unsure answer stops it. */
export function nextCallRuns(asks: readonly NextCallAsk[], answers: readonly (JudgmentAnswer | undefined)[]): boolean {
  return asks.length > 0 && asks.length === answers.length && asks.every((ask, index) => nextCallClears(ask, answers[index]) === true);
}
