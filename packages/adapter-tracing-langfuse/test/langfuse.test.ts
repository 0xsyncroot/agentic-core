import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmAdapter, LlmStreamEvent, PreparedLlmRequest } from "@0xsyncroot/contracts";
import { parseLangfuseConfig } from "../src/langfuse-config.js";
import { LangfuseClient, type LangfuseEvent, type LangfuseIngestion } from "../src/langfuse-client.js";
import { traceLlmAdapter } from "../src/traced-llm-adapter.js";
import { decorateWithLangfuse } from "../src/langfuse-composition.js";
import { LLM_CAPABILITY, TOOL_CAPABILITY, type PluginDescriptor, type ScopedPluginContext } from "@0xsyncroot/plugin-sdk";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const BASE = `
baseUrl: https://langfuse.internal
publicKeyEnv: LF_PUBLIC
secretKeyEnv: LF_SECRET
`;

class RecordingIngestion implements LangfuseIngestion {
  readonly events: LangfuseEvent[] = [];
  enqueue(event: LangfuseEvent): void { this.events.push(event); }
  async flush(): Promise<void> { /* nothing buffered */ }
  async close(): Promise<void> { /* nothing to release */ }
}

function request(stepId: string): PreparedLlmRequest {
  return {
    requestId: "request-a", attemptId: "attempt-a", turnId: "turn-a", stepId,
    runtimeSnapshotId: "snapshot-a", model: "deepseek-v4",
    messages: [
      { role: "system", content: "Bạn là trợ lý lương" },
      { role: "user", content: "Lương tháng 8 của Nguyễn Văn A là 12.500.000đ, đúng không?" },
    ],
    tools: [{ name: "payroll_work_sheet_data", description: "", inputSchema: {} }],
    parameters: { temperature: 0 }, contentHash: "hash-a",
  } as PreparedLlmRequest;
}

function adapter(events: readonly LlmStreamEvent[], fail?: Error): LlmAdapter {
  return {
    id: "test", model: "deepseek-v4",
    stream: async function* stream(): AsyncIterable<LlmStreamEvent> {
      for (const event of events) yield event;
      if (fail) throw fail;
    },
  };
}

async function drain(iterable: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const collected: LlmStreamEvent[] = [];
  for await (const event of iterable) collected.push(event);
  return collected;
}

test("a payroll conversation does not leave the service just because tracing is on", async () => {
  const ingestion = new RecordingIngestion();
  const traced = traceLlmAdapter(adapter([
    { type: "text-delta", delta: "Đúng" },
    { type: "final", content: "Đúng, 12.500.000đ", toolCalls: [], finishReason: "stop",
      status: "completed", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
  ]), { ingestion, config: parseLangfuseConfig(BASE) });

  await drain(traced.stream(request("step-1"), new AbortController().signal));
  const rendered = JSON.stringify(ingestion.events);

  // metadata-only is the default, and the default is the whole point: turning tracing on must
  // not copy salaries and names into a second system.
  assert.doesNotMatch(rendered, /Nguyễn Văn A|12\.500\.000/u);
  assert.match(rendered, /hash-a/u, "the runtime's own content hash still answers 'same input?'");
  assert.match(rendered, /payroll_work_sheet_data/u, "tool names are shape, not payroll data");

  const [trace, create, update] = ingestion.events;
  assert.equal(trace?.type, "trace-create");
  assert.equal(trace.body.id, "turn-a", "one trace per turn, so its steps group the way an engineer reads them");
  assert.equal(create?.type, "generation-create");
  assert.equal(update?.type, "generation-update");
  assert.deepEqual(update.body.usage, { input: 100, output: 20, total: 120 });
  assert.equal(create.body.id, update.body.id, "the update lands on the generation it belongs to");
});

test("full capture is available, and has to be asked for", async () => {
  const ingestion = new RecordingIngestion();
  const traced = traceLlmAdapter(adapter([
    { type: "final", content: "Đúng, 12.500.000đ", toolCalls: [], finishReason: "stop", status: "completed" },
  ]), { ingestion, config: parseLangfuseConfig(`${BASE}\ncapture: full\n`) });

  await drain(traced.stream(request("step-1"), new AbortController().signal));
  assert.match(JSON.stringify(ingestion.events), /Nguyễn Văn A/u);
});

test("a second step joins the same trace instead of starting another", async () => {
  const ingestion = new RecordingIngestion();
  const config = parseLangfuseConfig(BASE);
  const traced = traceLlmAdapter(adapter([
    { type: "final", content: "ok", toolCalls: [], finishReason: "stop", status: "completed" },
  ]), { ingestion, config });

  await drain(traced.stream(request("step-1"), new AbortController().signal));
  await drain(traced.stream(request("step-2"), new AbortController().signal));
  assert.equal(ingestion.events.filter((event) => event.type === "trace-create").length, 1);
  assert.equal(ingestion.events.filter((event) => event.type === "generation-create").length, 2);
});

test("a failing model call is closed as an error and still fails the caller", async () => {
  const ingestion = new RecordingIngestion();
  const traced = traceLlmAdapter(adapter([], new Error("provider exploded")),
    { ingestion, config: parseLangfuseConfig(BASE) });

  // The tracer observes; it must never swallow. A turn that failed has to fail.
  await assert.rejects(() => drain(traced.stream(request("step-1"), new AbortController().signal)), /provider exploded/u);
  const update = ingestion.events.find((event) => event.type === "generation-update");
  assert.equal(update?.body.level, "ERROR");
  assert.match(String(update?.body.statusMessage), /provider exploded/u);
});

test("a stream that ends without a final event says so rather than looking successful", async () => {
  const ingestion = new RecordingIngestion();
  const traced = traceLlmAdapter(adapter([{ type: "text-delta", delta: "partial" }]),
    { ingestion, config: parseLangfuseConfig(BASE) });
  await drain(traced.stream(request("step-1"), new AbortController().signal));
  assert.equal(ingestion.events.find((event) => event.type === "generation-update")?.body.level, "WARNING");
});

test("credentials are named in the file, never written in it", () => {
  assert.throws(() => parseLangfuseConfig(`${BASE}\nsecretKey: sk-live-123\n`), /must not contain a literal secretKey/u);
  assert.throws(() => parseLangfuseConfig("baseUrl: http://langfuse.internal\npublicKeyEnv: LF_PUBLIC\nsecretKeyEnv: LF_SECRET\n"),
    /must be https/u);
  assert.throws(() => new LangfuseClient({ config: parseLangfuseConfig(BASE), env: { LF_PUBLIC: "p" } }),
    /LF_PUBLIC and LF_SECRET must both be set/u);
});

test("an unreachable Langfuse loses traces, not turns", async () => {
  let attempts = 0;
  const client = new LangfuseClient({
    config: parseLangfuseConfig(`${BASE}\nretry:\n  attempts: 2\n  baseDelayMs: 10\nqueue:\n  maxEvents: 10\n`),
    env: { LF_PUBLIC: "p", LF_SECRET: "s" },
    fetch: async () => { attempts += 1; throw new Error("unreachable"); },
  });
  const failures: string[] = [];
  for (let index = 0; index < 30; index += 1) client.enqueue({ type: "event-create", body: { index } });
  await client.flush().catch((error: Error) => failures.push(error.message));

  // Never throws into the caller, and never retries without bound behind a growing queue.
  assert.deepEqual(failures, []);
  assert.equal(attempts, 2);
  await client.close();
});

test("decorating a model plugin traces it without changing what artifact verification checks", async () => {
  const ingestion = new RecordingIngestion();
  const provided: Array<{ capability: string; value: unknown }> = [];
  const base = {
    manifest: { id: "io.syncroot.adapter.test", version: "1.2.3", artifact: { digest: "sha256-abc", signature: "sig" } },
    trustTier: "first-party",
    plugin: {
      validate: async () => ({ valid: true as const }),
      activate: async (context: ScopedPluginContext) => {
        context.registrations.provide(LLM_CAPABILITY, adapter([
          { type: "final", content: "ok", toolCalls: [], finishReason: "stop", status: "completed" },
        ]));
        context.registrations.provide(TOOL_CAPABILITY, { id: "some_tool" } as never);
        return { dispose: () => undefined };
      },
    },
  } as unknown as PluginDescriptor;

  const decorated = decorateWithLangfuse(base, { config: parseLangfuseConfig(BASE), ingestion });
  // Identity is what artifact pinning verifies. If decoration changed it, turning tracing on
  // would read as someone shipping a different model adapter.
  assert.deepEqual(decorated.manifest, base.manifest);
  assert.equal(decorated.trustTier, base.trustTier);

  await decorated.plugin.activate({
    registrations: {
      provide: (token: { id: string }, value: unknown) => {
        provided.push({ capability: token.id, value });
        return { owner: "test", capabilityId: token.id, dispose: () => undefined };
      },
    },
  } as unknown as ScopedPluginContext);

  const [llm, tool] = provided;
  assert.equal(llm?.capability, LLM_CAPABILITY.id);
  await drain((llm!.value as LlmAdapter).stream(request("step-1"), new AbortController().signal));
  assert.ok(ingestion.events.length > 0, "the model adapter that reached the host is the traced one");
  // Everything else passes through untouched: the wrapper intercepts one capability, not all.
  assert.deepEqual(tool?.value, { id: "some_tool" });
});

test("a self-hosted Langfuse receives a batch in the shape its ingestion API defines", async () => {
  // Stands in for the self-hosted instance: same path, same Basic auth, same envelope. If the
  // client is wrong about any of them, this sees it the way Langfuse would — which is the
  // nearest thing to proof available without pointing at the real host.
  const batches: Array<Array<Record<string, unknown>>> = [];
  let path: string | undefined;
  let authorization: string | undefined;
  let contentType: string | undefined;
  const server = createServer((request, response) => {
    path = request.url;
    authorization = request.headers.authorization;
    contentType = request.headers["content-type"];
    if (authorization !== `Basic ${Buffer.from("pk-lf-demo:sk-lf-demo", "utf8").toString("base64")}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { batch: Array<Record<string, unknown>> };
      batches.push(parsed.batch);
      response.writeHead(200, { "content-type": "application/json" }).end('{"successes":[],"errors":[]}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  try {
    const config = parseLangfuseConfig(`
baseUrl: http://127.0.0.1:${port}
allowInsecureInternal: true
publicKeyEnv: LF_PUBLIC
secretKeyEnv: LF_SECRET
environment: audit
tags:
  - sample-app
`);
    const client = new LangfuseClient({ config, env: { LF_PUBLIC: "pk-lf-demo", LF_SECRET: "sk-lf-demo" } });
    const traced = traceLlmAdapter(adapter([
      { type: "final", content: "ok", toolCalls: [], finishReason: "stop", status: "completed",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]), { ingestion: client, config });

    await drain(traced.stream(request("step-1"), new AbortController().signal));
    await client.close();

    assert.equal(path, "/api/public/ingestion");
    assert.equal(contentType, "application/json");
    const events = batches.flat();
    assert.equal(events.length, 3, "one trace and one generation, created then updated");
    for (const event of events) {
      // Every ingestion event is {id, type, timestamp, body}; a missing id is rejected per event
      // and would show up as a 207 nobody reads.
      for (const field of ["id", "type", "timestamp", "body"]) assert.ok(event[field], `${String(event.type)} is missing ${field}`);
      assert.doesNotThrow(() => new Date(String(event.timestamp)).toISOString());
    }
    const trace = events.find((event) => event.type === "trace-create")!.body as Record<string, unknown>;
    assert.equal(trace.id, "turn-a");
    assert.equal(trace.environment, "audit");
    const created = events.find((event) => event.type === "generation-create")!.body as Record<string, unknown>;
    const updated = events.find((event) => event.type === "generation-update")!.body as Record<string, unknown>;
    assert.equal(created.traceId, "turn-a");
    assert.equal(updated.id, created.id, "the update attaches to the generation it belongs to");
    assert.deepEqual(updated.usage, { input: 10, output: 5, total: 15 });
    assert.doesNotMatch(JSON.stringify(events), /Nguyễn Văn A/u, "and metadata-only still holds over the wire");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("a partial ingestion response is reported, never retried into duplicates", async () => {
  let requests = 0;
  const reported: string[] = [];
  const config = parseLangfuseConfig(`${BASE}\nretry:\n  attempts: 3\n  baseDelayMs: 10\n`);
  const client = new LangfuseClient({
    config, env: { LF_PUBLIC: "p", LF_SECRET: "s" },
    onError: (error) => reported.push(error.message),
    // 207 is Langfuse's partial success: some events stored, some rejected. Retrying the whole
    // batch would duplicate the stored ones.
    fetch: async () => { requests += 1; return new Response("{}", { status: 207 }); },
  });
  client.enqueue({ type: "event-create", body: { a: 1 } });
  await client.flush();
  assert.equal(requests, 1);
  assert.match(reported.join(" "), /rejected part of a trace batch/u);
  await client.close();
});
