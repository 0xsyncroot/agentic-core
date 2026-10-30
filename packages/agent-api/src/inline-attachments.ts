import type { IncomingMessage } from "node:http";
import { AgenticError, type SecurityContext } from "@0xsyncroot/contracts";
import { chatBody, hostAttachmentHandle, validChatInput, type ChatBody, type ChatInputOptions, type ValidChatInput } from "./chat-input.js";

/**
 * Files sent with the turn that refers to them.
 *
 * A chat client holds the file the user attached; a tool needs it somewhere it can read. The file
 * therefore travels in the same request as the message — `multipart/form-data`: a `request` part
 * with the usual JSON body, and one `file:<attachment id>` part per file — and the product's own
 * {@link AttachmentStore} keeps it before the turn runs. Nothing about where it went crosses back:
 * the browser is never given an upload address or the stored file's handle, only the model's turn
 * is (as the attachment's id, which is what a tool opens it by).
 *
 * The alternative was a separate upload call the host page makes first. A page that was not told
 * to make it sent the browser's own placeholder id, no tool could open the file, and the assistant
 * asked the user for a file they had just attached.
 */

/** One file a turn was sent with, as this service received it. */
export interface InlineAttachmentFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
}

/** Where a product keeps a file sent with a turn. */
export interface AttachmentStore {
  /** The largest request read for one turn, files included. Default 26 MiB. */
  readonly maxRequestBytes?: number;
  /** Keeps the file for this caller and answers with the handle a tool opens it by. */
  store(file: InlineAttachmentFile, security: SecurityContext): Promise<string>;
}

const DEFAULT_MAX_REQUEST_BYTES = 26 * 1024 * 1024;
const FILE_PART_PREFIX = "file:";

function isMultipart(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data");
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new AgenticError("validation", `Request exceeds ${Math.floor(maxBytes / (1024 * 1024))} MiB`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readMultipartTurn(request: IncomingMessage, maxBytes: number): Promise<{ readonly body: ChatBody; readonly files: Map<string, InlineAttachmentFile> }> {
  const raw = await readBody(request, maxBytes);
  return parseMultipartTurn(raw, request.headers["content-type"] ?? "");
}

/** Same multipart contract for HTTP frameworks which own the bounded body read themselves. */
export async function parseMultipartTurn(raw: Buffer, contentType: string): Promise<{ readonly body: ChatBody; readonly files: Map<string, InlineAttachmentFile> }> {
  let form: FormData;
  // The platform's own multipart parser: a boundary, a quoted filename, a part with no length —
  // none of it is worth a second implementation.
  try { form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData(); }
  catch { throw new AgenticError("validation", "Request body must be valid multipart/form-data"); }
  const declared = form.get("request");
  if (typeof declared !== "string") throw new AgenticError("validation", "A multipart turn needs a `request` part holding the JSON body");
  let body: ChatBody;
  try { body = JSON.parse(declared) as ChatBody; }
  catch { throw new AgenticError("validation", "The `request` part must be valid JSON"); }
  const files = new Map<string, InlineAttachmentFile>();
  for (const [field, value] of form) {
    if (!field.startsWith(FILE_PART_PREFIX) || typeof value === "string") continue;
    if (files.has(field.slice(FILE_PART_PREFIX.length))) throw new AgenticError("validation", "Duplicate file part");
    files.set(field.slice(FILE_PART_PREFIX.length), {
      name: value.name, mediaType: value.type || "application/octet-stream", bytes: Buffer.from(await value.arrayBuffer()),
    });
  }
  return { body, files };
}

/** Store only after a product validated and authenticated the turn. */
export async function storeInlineAttachments(body: ChatBody, files: ReadonlyMap<string, InlineAttachmentFile>, store: AttachmentStore, security: SecurityContext, transport: "json" | "multipart"): Promise<ReadonlyMap<string, string>> {
  const declaredIds = new Map((Array.isArray(body.attachments) ? body.attachments : []).map((entry) => [entry.id, entry]));
  // Check all missing files before any write; a malformed multipart request leaves nothing behind.
  refuseFilelessAttachments(body, new Map([...files.keys()].map((id) => [id, id])), transport);
  const stored = new Map<string, string>();
  for (const [id, entry] of declaredIds) {
    const file = files.get(id);
    if (!file) continue;
    stored.set(id, await store.store({ ...file,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : file.name,
      mediaType: typeof entry.type === "string" && entry.type.trim() ? entry.type : file.mediaType,
    }, security));
  }
  return stored;
}

/**
 * A service that stores files refuses a turn naming a file it was not given.
 *
 * Such a turn carries an id only the browser knows. It used to run anyway: the model called the
 * document tool with that id, the tool answered "not found", and the assistant asked the user to
 * attach a file they had just attached — once per attempt, with nothing anywhere saying why. The
 * cause is always on the way in (a client build that sends no files, or a proxy that drops the
 * file part), so it is said at the door, in the log, where the person who can fix it reads.
 */
function refuseFilelessAttachments(body: ChatBody, stored: ReadonlyMap<string, string>, transport: "json" | "multipart"): void {
  const fileless = (Array.isArray(body.attachments) ? body.attachments : []).flatMap((entry) => {
    const declared = entry as { readonly id?: unknown; readonly name?: unknown; readonly data?: unknown } | null;
    if (typeof declared?.id !== "string" || stored.has(declared.id) || hostAttachmentHandle(declared.data) !== undefined) return [];
    return [typeof declared.name === "string" ? declared.name.slice(0, 120) : declared.id];
  });
  if (fileless.length === 0) return;
  const reason = transport === "json"
    ? "the client sent the turn as JSON with no file — it is not sending files with the turn (an outdated chat widget build?)"
    : "the request was multipart but carried no part for it — something between the client and this service dropped the file";
  console.warn(JSON.stringify({ event: "agent-api.attachment-without-file", attachments: fileless.length, transport, reason }));
  throw new AgenticError("validation", `${fileless.length} attached file(s) arrived without their content: ${reason}`);
}

/**
 * Reads one turn — JSON, or multipart with its files — and says who sent it.
 *
 * A multipart request is identified before a byte of its body is read: an anonymous caller does
 * not get tens of megabytes buffered on its say-so. A JSON one keeps the order it always had.
 * With no store configured the files are read and dropped, and the turn carries their names and
 * sizes only — the behaviour a product without a document tool has always had.
 */
export async function acceptChatTurn(
  request: IncomingMessage,
  options: ChatInputOptions,
  store: AttachmentStore | undefined,
  identify: () => Promise<SecurityContext>,
): Promise<{ readonly input: ValidChatInput; readonly security: SecurityContext }> {
  if (!isMultipart(request)) {
    const body = await chatBody(request);
    const input = validChatInput(body, options);
    if (store) refuseFilelessAttachments(body, new Map(), "json");
    return { input, security: await identify() };
  }
  const security = await identify();
  const { body, files } = await readMultipartTurn(request, store?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
  // Refused before anything is stored: a turn that will not run leaves no file behind.
  validChatInput(body, options);
  const stored = store ? await storeInlineAttachments(body, files, store, security, "multipart") : new Map<string, string>();
  return { input: validChatInput(body, options, stored), security };
}
