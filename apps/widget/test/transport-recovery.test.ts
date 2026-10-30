import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";

/**
 * The HTTP transport's own retry window against a backend that goes away and comes back.
 *
 * The retry window must outlive a backend restart, and a connection that stays open but silent
 * must be retried too. These pin the window, the two clocks, the
 * stream-reset header and the stable request identity.
 */

interface Transport {
  send(request: Record<string, unknown>, context: Record<string, unknown>): Promise<{ content: string }>;
}
interface Api { createHarnessTransport(options: Record<string, unknown>): Transport }

async function api(): Promise<Api> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const context = createContext({ URL, document: { baseURI: "https://portal.example/app/" }, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, FormData });
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  return (context as unknown as { AgentChat: Api }).AgentChat;
}

const encoder = new TextEncoder();
const sse = { "content-type": "text/event-stream" };
const delta = (id: number, text: string) => `id: ${id}\nevent: assistant-output-delta\ndata: ${JSON.stringify({ outputId: "a", audience: "user", delta: text })}\n\n`;
const done = (id: number, content: string) => `id: ${id}\nevent: result\ndata: ${JSON.stringify({ content })}\n\n`;

interface Call { readonly body: string; readonly lastEventId: string | null }
async function run(
  options: Record<string, unknown>,
  handler: (call: Call, attempt: number, signal: AbortSignal) => Promise<Response>,
  requestId = "req-1",
) {
  const calls: Call[] = [];
  const transport = (await api()).createHarnessTransport({
    baseUrl: "https://gateway.example",
    request: (_url: string, init: RequestInit) => {
      const call = { body: String(init.body), lastEventId: new Headers(init.headers).get("last-event-id") };
      calls.push(call);
      return handler(call, calls.length, init.signal as AbortSignal);
    },
    ...options,
  });
  const events: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const outcome = transport.send({ content: "hi", sessionId: "s", requestId, attachments: [] }, {
    operation: "turn", sessionId: "s", requestId, signal: controller.signal, onEvent: (event: unknown) => events.push(JSON.parse(JSON.stringify(event))),
  });
  return { calls, events, outcome, transport };
}

test("connection refused several times, then success inside the window: one result, same identity every time", async () => {
  const { calls, outcome } = await run(
    { reconnect: { maxAttempts: 10, baseDelayMs: 1, maxDelayMs: 4, maxTotalMs: 2_000 } },
    async (_call, attempt) => {
      if (attempt <= 4) throw new TypeError("connection refused");
      return new Response(delta(1, "ok") + done(2, "ok"), { headers: sse });
    },
  );
  assert.equal((await outcome).content, "ok");
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls.map((call) => call.body)).size, 1, "every retry re-posts the identical request, requestId included");
  assert.equal((JSON.parse(calls[0]!.body) as { requestId: string }).requestId, "req-1");
});

test("a window that runs out fails once, not once per attempt, and stops retrying at the bound", async () => {
  const started = Date.now();
  const { calls, events, outcome } = await run(
    { reconnect: { maxAttempts: 100, baseDelayMs: 10, maxDelayMs: 10, maxTotalMs: 120 } },
    async () => { throw new TypeError("connection refused"); },
  );
  await assert.rejects(outcome, (error: Error & { code?: string }) => error.code === "network-error");
  assert.ok(Date.now() - started < 600, "bounded by maxTotalMs, not by the attempt count");
  assert.ok(calls.length >= 3 && calls.length < 100);
  assert.equal(events.filter((event) => event.type === "activity").length, calls.length - 1, "one retry notice per retry, none after the last");
});

test("an open stream that goes silent is aborted and resumed from the last event id", async () => {
  const { calls, events, outcome } = await run(
    { reconnect: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, idleTimeoutMs: 40, headersTimeoutMs: 0 } },
    async (_call, attempt) => {
      if (attempt > 1) return new Response(delta(2, " two") + done(3, "one two"), { headers: sse });
      // Sends one frame, then neither data nor close: the shape of a backend that died mid-stream.
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(delta(1, "one"))); } }), { headers: sse });
    },
  );
  assert.equal((await outcome).content, "one two");
  assert.equal(calls[1]?.lastEventId, "1");
  assert.deepEqual(events.filter((event) => event.type === "assistant-output-delta").map((event) => event.delta), ["one", " two"]);
});

test("headers that never arrive are abandoned after headersTimeoutMs and retried", async () => {
  const { calls, outcome } = await run(
    { reconnect: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, headersTimeoutMs: 30, idleTimeoutMs: 0 } },
    (_call, attempt, signal) => attempt > 1
      ? Promise.resolve(new Response(done(1, "late"), { headers: sse }))
      : new Promise<Response>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }),
  );
  assert.equal((await outcome).content, "late");
  assert.equal(calls.length, 2);
});

test("a stream-reset header discards what was drawn before the replay, and the replay starts from event 0", async () => {
  const { calls, events, outcome } = await run(
    { streamReset: { header: "x-test-stream" }, reconnect: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
    async (_call, attempt) => {
      if (attempt === 1) {
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) { if (!sent) { sent = true; controller.enqueue(encoder.encode(delta(7, "partial"))); } else controller.error(new TypeError("reset")); },
        }), { headers: sse });
      }
      return new Response(delta(1, "fresh") + done(2, "fresh"), { headers: { ...sse, "x-test-stream": "reset" } });
    },
  );
  assert.equal((await outcome).content, "fresh");
  assert.equal(calls[1]?.lastEventId, "7", "the resume asked to continue; the server answered with a reset");
  const types = events.map((event) => event.type === "assistant-output-delta" ? `delta:${event.delta}` : event.type);
  assert.deepEqual(types.filter((type) => type !== "activity"), ["delta:partial", "stream-reset", "delta:fresh"]);
});

test("without the configured header nothing is reset", async () => {
  const { events, outcome } = await run({}, async () => new Response(done(1, "ok"), { headers: { ...sse, "x-test-stream": "reset" } }));
  await outcome;
  assert.equal(events.some((event) => event.type === "stream-reset"), false);
});

test("a resend of a failed request resumes from where it stopped, with the identical body", async () => {
  let failing = true;
  const first = await run({ reconnect: false }, async (_call, attempt) => {
    if (attempt === 1) {
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) { if (!sent) { sent = true; controller.enqueue(encoder.encode(delta(4, "x"))); } else controller.error(new TypeError("reset")); },
      }), { headers: sse });
    }
    if (failing) throw new TypeError("down");
    return new Response(done(5, "x"), { headers: sse });
  });
  await assert.rejects(first.outcome);
  failing = false;
  const controller = new AbortController();
  const again = await first.transport.send({ content: "hi", sessionId: "s", requestId: "req-1", attachments: [] }, {
    operation: "turn", sessionId: "s", requestId: "req-1", signal: controller.signal, onEvent: () => undefined,
  });
  assert.equal(again.content, "x");
  assert.equal(first.calls.length, 2);
  assert.equal(first.calls[1]?.lastEventId, "4");
  assert.equal(first.calls[1]?.body, first.calls[0]?.body);
});

test("heartbeats keep a slow but live stream open past the idle limit", async () => {
  const { calls, outcome } = await run(
    { reconnect: { maxAttempts: 0, idleTimeoutMs: 50, headersTimeoutMs: 0 } },
    async () => {
      let beats = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => { setTimeout(resolve, 20); });
          if (beats++ < 8) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          else { controller.enqueue(encoder.encode(done(1, "slow"))); controller.close(); }
        },
      }), { headers: sse });
    },
  );
  assert.equal((await outcome).content, "slow");
  assert.equal(calls.length, 1, "silence was never longer than the limit, so nothing was aborted");
});
