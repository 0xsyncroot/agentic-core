import assert from "node:assert/strict";
import { test } from "node:test";
import { parseElkConfig, elkAuthorizationHeader } from "../src/elk-config.js";
import { ElkTelemetrySink, type ElkTransport } from "../src/elk-telemetry-sink.js";
import { ElkHttpTransport } from "../src/elk-http-transport.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AgentTelemetryEvent } from "@0xsyncroot/contracts";

const BASE = `
endpoint: https://elk.internal:9200/_bulk
dataStream: sample-app-agent-logs
`;

function event(index: number): AgentTelemetryEvent {
  return {
    type: "agent.operation.finished", operation: "run-turn", tenantId: "tenant-a",
    sessionId: `session-${index}`, correlationId: `corr-${index}`, outcome: "completed",
    durationMs: 1_200, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    occurredAt: "2026-09-11T00:00:00.000Z",
  };
}

class RecordingTransport implements ElkTransport {
  readonly batches: Readonly<Record<string, unknown>>[][] = [];
  failures = 0;
  async send(documents: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    if (this.failures > 0) { this.failures -= 1; throw new Error("ELK unavailable"); }
    this.batches.push([...documents]);
  }
  async close(): Promise<void> { /* nothing to release */ }
}

test("fields: an empty value is not stamped, a non-string value is still refused", () => {
  const config = parseElkConfig(`${BASE}\nfields:\n  app_id: sample-app_ai\n  database_id: ""\n  note: "   "\n  env: dev\n`);
  assert.deepEqual({ ...config.fields }, { app_id: "sample-app_ai", env: "dev" });
  assert.throws(() => parseElkConfig(`${BASE}\nfields:\n  app_id: 5\n`), /fields\.app_id/u);
  assert.throws(() => parseElkConfig(`${BASE}\nfields:\n  Bad Name: ""\n`), /not a valid field name/u);
});

test("a secret written into the config file is refused, not shipped", () => {
  // The file lives in git and in an image layer. Naming the variable is the only safe shape,
  // and a rejected deploy is a far cheaper way to learn that than a password in a git history.
  assert.throws(() => parseElkConfig(`${BASE}\nauth:\n  kind: api-key\n  apiKey: super-secret\n`),
    /must not contain a literal apiKey/u);
  const config = parseElkConfig(`${BASE}\nauth:\n  kind: api-key\n  apiKeyEnv: SAMPLE_APP_ELK_API_KEY\n`);
  assert.equal(elkAuthorizationHeader(config, { SAMPLE_APP_ELK_API_KEY: "k" }), "ApiKey k");
  assert.throws(() => elkAuthorizationHeader(config, {}), /SAMPLE_APP_ELK_API_KEY is not set/u);
});

test("plaintext transport is a decision, never a default", () => {
  assert.throws(() => parseElkConfig("endpoint: http://elk.internal:9200/_bulk\n"), /must be https/u);
  assert.equal(parseElkConfig("endpoint: http://elk.internal:9200/_bulk\nallowInsecureInternal: true\n").endpoint,
    "http://elk.internal:9200/_bulk");
  assert.throws(() => parseElkConfig("endpoint: https://user:pass@elk.internal/_bulk\n"), /must not embed credentials/u);
});

test("telemetry documents carry identifiers and outcomes, never content", async () => {
  const transport = new RecordingTransport();
  const sink = new ElkTelemetrySink({
    config: parseElkConfig(`${BASE}\nfields:\n  service.name: sample-app-agent\n`), transport,
  });
  sink.record(event(1));
  await sink.flush();

  const [document] = transport.batches[0]! as unknown as Array<Record<string, Record<string, unknown>>>;
  // Nested, not dotted. Elasticsearch takes either; a Logstash pipeline in between treats a
  // dotted key as a field whose name contains a dot, so `[event][action]` would find nothing.
  assert.equal(document!.service!.name, "sample-app-agent");
  assert.equal((document!.agent!.tenant as Record<string, unknown>).id, "tenant-a");
  assert.equal(document!.event!.outcome, "completed");
  assert.equal(document!.event!.duration, 1_200_000_000, "ECS wants nanoseconds");
  assert.equal(document!["event.action"], undefined, "no dotted shorthand survives into the wire format");
  // The index is meant to be readable by an operations team with no payroll access, which only
  // holds while nothing from the conversation can reach it.
  assert.doesNotMatch(JSON.stringify(document), /message|content|prompt|payload/iu);
  await sink.close();
});

test("an ELK outage loses telemetry rather than the service", async () => {
  const transport = new RecordingTransport();
  const sink = new ElkTelemetrySink({
    config: parseElkConfig(`${BASE}\nqueue:\n  maxEvents: 10\nbatch:\n  maxEvents: 100\nretry:\n  attempts: 1\n  baseDelayMs: 10\n`),
    transport,
  });

  // Recording must never throw and never block: a log shipper that does turns an ELK outage
  // into a payroll outage.
  transport.failures = 1;
  sink.record(event(1));
  await sink.flush();
  assert.equal(transport.batches.length, 0, "the failed batch was given up, not retried forever");

  // The queue is bounded, oldest first — the newest events are the ones an operator is looking
  // at — and the loss is stamped on the next document that gets through rather than hidden.
  for (let index = 0; index < 25; index += 1) sink.record(event(index));
  await sink.flush();
  const [first] = transport.batches.at(-1)!;
  assert.ok(Number(first!["event.dropped"]) > 0, "a gap in the dashboard explains itself in the same index");
  await sink.close();
});

test("a bulk response that reports document errors is a failure, not a success", async () => {
  const config = parseElkConfig(BASE);
  const transport = new ElkHttpTransport({
    config, env: {},
    fetch: async () => new Response(JSON.stringify({ errors: true, items: [] }), { status: 200 }),
  });
  // Elasticsearch answers 200 for a bulk request whose documents were all rejected. Reading
  // only the status would report a shipping pipeline that stores nothing as healthy.
  await assert.rejects(() => transport.send([{ "@timestamp": "2026-09-11T00:00:00.000Z" }]),
    /reported document errors/u);

  const rejecting = new ElkHttpTransport({ config, env: {}, fetch: async () => new Response("nope", { status: 503 }) });
  await assert.rejects(() => rejecting.send([{ "@timestamp": "2026-09-11T00:00:00.000Z" }]), (error: Error) => {
    assert.match(error.message, /HTTP 503/u);
    assert.doesNotMatch(error.message, /nope/u, "a proxy's body can carry credentials; only the status is logged");
    return true;
  });
});

test("the wire format matches the receiver it is pointed at", async () => {
  const captured: Array<{ body: string; contentType: string }> = [];
  const capture = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({ body: String(init?.body ?? ""), contentType: headers.get("content-type") ?? "" });
    return new Response("{}", { status: 200 });
  };
  const documents = [{ "@timestamp": "2026-09-11T00:00:00.000Z" }, { "@timestamp": "2026-09-11T00:00:01.000Z" }];

  // Elasticsearch needs the action line before each document; it is what says where to write.
  await new ElkHttpTransport({ config: parseElkConfig(BASE), env: {}, fetch: capture as typeof fetch }).send(documents);
  const bulk = captured.at(-1)!;
  assert.equal(bulk.contentType, "application/x-ndjson");
  assert.equal(bulk.body.trimEnd().split("\n").length, 4, "two documents, each with its action line");
  assert.match(bulk.body, /\{"create":\{"_index":"sample-app-agent-logs"\}\}/u);

  // Logstash decides the index itself and reads one event per line with codec => json_lines.
  // An action line there would arrive as an event of its own; a wrapped array would arrive as
  // a single event holding the whole batch.
  await new ElkHttpTransport({
    config: parseElkConfig(`${BASE}\nmode: ndjson\n`), env: {}, fetch: capture as typeof fetch,
  }).send(documents);
  const ndjson = captured.at(-1)!;
  assert.equal(ndjson.contentType, "application/x-ndjson",
    "not application/json: Logstash maps that content type to its single-document codec");
  const lines = ndjson.body.trimEnd().split("\n");
  assert.equal(lines.length, 2, "one line per document, no action lines");
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.ok(parsed["@timestamp"], "each line is a complete document");
    assert.equal(parsed["data_stream.dataset"], "sample-app-agent-logs", "the index travels as a field the pipeline can route on");
  }
});

test("a Logstash http input receives events it can actually parse", async () => {
  // Stands in for `input { http { codec => json_lines, user, password } }`: Basic auth, one
  // event per line, and no knowledge of Elasticsearch bulk framing. If the shipper is wrong
  // about any of those, this receiver sees it the way Logstash would.
  const received: Array<Record<string, unknown>> = [];
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    if (authorization !== `Basic ${Buffer.from("sample-app:secret", "utf8").toString("base64")}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
        if (line.trim()) received.push(JSON.parse(line) as Record<string, unknown>);
      }
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  try {
    const config = parseElkConfig(`
endpoint: http://127.0.0.1:${port}
mode: ndjson
allowInsecureInternal: true
dataStream: sample-app-agent-logs
auth:
  kind: basic
  usernameEnv: LS_USER
  passwordEnv: LS_PASSWORD
fields:
  service.name: sample-app-agent
`);
    const sink = new ElkTelemetrySink({
      config,
      transport: new ElkHttpTransport({ config, env: { LS_USER: "sample-app", LS_PASSWORD: "secret" } }),
    });
    sink.record(event(1));
    sink.record(event(2));
    await sink.flush();
    await sink.close();

    assert.equal(received.length, 2, "each line arrived as its own event, not one batch-shaped blob");
    const [first] = received as Array<Record<string, Record<string, unknown>>>;
    assert.equal(first!.service!.name, "sample-app-agent");
    assert.equal((first!.agent!.tenant as Record<string, unknown>).id, "tenant-a");
    assert.equal(first!["data_stream.dataset"], "sample-app-agent-logs");
    assert.ok(authorization?.startsWith("Basic "), "the http input speaks Basic auth and nothing else");
  } finally {
    server.close();
    await once(server, "close");
  }
});
