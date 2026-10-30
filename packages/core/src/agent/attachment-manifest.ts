import { taskAttachmentIds, TURN_ATTACHMENT_LIMITS, TURN_ATTACHMENT_SOURCES, type CapabilityUnavailableReason, type SessionEvent, type UnavailableCapabilities } from "@0xsyncroot/contracts";
import type { AttachmentReader } from "../tools/contextual-tool-resolver.js";

const KNOWN_SOURCES = new Set<string>(TURN_ATTACHMENT_SOURCES);

/** The fields of a `TurnAttachment` the journal actually needs to describe a file to the model. */
export interface AttachmentManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly source?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the manifest back off a `user/input` event's JSON payload.
 *
 * The payload was written by `turnAttachmentsPayload` and already passed `parseTurnAttachments` at
 * the journal boundary, so this is a structural narrowing rather than a second validation pass: it
 * never throws, so a future journal format this reader does not yet understand degrades to "no
 * manifest" instead of breaking conversation projection or compaction for the whole turn.
 */
export function attachmentManifestFromPayload(value: unknown): readonly AttachmentManifestEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AttachmentManifestEntry[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) continue;
    const { id, name, mediaType, byteSize, source } = candidate;
    if (typeof id !== "string" || typeof name !== "string" || typeof mediaType !== "string" || typeof byteSize !== "number") continue;
    // Required fields missing or mistyped drop the whole entry (nothing sane to show); an
    // optional field with an unrecognized value just drops that field, the same asymmetry
    // `parseTurnAttachments` itself has between a required and an optional field.
    entries.push({ id, name, mediaType, byteSize, ...(typeof source === "string" && KNOWN_SOURCES.has(source) ? { source } : {}) });
  }
  return entries;
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A human-readable size such as `48 KB` or `1.2 MB`, never fractional below one KB. */
function humanByteSize(byteSize: number): string {
  if (!Number.isFinite(byteSize) || byteSize < 1024) return `${Math.max(0, Math.round(byteSize))} B`;
  let value = byteSize / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) { value /= 1024; unitIndex += 1; }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * The deterministic, English manifest for an attached turn's own, separately marked message.
 *
 * Bounded and ordered the same way every time (input order, capped at the same limit the turn was
 * accepted under) so the message never depends on the compaction pass or provider that reads it.
 * Every id is shown as `id=...` so the model reads it as an opaque handle, never as something it
 * could invent or reuse for a different attachment. Names are external text (product- or
 * user-supplied) and must not be trusted as instructions — the caller marks the message that
 * carries this text accordingly, the same way it marks `application/context`.
 *
 * `readability` is what the conversation's files are this turn (`attachmentsReadability`). Told to "use
 * the tools that read them" while no reader can, a model goes looking for those tools; told the fact, it
 * has nothing to call and one thing to say (docs/incidents/2026-10-14-core-reader-down.md). A file a
 * reader already read is not "unreadable": its result is in the conversation, and calling it unreadable
 * makes the model drop it — but only that file: told "read earlier" of every file once one had been
 * read, a model would answer from rows it never saw.
 * Why is the product's to say, in its notice: a source id or a permission name here was text a model
 * could repeat into the chat.
 */
export function attachmentManifestText(attachments: readonly AttachmentManifestEntry[], readability?: AttachmentsReadability): string | undefined {
  if (attachments.length === 0) return undefined;
  const bounded = attachments.slice(0, TURN_ATTACHMENT_LIMITS.maxCount);
  const line = (attachment: AttachmentManifestEntry) =>
    `- ${attachment.name} (${attachment.mediaType}, ${humanByteSize(attachment.byteSize)}) id=${attachment.id}`;
  if (!readability) return ["Attached files (references, not contents — use the tools that read them):", ...bounded.map(line)].join("\n");
  const read = bounded.filter((attachment) => readability.readEarlier.has(attachment.id));
  const unread = bounded.filter((attachment) => !readability.readEarlier.has(attachment.id));
  if (read.length === 0) {
    return ["Attached files (references, not contents). No tool can read these files in this turn: do not call document tools for them,"
      + " and tell the user plainly that the files cannot be read right now.", ...unread.map(line)].join("\n");
  }
  if (unread.length === 0) {
    return ["Attached files (references, not contents). They were read earlier in this conversation and cannot be read again in this turn:"
      + " use the results already read, and do not call document tools for them again.", ...read.map(line)].join("\n");
  }
  return ["Attached files (references, not contents). No tool can read attached files in this turn: do not call document tools for them.",
    "Read earlier in this conversation — use the results already read:", ...read.map(line),
    "Never read — their contents are unknown; tell the user plainly that these cannot be read right now:", ...unread.map(line)].join("\n");
}

/**
 * The conversation's files when no tool can read attached files this turn: which of them a reader read earlier, and — when
 * a file the task is about was never read — why it cannot be read now.
 */
export interface AttachmentsReadability {
  readonly readEarlier: ReadonlySet<string>;
  readonly unavailable?: CapabilityUnavailableReason;
  /** Every file in the view no reader has read (`UnavailableCapabilities.unreadFiles`). */
  readonly unread: readonly { readonly id: string; readonly name: string }[];
}

/**
 * No tool can read attached files in this turn, from what discovery established: every source that
 * reads them is unavailable or has all its tools withheld. False when a reader can, and when no source
 * declares that it reads attachments (then the runtime knows nothing either way, and the manifest says
 * what it always said).
 */
export function attachmentsUnreadable(readers: readonly AttachmentReader[]): boolean {
  return readers.length > 0 && readers.every((reader) => reader.state !== "available");
}

/**
 * What the conversation's attachments are this turn, file by file: for their manifests, every file the view holds; for
 * `UnavailableCapabilities.attachments`, the files the task is about (`taskAttachmentIds`).
 *
 * The manifests tell the model about every file: one no reader ever read is as unreadable in the next request as in the
 * one that attached it, and a follow-up asking to read it again must hear that, not go looking for readers. The fact is
 * the task's only: a file an earlier request attached blocks this one once a call of the task names it — an unrelated
 * later request is not blocked by it.
 * Undefined when a reader can read, when no source declares it reads attachments, or when the view holds none. Otherwise a
 * file counts as read earlier when a reader's call succeeded with that file's id in its arguments (in its result only
 * when its arguments were not journaled) — the reader's tool named by the call's origin, or by the `${sourceId}_` prefix
 * connector tools carry. Why the task's unread files cannot be read now is `withheld` only when every reader is withheld.
 */
export function attachmentsReadability(readers: readonly AttachmentReader[], events: readonly SessionEvent[], taskTurnIds: readonly string[]):
  AttachmentsReadability | undefined {
  if (!attachmentsUnreadable(readers)) return undefined;
  const payload = (event: SessionEvent) => event.payload as Record<string, unknown>;
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "user/input") continue;
    for (const file of attachmentManifestFromPayload(payload(event).attachments)) if (!names.has(file.id)) names.set(file.id, file.name);
  }
  const files = [...names.keys()];
  if (files.length === 0) return undefined;
  const sources = new Set(readers.map((reader) => reader.sourceId));
  const intents = new Map(events.filter((event) => event.type === "tool/intent").map((event) => [payload(event).callId, payload(event)]));
  const reads = events.filter((event) => {
    const result = payload(event);
    const origin = (intents.get(result.callId)?.origin as Record<string, unknown> | undefined)?.sourceId;
    return event.type === "tool/result" && result.dispatched === true && result.state === "succeeded" &&
      (sources.has(String(origin)) || [...sources].some((sourceId) => String(result.toolId).startsWith(`${sourceId}_`)));
  }).map((event) => {
    const args = intents.get(payload(event).callId)?.arguments;
    return typeof args === "string" ? args : JSON.stringify(payload(event).result ?? null);
  });
  const readEarlier = new Set(files.filter((id) => reads.some((text) => text.includes(id))));
  const blocked = taskAttachmentIds(events, taskTurnIds).some((id) => !readEarlier.has(id));
  const unread = Object.freeze(files.filter((id) => !readEarlier.has(id)).map((id) => Object.freeze({ id, name: names.get(id)! })));
  return Object.freeze({ readEarlier, unread,
    ...(blocked ? { unavailable: readers.every((reader) => reader.state === "withheld") ? "withheld" as const : "source-unavailable" as const } : {}) });
}

/** What discovery found missing, with what the conversation's files are this turn: the task's blocker, and every file unread. */
export function withAttachmentFacts(unavailable: UnavailableCapabilities | undefined, readability: AttachmentsReadability | undefined): UnavailableCapabilities | undefined {
  if (!readability || (!readability.unavailable && readability.unread.length === 0)) return unavailable;
  return Object.freeze({ sources: [], withheldTools: [], ...unavailable, ...(readability.unavailable ? { attachments: readability.unavailable } : {}),
    ...(readability.unread.length ? { unreadFiles: readability.unread } : {}) });
}

/**
 * A short compaction-summary suffix, e.g. ` [+2 files: doc_1, doc_2]`, or "" when nothing was
 * attached.
 *
 * The ids are kept, not just the count: an id is the only thing a tool that reads a file accepts,
 * so a count-only summary ("+2 files") makes every attachment unnameable once the turn that listed
 * them compacts away — "now read the second one" becomes unanswerable. At the contract's own limits
 * (20 attachments, 256-character ids) this is a few KB at most, against a context in the hundreds
 * of thousands of characters.
 */
export function attachmentCompactionSuffix(attachments: readonly AttachmentManifestEntry[]): string {
  if (attachments.length === 0) return "";
  const ids = attachments.map((attachment) => attachment.id).join(", ");
  return ` [+${attachments.length} file${attachments.length === 1 ? "" : "s"}: ${ids}]`;
}
