import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { AgenticError, type SecurityContext } from "@0xsyncroot/contracts";
import { RETIRED_S3_ENV_PREFIXES, S3ObjectStore, S3_ENV_PREFIX, normalizeKeyPrefix, s3Config } from "@0xsyncroot/adapter-s3";
import type { RuntimeConfig } from "./runtime-config.js";
import { executionFileTransfer, executionFileExists } from "./execution-attachments.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export interface StoredAttachment {
  readonly bytes: Buffer; readonly name: string; readonly mediaType: string; readonly tenant: string;
}
export interface DocumentObjectStore {
  stat(key: string): Promise<(Omit<StoredAttachment, "bytes"> & { readonly size: number }) | undefined>;
  get(key: string): Promise<Buffer>;
  put(key: string, attachment: StoredAttachment): Promise<void>;
}
export interface DocumentAttachmentSettings {
  readonly store?: DocumentObjectStore;
  readonly prefix: string;
  readonly unavailable?: string;
  readonly execution?: {
    upload(file: Omit<StoredAttachment, "tenant">, documentId: string, signal: AbortSignal): Promise<string>;
    exists(documentId: string, signal: AbortSignal): Promise<boolean>;
  };
}

/** Domain-separated, content-derived capability; another tenant cannot compute this handle. */
export function documentAttachmentId(secret: string, tenant: string, bytes: Buffer, context = "chat-attachment-id/v1"): string {
  const key = createHmac("sha256", secret).update(context).digest();
  const content = createHash("sha256").update(bytes).digest();
  return createHmac("sha256", key).update(tenant).update("\0").update(content).digest("hex").slice(0, 32);
}

class S3DocumentStore implements DocumentObjectStore {
  constructor(private readonly s3: S3ObjectStore) {}
  async stat(key: string) {
    const metadata = await this.s3.stat(key);
    if (!metadata) return undefined;
    return { name: decodeURIComponent(metadata.metadata.filename ?? "document"),
      tenant: decodeURIComponent(metadata.metadata.tenant ?? ""),
      mediaType: metadata.contentType ?? "application/octet-stream", size: metadata.size };
  }
  get(key: string): Promise<Buffer> { return this.s3.get(key, MAX_ATTACHMENT_BYTES); }
  async put(key: string, attachment: StoredAttachment): Promise<void> {
    await this.s3.put(key, attachment.bytes, {
      contentType: attachment.mediaType,
      metadata: { filename: encodeURIComponent(attachment.name), tenant: encodeURIComponent(attachment.tenant) },
    });
  }
}

/**
 * Development-only archive in a local folder, for running without object storage: `<dir>/<key>` plus
 * `<key>.meta.json` ({ name, mediaType, tenant }) — the layout the document reader reads through
 * `DOCUMENT_SOURCE_DIR`, so both sides use one folder and no bytes travel between them.
 */
class FileSystemDocumentStore implements DocumentObjectStore {
  constructor(private readonly root: string) {}
  #path(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(resolve(this.root) + sep)) throw new AgenticError("validation", "Attachment key escapes the attachment folder");
    return path;
  }
  async stat(key: string) {
    const path = this.#path(key);
    try {
      const meta = JSON.parse(await readFile(`${path}.meta.json`, "utf8")) as { name?: unknown; mediaType?: unknown; tenant?: unknown };
      const size = (await stat(path)).size;
      return { name: typeof meta.name === "string" ? meta.name : "document", tenant: typeof meta.tenant === "string" ? meta.tenant : "",
        mediaType: typeof meta.mediaType === "string" ? meta.mediaType : "application/octet-stream", size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async get(key: string): Promise<Buffer> {
    const bytes = await readFile(this.#path(key));
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AgenticError("validation", "The archived attachment exceeds 25 MiB");
    return bytes;
  }
  async put(key: string, attachment: StoredAttachment): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, attachment.bytes, { mode: 0o600 });
    await writeFile(`${path}.meta.json`, JSON.stringify({ name: attachment.name, mediaType: attachment.mediaType, tenant: attachment.tenant }), { mode: 0o600 });
  }
}

/** The connector id the bundled document reader is deployed under; used only to name the entry a refusal points to. */
const BUNDLED_READER_ID = "office-docs";

/** The bundled reader's storage declaration is also the writer's: no second bucket/prefix. */
export function documentAttachmentSettings(env: NodeJS.ProcessEnv, profile: "development" | "production", servers: RuntimeConfig["mcpServers"]): DocumentAttachmentSettings {
  const transfers = servers.filter((server) => server.transport === "http" && server.filesEndpoint);
  if (transfers.length > 1) throw new Error("Configure only one execution file transfer endpoint per deployment");
  const remote = transfers[0];
  let execution: DocumentAttachmentSettings["execution"];
  if (remote?.transport === "http" && remote.filesEndpoint) {
    const token = remote.tokenEnv ? env[remote.tokenEnv]?.trim() : undefined;
    if (!token || Buffer.byteLength(token) < 32) throw new Error("Execution file transfer requires a service token with at least 32 bytes");
    execution = { upload: executionFileTransfer(remote.filesEndpoint, token), exists: executionFileExists(remote.filesEndpoint, token) };
  }
  // The reader reads the archive itself over HTTP; the backend writes the same prefix. It is the connector that declares
  // the archive — found by that declaration, not by a product's connector id, which a generic layer cannot know.
  const readers = servers.filter((server) => server.transport === "http" && server.attachmentStorage);
  if (readers.length > 1) throw new Error("Configure attachmentStorage on only one connector per deployment");
  const reader = readers[0];
  const storage = reader?.transport === "http" ? reader.attachmentStorage : undefined;
  // With no declaration to go by, the refusal names the entry to add it to: the connector files are handed to, else the
  // platform's bundled reader under the id its deploy file keeps (mcp-servers/document-readers/deploy/mcp-server.yaml).
  const entry = `config/mcp-servers.yaml's ${reader?.id ?? remote?.id ?? BUNDLED_READER_ID} entry`;
  const connection = storage?.s3EnvPrefix?.trim();
  const prefix = normalizeKeyPrefix(storage?.keyPrefix);
  const refuse = (reason: string): DocumentAttachmentSettings => {
    if (profile === "production") throw new Error(`Chat attachments cannot be stored: ${reason}`);
    return { prefix, unavailable: reason, ...(execution ? { execution } : {}) };
  };
  const localFolder = env.AGENTIC_ATTACHMENTS_DIR?.trim();
  if (localFolder) {
    if (profile === "production") throw new Error("AGENTIC_ATTACHMENTS_DIR is for development only; production archives attachments in object storage");
    if (!prefix) return refuse(`${entry} needs attachmentStorage.keyPrefix`);
    return { store: new FileSystemDocumentStore(localFolder), prefix, ...(execution ? { execution } : {}) };
  }
  if (!connection || !prefix) return refuse(`${entry} needs attachmentStorage: { s3EnvPrefix, keyPrefix }`);
  // `S3` (or a retired `AGENTIC_KNOWLEDGE_S3`) is the shared set every product reads; another prefix is a bucket of its own.
  const config = s3Config(env, connection);
  const names = RETIRED_S3_ENV_PREFIXES.includes(connection) ? S3_ENV_PREFIX : connection;
  if (!config) return refuse(`object storage is not configured: set ${names}_ENDPOINT, ${names}_BUCKET, ${names}_ACCESS_KEY and ${names}_SECRET_KEY`);
  return { store: new S3DocumentStore(new S3ObjectStore(config)), prefix, ...(execution ? { execution } : {}) };
}

/** Structurally implements the delivery layer's AttachmentStore without depending on HTTP. */
export function createDocumentAttachmentStore(settings: DocumentAttachmentSettings, secret: string, context?: string) {
  return {
    maxRequestBytes: MAX_ATTACHMENT_BYTES + 1024 * 1024,
    async store(file: { readonly bytes: Buffer; readonly name: string; readonly mediaType: string }, security: SecurityContext): Promise<string> {
      if (!file.bytes.length || file.bytes.length > MAX_ATTACHMENT_BYTES) throw new AgenticError("validation", "An attached file is empty or exceeds 25 MiB");
      if (!settings.store) {
        console.error(JSON.stringify({ event: "attachment.refused", reason: settings.unavailable }));
        throw new AgenticError("transient", `Chat attachments cannot be stored: ${settings.unavailable}`, true);
      }
      if (!secret) throw new AgenticError("transient", "Attachment ID signing key is not configured", true);
      const documentId = documentAttachmentId(secret, security.tenantId, file.bytes, context);
      const key = settings.prefix + documentId;
      if (!(await settings.store.stat(key))) await settings.store.put(key, {
        bytes: file.bytes, name: file.name.slice(0, 255), mediaType: file.mediaType, tenant: security.tenantId,
      });
      return documentId;
    },
  };
}
