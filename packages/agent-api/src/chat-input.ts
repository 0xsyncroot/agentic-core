import type { IncomingMessage } from "node:http";
import { AgenticError, parseTurnAttachments, type JsonValue, type TurnAttachment } from "@0xsyncroot/contracts";
import { readJsonBody } from "./request-body.js";

export const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const REQUEST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const AGENT_PROFILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface ChatBody {
  readonly content?: unknown;
  readonly sessionId?: unknown;
  readonly requestId?: unknown;
  readonly attachments?: unknown;
  readonly agentProfileId?: unknown;
  readonly agentContext?: unknown;
}
interface CancelBody { readonly sessionId?: unknown; readonly requestId?: unknown }
interface InterjectBody { readonly sessionId?: unknown; readonly requestId?: unknown; readonly content?: unknown }

/**
 * Longest sentence a user may add to a turn already running.
 *
 * Generous for a correction and far short of a document: an interjection is the user saying which
 * sheet, which unit, which period — anything longer is a new request, and starting a turn is where
 * a request that size belongs, with its own attachments and its own answer.
 */
export const MAX_INTERJECTION_CHARS = 4_000;

export interface ValidChatInput {
  readonly content: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly attachments: readonly TurnAttachment[];
  readonly agentProfileId?: string;
  readonly agentContext?: JsonValue;
}

function requireJson(request: IncomingMessage): void {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new AgenticError("validation", "Content-Type must be application/json");
  }
}

// The widget capture flow distinguishes where the shot was taken; the shared contract only knows
// one generic "capture" source, so both collapse into it here rather than teaching core a UI detail.
const CAPTURE_SOURCES = new Set(["capture-chat", "capture-screen"]);

/** Handle fields a host upload may answer with, in the order a client is most likely to use them. */
const HANDLE_FIELDS = ["documentId", "fileId", "id", "handle", "reference"] as const;

/**
 * The handle a tool can actually resolve, taken from what the host's upload returned.
 *
 * The widget mints `attachment.id` in the browser before anything is stored, so that id means
 * nothing to a tool. The host's own identifier arrives in `data`, whatever the deployment's
 * `uploadAttachment` hook answered with. Prefer it; fall back to the client id only when no upload
 * happened, in which case no tool can resolve it either — and that is the honest outcome, because
 * nothing was stored. The handle stays untrusted: whatever resolves it authorizes the caller first.
 */
function attachmentHandle(data: unknown, clientId: unknown): unknown {
  return hostAttachmentHandle(data) ?? clientId;
}

/** The handle a host's own upload answered with, when it made one. */
export function hostAttachmentHandle(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const field of HANDLE_FIELDS) {
      const candidate = record[field];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  return undefined;
}

/**
 * The chat transport's own attachment shape (`type`/`size`, a widget UI concern) mapped onto the
 * platform's `TurnAttachment` (`mediaType`/`byteSize`). Non-object entries pass through unchanged
 * so `parseTurnAttachments` reports the same "each attachment must be an object" it always has.
 */
function turnAttachmentCandidate(value: unknown, stored: ReadonlyMap<string, string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { id, name, type, size, source, data } = value as Record<string, unknown>;
  const mappedSource = typeof source === "string" && CAPTURE_SOURCES.has(source) ? "capture" : source;
  return {
    // A file this service stored itself is known by the handle its own store gave it.
    id: (typeof id === "string" ? stored.get(id) : undefined) ?? attachmentHandle(data, id),
    name, mediaType: type, byteSize: size,
    ...(mappedSource !== undefined ? { source: mappedSource } : {}),
  };
}

/** Validates the manifest against the shared contract; a bad entry throws the same AgenticError("validation", ...) every other bad field in this body throws. */
export function chatAttachments(value: unknown, stored: ReadonlyMap<string, string> = new Map()): readonly TurnAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AgenticError("validation", "attachments must be an array");
  // The same file attached twice is one stored object with one handle: listed once, not refused
  // as a duplicate id — the user attached a file, and has no way to know two of them are the same.
  const storedHandles = new Set<unknown>();
  const candidates = value.map((entry) => turnAttachmentCandidate(entry, stored)).filter((candidate, index) => {
    const clientId = (value[index] as { id?: unknown } | null)?.id;
    if (typeof clientId !== "string" || !stored.has(clientId)) return true;
    const handle = (candidate as { id?: unknown }).id;
    if (storedHandles.has(handle)) return false;
    storedHandles.add(handle);
    return true;
  });
  return parseTurnAttachments(candidates) ?? [];
}

function agentContext(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticError("validation", "agentContext must be an object");
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new AgenticError("validation", "agentContext must be JSON serializable"); }
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new AgenticError("validation", "agentContext exceeds 32768 bytes");
  }
  const snapshot = JSON.parse(serialized) as JsonValue;
  const pending: Array<{ readonly value: object; readonly depth: number }> = [{ value: snapshot as object, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (current.depth > 16 || nodes > 512 || Object.keys(current.value).length > 128) {
      throw new AgenticError("validation", "agentContext exceeds structural limits");
    }
    for (const child of Object.values(current.value)) {
      if (child && typeof child === "object") pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return snapshot;
}

export interface ChatInputOptions {
  /**
   * The content a turn carries when the user sent only attachments and no text. Product copy,
   * not delivery logic — this package ships only the English default; a product supplies its own
   * (e.g. Vietnamese) sentence here rather than this file hardcoding one.
   */
  readonly attachmentOnlyContent?: string;
}

const DEFAULT_ATTACHMENT_ONLY_CONTENT = "Please process the attached file(s).";

export async function chatInput(request: IncomingMessage, options: ChatInputOptions = {}): Promise<ValidChatInput> {
  return validChatInput(await chatBody(request), options);
}

/** A JSON turn's body, not yet validated. */
export async function chatBody(request: IncomingMessage): Promise<ChatBody> {
  requireJson(request);
  return readJsonBody<ChatBody>(request);
}

/**
 * Validates a turn's body however it arrived. `stored` maps a client attachment id to the handle
 * this service's own store gave the file it was sent with (see inline-attachments.ts).
 */
export function validChatInput(input: ChatBody, options: ChatInputOptions = {}, stored: ReadonlyMap<string, string> = new Map()): ValidChatInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgenticError("validation", "Request body must be a JSON object");
  const attachments = chatAttachments(input.attachments, stored);
  if (typeof input.content !== "string" || (!input.content.trim() && attachments.length === 0)) throw new AgenticError("validation", "content is required");
  if (typeof input.sessionId !== "string" || !SESSION_PATTERN.test(input.sessionId)) throw new AgenticError("validation", "sessionId is invalid");
  if (typeof input.requestId !== "string" || !REQUEST_PATTERN.test(input.requestId)) throw new AgenticError("validation", "requestId is invalid");
  if (input.agentProfileId !== undefined &&
      (typeof input.agentProfileId !== "string" || !AGENT_PROFILE_PATTERN.test(input.agentProfileId))) {
    throw new AgenticError("validation", "agentProfileId is invalid");
  }
  const safeAgentContext = agentContext(input.agentContext);
  return {
    // The attachment manifest itself is core's job (packages/core turns the accepted turn's
    // attachments into a deterministic, journaled block); this only needs a non-empty message.
    content: input.content.trim() || options.attachmentOnlyContent || DEFAULT_ATTACHMENT_ONLY_CONTENT,
    sessionId: input.sessionId,
    requestId: input.requestId,
    attachments,
    ...(typeof input.agentProfileId === "string" ? { agentProfileId: input.agentProfileId } : {}),
    ...(safeAgentContext !== undefined ? { agentContext: safeAgentContext } : {}),
  };
}

/**
 * The body of a mid-turn addition: which running turn, and what the user said.
 *
 * Bounded here rather than deeper in, because this is the last place a refusal still reaches the
 * person who typed it. Past this edge the words travel to a turn that may be on another node, and
 * "too long" becomes a failure nobody sees.
 */
export async function interjectInput(request: IncomingMessage): Promise<{ sessionId: string; requestId: string; content: string }> {
  requireJson(request);
  const input = await readJsonBody<InterjectBody>(request);
  if (typeof input.sessionId !== "string" || !SESSION_PATTERN.test(input.sessionId)) throw new AgenticError("validation", "sessionId is invalid");
  if (typeof input.requestId !== "string" || !REQUEST_PATTERN.test(input.requestId)) throw new AgenticError("validation", "requestId is invalid");
  if (typeof input.content !== "string") throw new AgenticError("validation", "content is invalid");
  const content = input.content.replace(/\r\n/gu, "\n").trim();
  if (!content) throw new AgenticError("validation", "content must not be empty");
  if (content.length > MAX_INTERJECTION_CHARS) {
    throw new AgenticError("validation", `content exceeds ${MAX_INTERJECTION_CHARS} characters; send it as a new message instead`);
  }
  return { sessionId: input.sessionId, requestId: input.requestId, content };
}

export async function cancelInput(request: IncomingMessage): Promise<{ sessionId: string; requestId: string }> {
  requireJson(request);
  const input = await readJsonBody<CancelBody>(request);
  if (typeof input.sessionId !== "string" || !SESSION_PATTERN.test(input.sessionId)) throw new AgenticError("validation", "sessionId is invalid");
  if (typeof input.requestId !== "string" || !REQUEST_PATTERN.test(input.requestId)) throw new AgenticError("validation", "requestId is invalid");
  return { sessionId: input.sessionId, requestId: input.requestId };
}
