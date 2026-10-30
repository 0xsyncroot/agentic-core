import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AgenticError, type ToolInvocation } from "@0xsyncroot/contracts";
import { executionFileTransfer } from "../src/composition/execution-attachments.js";
import { createDocumentAttachmentStore, documentAttachmentSettings, type DocumentAttachmentSettings, type StoredAttachment } from "../src/composition/document-attachments.js";
import { executionFileExists } from "../src/composition/execution-attachments.js";
import { createDocumentToolPreparation } from "../src/composition/document-tool-preparation.js";

const token = "attachment-transfer-test-only-service-token";
const file = { name: "Bảng lương.csv", mediaType: "text/csv", bytes: Buffer.from("Tên,Số tiền\nHoa,42\n") };
const id = "a".repeat(32);

async function withServer(listener: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(url); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("internal attachment transfer preserves binary bytes, MIME and Unicode filename", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["content-type"], file.mediaType);
    assert.equal(decodeURIComponent(String(request.headers["x-file-name"])), file.name);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), file.bytes);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ documentId: id, name: file.name }));
  }, async url => {
    assert.equal(await executionFileTransfer(`${url}/files`, token)(file), id);
  });
});

test("durable IDs survive cache loss; parallel reads restore once and cached files still require ownership", async () => {
  const archive = new Map<string, StoredAttachment>();
  let cached = false, puts = 0, gets = 0, requests = 0;
  await withServer(async (request, response) => {
    requests++;
    if (request.method === "HEAD") {
      response.writeHead(cached ? 200 : 404, { "x-file-expires-at": String(Date.now() + 900_000) }).end(); return;
    }
    assert.equal(request.method, "PUT");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), file.bytes);
    puts++; cached = true;
    response.writeHead(201).end(JSON.stringify({ documentId: request.url!.split("/").at(-1) }));
  }, async url => {
    const settings: DocumentAttachmentSettings = { prefix: "attachments/", store: {
      stat: async key => { const entry = archive.get(key); return entry ? { ...entry, size: entry.bytes.length } : undefined; },
      get: async key => { gets++; return archive.get(key)!.bytes; },
      put: async (key, entry) => { archive.set(key, entry); },
    }, execution: { upload: executionFileTransfer(`${url}/files`, token), exists: executionFileExists(`${url}/files`, token) } };
    const security = { tenantId: "tenant-a", actorId: "actor-a", permissions: new Set<string>(), correlationId: "test", purpose: "test" };
    const store = createDocumentAttachmentStore(settings, token);
    const documentId = await store.store(file, security);
    const invocation: ToolInvocation = { callId: "call", sessionId: "history", turnId: "turn", stepId: "step", idempotencyKey: "key", security, arguments: { documentId } };
    const signal = new AbortController().signal;
    const prepare = createDocumentToolPreparation(settings);
    await Promise.all([prepare("read_document", invocation, signal), prepare("read_cells", invocation, signal)]);
    assert.equal(puts, 1); assert.equal(gets, 1);
    await prepare("read_table", invocation, signal);
    assert.equal(gets, 1, "cached reads do not download S3 bytes again");
    const authorizedRequests = requests;
    await assert.rejects(prepare("read_document", { ...invocation, security: { ...security, tenantId: "tenant-b" } }, signal), { code: "denied" });
    assert.equal(requests, authorizedRequests, "ownership is checked before contacting the cache");
    cached = false;
    await createDocumentToolPreparation(settings)("read_document", invocation, signal);
    assert.equal(puts, 2); assert.equal(gets, 2);
    assert.equal(await store.store(file, security), documentId, "a reopen/reupload keeps the history handle");
    archive.clear();
    await assert.rejects(prepare("read_document", invocation, signal), { code: "denied" });
  });
});

test("one waiter cancelling does not fail the other callers sharing a restore", async () => {
  const archive = new Map<string, StoredAttachment>();
  let cached = false;
  await withServer(async (request, response) => {
    if (request.method === "HEAD") { response.writeHead(cached ? 200 : 404, { "x-file-expires-at": String(Date.now() + 900_000) }).end(); return; }
    for await (const _ of request) { /* drain */ }
    await new Promise(resolve => setTimeout(resolve, 150));
    cached = true;
    response.writeHead(201).end(JSON.stringify({ documentId: request.url!.split("/").at(-1) }));
  }, async url => {
    const settings: DocumentAttachmentSettings = { prefix: "attachments/", store: {
      stat: async key => { const entry = archive.get(key); return entry ? { ...entry, size: entry.bytes.length } : undefined; },
      get: async key => archive.get(key)!.bytes,
      put: async (key, entry) => { archive.set(key, entry); },
    }, execution: { upload: executionFileTransfer(`${url}/files`, token), exists: executionFileExists(`${url}/files`, token) } };
    const security = { tenantId: "tenant-a", actorId: "actor-a", permissions: new Set<string>(), correlationId: "test", purpose: "test" };
    const documentId = await createDocumentAttachmentStore(settings, token).store(file, security);
    const invocation: ToolInvocation = { callId: "call", sessionId: "s", turnId: "t", stepId: "p", idempotencyKey: "k", security, arguments: { documentId } };
    const prepare = createDocumentToolPreparation(settings);
    const first = new AbortController();
    const cancelled = prepare("read_document", invocation, first.signal);
    const survivor = prepare("read_cells", invocation, new AbortController().signal);
    setTimeout(() => first.abort(), 30);
    await assert.rejects(cancelled, { code: "cancelled" });
    await survivor;
    assert.equal(cached, true);
  });
});

test("a reader that reads S3 itself needs no transfer endpoint: only ownership is checked before the call", async () => {
  const archive = new Map<string, StoredAttachment>();
  const settings: DocumentAttachmentSettings = { prefix: "attachments/", store: {
    stat: async key => { const entry = archive.get(key); return entry ? { ...entry, size: entry.bytes.length } : undefined; },
    get: async () => { throw new Error("the backend must not download the file for the reader"); },
    put: async (key, entry) => { archive.set(key, entry); },
  } };
  const security = { tenantId: "tenant-a", actorId: "actor-a", permissions: new Set<string>(), correlationId: "test", purpose: "test" };
  const documentId = await createDocumentAttachmentStore(settings, token).store(file, security);
  const invocation: ToolInvocation = { callId: "c", sessionId: "s", turnId: "t", stepId: "p", idempotencyKey: "k", security, arguments: { documentId } };
  const prepare = createDocumentToolPreparation(settings);
  await prepare("read_table", invocation, new AbortController().signal);
  await assert.rejects(prepare("read_table", { ...invocation, security: { ...security, tenantId: "tenant-b" } }, new AbortController().signal), { code: "denied" });
  const servers = [{ id: "office-docs", transport: "http", endpoint: "http://reader:8080/mcp", authMode: "service", tokenEnv: "EXECUTION_SERVICE_TOKEN",
    attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/" } }] as const;
  assert.throws(() => documentAttachmentSettings({ EXECUTION_SERVICE_TOKEN: token }, "production", servers), /DOCUMENTS_S3_ENDPOINT/,
    "the archive is still required, read from attachmentStorage even without filesEndpoint");
});

test("development can archive attachments in a local folder the reader reads directly; production refuses it", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "attachments-"));
  const servers = [{ id: "office-docs", transport: "http", endpoint: "http://127.0.0.1:8080/mcp", authMode: "service", tokenEnv: "DOCUMENT_READERS_TOKEN",
    attachmentStorage: { s3EnvPrefix: "AGENTIC_KNOWLEDGE_S3", keyPrefix: "agentic-attachments/" } }] as const;
  assert.throws(() => documentAttachmentSettings({ AGENTIC_ATTACHMENTS_DIR: folder }, "production", servers), /development only/);
  const settings = documentAttachmentSettings({ AGENTIC_ATTACHMENTS_DIR: folder }, "development", servers);
  const security = { tenantId: "tenant-a", actorId: "actor-a", permissions: new Set<string>(), correlationId: "test", purpose: "test" };
  const documentId = await createDocumentAttachmentStore(settings, token).store(file, security);
  const stored = join(folder, "agentic-attachments", documentId);
  assert.deepEqual(readFileSync(stored), file.bytes, "bytes land where the reader's DOCUMENT_SOURCE_DIR points");
  assert.deepEqual(JSON.parse(readFileSync(`${stored}.meta.json`, "utf8")), { name: file.name, mediaType: file.mediaType, tenant: "tenant-a" });
  const invocation: ToolInvocation = { callId: "c", sessionId: "s", turnId: "t", stepId: "p", idempotencyKey: "k", security, arguments: { documentId } };
  await createDocumentToolPreparation(settings)("read_table", invocation, new AbortController().signal);
  await assert.rejects(createDocumentToolPreparation(settings)("read_table", { ...invocation, security: { ...security, tenantId: "tenant-b" } },
    new AbortController().signal), { code: "denied" }, "tenant ownership is checked from the folder's metadata too");
});

test("HTTP readers require durable S3 storage instead of accepting a temporary-only upload", () => {
  const servers = [{ id: "office-docs", transport: "http", endpoint: "http://127.0.0.1/mcp",
    filesEndpoint: "http://127.0.0.1/files", authMode: "service", tokenEnv: "EXECUTION_SERVICE_TOKEN" }] as const;
  assert.throws(() => documentAttachmentSettings({ EXECUTION_SERVICE_TOKEN: token }, "production", servers), /attachmentStorage/);
  assert.equal(documentAttachmentSettings({ EXECUTION_SERVICE_TOKEN: token }, "development", servers).store, undefined);
  const configured = [{ ...servers[0], attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/" } }];
  assert.throws(() => documentAttachmentSettings({ EXECUTION_SERVICE_TOKEN: token }, "production", configured), /DOCUMENTS_S3_ENDPOINT/);
});

test("internal transfer classifies temporary failures, bounds metadata and refuses redirects", async () => {
  let redirected = 0;
  await withServer((request, response) => {
    request.resume();
    const path = request.url!;
    if (path === "/redirect") { response.writeHead(307, { location: "/redirected" }).end(); return; }
    if (path === "/redirected") redirected++;
    const status = Number(path.slice(1));
    if ([400, 408, 429, 503].includes(status)) { response.writeHead(status).end(); return; }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(path === "/oversized" ? JSON.stringify({ documentId: id, name: "ấ".repeat(3000) })
      : path === "/null" ? "null" : path === "/invalid-json" ? "{" : '{"documentId":"wrong"}');
  }, async url => {
    for (const [path, code, retryable] of [
      ["400", "validation", false], ["408", "transient", true], ["429", "transient", true],
      ["503", "transient", true], ["oversized", "permanent", false], ["null", "permanent", false],
      ["invalid-json", "permanent", false], ["invalid-handle", "permanent", false], ["redirect", "transient", true],
    ] as const) {
      await assert.rejects(executionFileTransfer(`${url}/${path}`, token)(file), error => {
        assert.ok(error instanceof AgenticError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.ok(!error.message.includes(token));
        return true;
      });
    }
    assert.equal(redirected, 0, "service credentials must never be forwarded through a redirect");
  });
});

test("the reader is the connector that declares the archive, whatever the product calls it", () => {
  // The generic layer found it by the id "office-docs"; a product naming its reader otherwise lost its attachments' archive.
  const servers = [{ id: "contracts-reader", transport: "http", endpoint: "http://reader:8080/mcp", authMode: "service", tokenEnv: "DOCUMENT_READERS_TOKEN",
    attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/" } }] as const;
  assert.throws(() => documentAttachmentSettings({}, "production", servers), /DOCUMENTS_S3_ENDPOINT/, "its storage is read, so only the bucket settings are missing");
  assert.throws(() => documentAttachmentSettings({}, "production", [{ ...servers[0], id: "other", attachmentStorage: { s3EnvPrefix: "S3", keyPrefix: "x/" } }, servers[0]]),
    /only one connector/u);
  const unnamed = [{ id: "office-docs", transport: "http", endpoint: "http://reader:8080/mcp", authMode: "service", tokenEnv: "DOCUMENT_READERS_TOKEN" }] as const;
  assert.equal(documentAttachmentSettings({}, "development", unnamed).unavailable, "config/mcp-servers.yaml's office-docs entry needs attachmentStorage: { s3EnvPrefix, keyPrefix }",
    "with no declaration, the refusal names the bundled reader's entry, as before");
});

test("reader configurations retain their independently declared archive prefixes", async () => {
  // Reader discovery uses the declaration rather than a product identifier.
  const { parseMcpServers } = await import("../src/composition/mcp-server-config.js");
  const { fileURLToPath } = await import("node:url");
  const shared = { S3_ENDPOINT: "http://127.0.0.1:9000", S3_BUCKET: "b", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "s" };
  for (const [product, prefix] of [["required", "required-attachments/"], ["optional", "optional-attachments/"]] as const) {
    const file = fileURLToPath(new URL(`./fixtures/reader-${product}.yaml`, import.meta.url));
    const servers = parseMcpServers({ AGENTIC_MCP_CONFIG_FILE: file });
    const settings = documentAttachmentSettings(shared, "production", servers);
    assert.ok(settings.store, `${product}: the archive is configured`);
    assert.equal(settings.prefix, prefix, `${product}: the reader's own prefix`);
  }
});
