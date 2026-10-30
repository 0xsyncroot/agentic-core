import { AgenticError } from "../errors/agentic-error.js";
import type { JsonValue } from "../shared/json.js";

export type TurnAttachmentSource = "picker" | "paste" | "drop" | "capture" | "host";

export const TURN_ATTACHMENT_SOURCES: readonly TurnAttachmentSource[] =
  Object.freeze(["picker", "paste", "drop", "capture", "host"] as const);

/**
 * A file the user attached to a turn, carried as a reference the product resolves.
 *
 * The runtime never reads the bytes. `id` is an opaque handle minted by whatever stored the file —
 * a document id in the product's own system — and a tool owned by that system is what turns it into
 * content. Core journals the manifest and shows it to the model, so a document never lands in the
 * context window by accident and the agentic core needs no storage port to accept one.
 */
export interface TurnAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly source?: TurnAttachmentSource;
}

export const TURN_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 20,
  maxIdChars: 256,
  maxNameChars: 255,
  maxMediaTypeChars: 128,
  maxByteSize: 536_870_912,
});

const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;
const SOURCE_SET = new Set<string>(TURN_ATTACHMENT_SOURCES);

function invalid(detail: string): never {
  throw new AgenticError("validation", `Turn attachment is invalid: ${detail}`);
}

// Beyond C0/DEL: Unicode line/paragraph separators (U+2028/U+2029) render as a real line break in
// most renderers just like "\n" does, and the explicit bidi formatting characters (embeddings,
// overrides, isolates, and the plain marks) can make text display in an order that does not match
// its underlying bytes. Either lets a single attachment name be crafted to look like more than one
// manifest line, or like a different one, once it reaches the model's prompt as plain text.
const LINE_BREAK_LIKE = new Set([0x2028, 0x2029]);
function isBidiFormattingCharacter(code: number): boolean {
  return code === 0x061c || code === 0x200e || code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}
function hasDisallowedCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 || code === 0x7f || LINE_BREAK_LIKE.has(code) || isBidiFormattingCharacter(code)) return true;
  }
  return false;
}

function text(value: unknown, field: string, maxChars: number, { trim = true }: { readonly trim?: boolean } = {}): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (!normalized) invalid(`${field} is required`);
  if (!trim && normalized !== normalized.trim()) invalid(`${field} must not have leading or trailing whitespace`);
  if (normalized.length > maxChars) invalid(`${field} exceeds ${maxChars} characters`);
  if (hasDisallowedCharacter(normalized)) invalid(`${field} contains control characters`);
  return normalized;
}

/** Validates and freezes an attachment manifest from any boundary: HTTP body, journal row, test. */
export function parseTurnAttachments(value: unknown): readonly TurnAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalid("attachments must be an array");
  if (value.length === 0) return undefined;
  if (value.length > TURN_ATTACHMENT_LIMITS.maxCount) invalid(`at most ${TURN_ATTACHMENT_LIMITS.maxCount} attachments are allowed`);
  const ids = new Set<string>();
  const parsed = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("each attachment must be an object");
    const candidate = entry as Record<string, unknown>;
    for (const key of Object.keys(candidate)) {
      if (!["id", "name", "mediaType", "byteSize", "source"].includes(key)) invalid(`unsupported field ${key}`);
    }
    // An opaque handle is compared and looked up byte-for-byte by whatever minted it; silently
    // trimming it could turn a caller's mistake into a lookup for a document that does not exist.
    const id = text(candidate.id, "id", TURN_ATTACHMENT_LIMITS.maxIdChars, { trim: false });
    if (ids.has(id)) invalid("attachment ids must be unique");
    ids.add(id);
    const mediaType = text(candidate.mediaType, "mediaType", TURN_ATTACHMENT_LIMITS.maxMediaTypeChars);
    if (!MEDIA_TYPE_PATTERN.test(mediaType)) invalid("mediaType must be a media type");
    const byteSize = candidate.byteSize;
    if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 0 || byteSize > TURN_ATTACHMENT_LIMITS.maxByteSize) {
      invalid("byteSize must be an integer within the allowed size");
    }
    if (candidate.source !== undefined && (typeof candidate.source !== "string" || !SOURCE_SET.has(candidate.source))) {
      invalid("source is not a recognized attachment source");
    }
    return Object.freeze({
      id,
      name: text(candidate.name, "name", TURN_ATTACHMENT_LIMITS.maxNameChars),
      mediaType,
      byteSize,
      ...(candidate.source === undefined ? {} : { source: candidate.source as TurnAttachmentSource }),
    });
  });
  return Object.freeze(parsed);
}

/** The journal/JSON form of a manifest. Attachments are plain data; this only narrows the type. */
export function turnAttachmentsPayload(attachments: readonly TurnAttachment[]): JsonValue {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    byteSize: attachment.byteSize,
    ...(attachment.source ? { source: attachment.source } : {}),
  }));
}

/**
 * The files a task is about, by id, in the order they were attached: those its own messages attached, and those an
 * earlier request attached that a call of the task named in its journaled arguments — the task reached for them.
 *
 * Only these make a task's blocker when no reader can read them. A file the conversation merely holds does not, or every
 * later, unrelated request would have its blocked answer proven by a file it never touched. Whether a request is about
 * an earlier file is not in the journal until the task names it; the model is told about every file all the same.
 */
export function taskAttachmentIds(
  events: readonly { readonly type: string; readonly turnId?: string; readonly payload: unknown }[], taskTurnIds: Iterable<string>,
): readonly string[] {
  const task = new Set(taskTurnIds);
  const record = (value: unknown): Readonly<Record<string, unknown>> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
  const named = events.filter((event) => event.type === "tool/intent" && task.has(event.turnId ?? "")).map((event) => {
    const args = record(event.payload).arguments;
    return typeof args === "string" ? args : JSON.stringify(args ?? null);
  });
  const ids: string[] = [];
  for (const event of events) {
    const attachments = event.type === "user/input" ? record(event.payload).attachments : undefined;
    if (!Array.isArray(attachments)) continue;
    for (const entry of attachments) {
      const id = record(entry).id;
      if (typeof id !== "string" || !id || ids.includes(id)) continue;
      if (task.has(event.turnId ?? "") || named.some((text) => text.includes(id))) ids.push(id);
    }
  }
  return Object.freeze(ids);
}
