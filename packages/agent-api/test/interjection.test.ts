import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { IdentityEvidence, ResumableAgent, RunTurnResult, SecurityContext } from "@0xsyncroot/contracts";
import { createAgentApiFastify } from "../src/fastify/agent-api-fastify.js";
import { InMemoryResumableAgentStreamRegistry } from "../src/in-memory-stream-registry.js";
import { InterjectionQueue, MAX_PENDING_INTERJECTIONS } from "../src/interjection-queue.js";
import { interjectInput, MAX_INTERJECTION_CHARS } from "../src/chat-input.js";
import type { AgentApiRuntime } from "../src/agent-api-handler.js";

/**
 * Delivering a sentence the user typed into a turn that is already running.
 *
 * The property worth holding on to is not that it usually arrives — it is that when it does not,
 * the caller is told. A queue that silently dropped the ninth sentence, or accepted one for a turn
 * that had already ended, would leave someone waiting for an agent that will never read it.
 */

const key = { tenantId: "tenant-a", actorId: "actor-a", sessionId: "session-a", requestId: "request-a" };

function bodyRequest(payload: unknown): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.headers["content-type"] = "application/json";
  request.push(JSON.stringify(payload));
  request.push(null);
  return request;
}

test("the queue keeps what it was given, in order, and hands it over exactly once", () => {
  const queue = new InterjectionQueue(3);
  assert.equal(queue.offer("một"), true);
  assert.equal(queue.offer("hai"), true);
  assert.deepEqual(queue.take(), ["một", "hai"]);
  assert.deepEqual(queue.take(), [], "taking twice must not replay what was already read");
  assert.equal(queue.pending, 0);
});

test("the queue refuses past its bound rather than growing without one", () => {
  const queue = new InterjectionQueue(2);
  assert.deepEqual([queue.offer("a"), queue.offer("b"), queue.offer("c")], [true, true, false]);
  assert.deepEqual(queue.take(), ["a", "b"]);
  assert.equal(queue.offer("c"), true, "room freed by a read is room again");
});

test("an interjection reaches the run that is holding the operation, and is refused once it ends", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  const read: string[][] = [];
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const { operation } = await registry.acquire({
    key, fingerprint: "f",
    run: async (publish, _signal, interjections) => {
      await finished;
      read.push([...interjections.take()]);
      publish("result", { ok: true });
    },
  });
  operation.start();
  assert.equal(await registry.interject(key, "đơn vị là xã Đơn Vị Mẫu"), true);
  release();
  await operation.finished;
  assert.deepEqual(read, [["đơn vị là xã Đơn Vị Mẫu"]]);
  assert.equal(await registry.interject(key, "quá muộn"), false, "a finished turn has no boundary left to read it at");
  await registry.close();
});

test("an interjection for a turn this process never started is refused, not queued for nobody", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  assert.equal(await registry.interject(key, "xin chào"), false);
  await registry.close();
});

test("a turn already holding all it will read refuses the next one", async () => {
  const registry = new InMemoryResumableAgentStreamRegistry();
  const { operation } = await registry.acquire({
    key, fingerprint: "f",
    run: async (_publish, signal) => { await new Promise((resolve) => signal.addEventListener("abort", resolve)); },
  });
  operation.start();
  const accepted: boolean[] = [];
  for (let index = 0; index <= MAX_PENDING_INTERJECTIONS; index += 1) accepted.push(await registry.interject(key, `note ${index}`));
  assert.equal(accepted.filter(Boolean).length, MAX_PENDING_INTERJECTIONS);
  assert.equal(accepted.at(-1), false);
  await registry.close();
});

test("the request body is bounded where a refusal can still reach whoever typed it", async () => {
  const valid = await interjectInput(bodyRequest({ sessionId: "session-a", requestId: "request-a", content: " lấy ở sheet PT CTX \r\n" }));
  assert.equal(valid.content, "lấy ở sheet PT CTX", "trimmed and newline-normalized like the turn's own content");
  await assert.rejects(interjectInput(bodyRequest({ sessionId: "session-a", requestId: "request-a", content: "   " })), /must not be empty/u);
  await assert.rejects(interjectInput(bodyRequest({ sessionId: "session-a", requestId: "request-a", content: 42 })), /content is invalid/u);
  await assert.rejects(
    interjectInput(bodyRequest({ sessionId: "session-a", requestId: "request-a", content: "x".repeat(MAX_INTERJECTION_CHARS + 1) })),
    /exceeds 4000 characters/u,
  );
  await assert.rejects(interjectInput(bodyRequest({ sessionId: "bad/id", requestId: "request-a", content: "hi" })), /sessionId is invalid/u);
});

test("the route answers whether the turn took it", async () => {
  const runtime: AgentApiRuntime = {
    agent: {
      runTurn: async (input): Promise<RunTurnResult> =>
        ({ sessionId: input.sessionId, turnId: "turn-a", content: "ok", outcome: "completed", events: [] } as unknown as RunTurnResult),
      resumeTurn: async () => { throw new Error("not used"); },
      resumeInteraction: async () => { throw new Error("not used"); },
    } as ResumableAgent,
    identityResolver: { resolve: async (evidence: IdentityEvidence): Promise<SecurityContext> =>
      ({ tenantId: "tenant-a", actorId: "actor-a", permissions: new Set(["*"]), correlationId: evidence.correlationId, purpose: "test" }) },
    sessions: { loadRecent: async () => [] },
  };
  const app = createAgentApiFastify(runtime);
  try {
    // Nothing running under that requestId: 200 and `accepted: false`, never a 202 that would let
    // a widget render the sentence as delivered.
    const missed = await app.inject({
      method: "POST", url: "/api/chat/interject", headers: { "content-type": "application/json" },
      payload: { sessionId: "session-a", requestId: "request-a", content: "bổ sung" },
    });
    assert.equal(missed.statusCode, 200);
    assert.deepEqual(missed.json(), { accepted: false });

    const empty = await app.inject({
      method: "POST", url: "/api/chat/interject", headers: { "content-type": "application/json" },
      payload: { sessionId: "session-a", requestId: "request-a", content: "" },
    });
    assert.equal(empty.statusCode, 400);
  } finally { await app.close(); }
});

test("closing a queue returns unread input, refuses later offers and is idempotent", async () => {
  const queue = new InterjectionQueue();
  queue.offer("accepted too late");
  const closed = queue.close();
  assert.equal(queue.offer("after close"), false);
  assert.deepEqual(await closed, ["accepted too late"]);
  assert.deepEqual(await queue.close(), ["accepted too late"]);
});

test("remote collection never drains more than fits and closing returns the remaining accepted input", async () => {
  const remote = ["b", "c", "d"];
  const queue = new InterjectionQueue(2, {
    drain: async (room) => remote.splice(0, room), close: async () => remote.splice(0),
  });
  queue.offer("a");
  await queue.collect();
  assert.deepEqual(remote, ["c", "d"]);
  assert.equal(queue.offer("overflow"), false);
  assert.deepEqual(await queue.close(), ["a", "b", "c", "d"]);
});

test("close waits for an in-flight remote drain and retains its input exactly once", async () => {
  let release!: () => void;
  const inFlight = new Promise<void>((resolve) => { release = resolve; });
  const queue = new InterjectionQueue(2, { drain: async () => { await inFlight; return ["remote"]; }, close: async () => ["later"] });
  const collecting = queue.collect();
  await Promise.resolve();
  assert.equal(queue.offer("during drain"), false, "space already reserved for remote acceptance cannot be overwritten");
  const closing = queue.close();
  release();
  await collecting;
  assert.deepEqual(await closing, ["remote", "later"]);
});

test("the public stream returns unread accepted input on success and failure", async () => {
  for (const fail of [false, true]) {
    const registry = new InMemoryResumableAgentStreamRegistry();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const runtime: AgentApiRuntime = {
      agent: { runTurn: async (input): Promise<RunTurnResult> => {
        started(); await finished;
        if (fail) throw new Error("source failed");
        return { sessionId: input.sessionId, turnId: "t", content: "ok", outcome: "completed", events: [] };
      } } as ResumableAgent,
      identityResolver: { resolve: async (): Promise<SecurityContext> =>
        ({ tenantId: key.tenantId, actorId: key.actorId, permissions: new Set(["*"]), correlationId: "c", purpose: "test" }) },
      sessions: { loadRecent: async () => [] },
    };
    const app = createAgentApiFastify(runtime, { streamRegistry: registry });
    try {
      const response = app.inject({ method: "POST", url: "/api/chat/stream", payload: { ...key, content: "read" } });
      await running;
      assert.equal(await registry.interject(key, "late correction"), true);
      finish();
      const body = (await response).body;
      assert.match(body, /"unreadInterjections":\["late correction"\]/u);
      assert.equal(await registry.interject(key, "after terminal"), false);
    } finally { finish(); await app.close(); await registry.close(); }
  }
});

test("listeners hear input as it arrives, offered here or collected from another replica, and nothing after close", async () => {
  const remote = ["từ replica khác"];
  const queue = new InterjectionQueue(MAX_PENDING_INTERJECTIONS, { drain: async (room) => remote.splice(0, room), close: async () => [] });
  let heard = 0;
  const unsubscribe = queue.subscribe(() => { heard += 1; });
  queue.subscribe(() => { throw new Error("a listener that fails"); });
  assert.equal(queue.offer("sửa lại"), true);
  assert.equal(heard, 1, "an offer is heard, a failing listener notwithstanding");
  await queue.collect();
  assert.equal(heard, 2, "collected input is heard");
  await queue.collect();
  assert.equal(heard, 2, "a collect that brings nothing is silent");
  assert.equal(queue.pending, 2);
  unsubscribe();
  queue.offer("lần nữa");
  assert.equal(heard, 2, "an unsubscribed listener hears nothing");
  queue.subscribe(() => { heard += 1; });
  await queue.close();
  assert.equal(queue.offer("muộn"), false);
  assert.equal(heard, 2, "nothing is heard after close");
});
