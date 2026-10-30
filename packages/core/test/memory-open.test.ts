import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { AgenticError, assertValidCoreEventDraft, type MemoryContext, type MemoryService, type SessionEvent } from "@0xsyncroot/contracts";
import { DEFAULT_AGENT_OPTIONS, DefaultAgentLoop } from "@0xsyncroot/core";
import { BaseMemoryContextPolicy, createMemoryPlugin } from "@0xsyncroot/plugins-base";
import { recallMemory } from "../src/agent/turn-open-waits.js";
import { activeHost, answer, scriptedModel, security, SpyStore } from "./turn-harness.js";

/**
 * Memory recall at turn open is advisory context. A store that rejects or hangs costs the turn its memory, never the turn: the
 * model is still asked, one `memory/context-unavailable` row says why, and only the turn's own abort ends it: a rejection
 * never fails the turn, and a hang never holds it, with its lease renewed, until the process restarts.
 */

const reader = security({ permissions: new Set(["tool.echo", "memory.read"]) });
const noRecords: MemoryContext = { records: [], contextText: "", contextHash: "h0" };
const unavailable = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "memory/context-unavailable");
const types = (events: readonly SessionEvent[]) => events.map((event) => event.type);

interface Run { readonly searches: number; readonly modelCalls: number; readonly messages: unknown; readonly events: readonly SessionEvent[]; readonly error: unknown; readonly ms: number }

async function run(search: MemoryService["search"], options: Record<string, unknown> = {}, extra: { readonly identity?: ReturnType<typeof security>; readonly signal?: AbortSignal; readonly routeDown?: boolean } = {}): Promise<Run> {
  let searches = 0;
  const store: MemoryService = {
    propose: async () => { throw new Error("not used"); }, forget: async () => false,
    search: (query, identity) => { searches += 1; return search(query, identity); },
  };
  const { adapter, requests } = scriptedModel([answer("Xong.")]);
  if (extra.routeDown) adapter.resolveModel = async () => { throw new AgenticError("transient", "route down"); };
  const { host, router } = await activeHost(adapter, [createMemoryPlugin(store)]);
  const started = performance.now();
  try {
    const sessionId = `memory-open-${Math.random()}`;
    const settled = await new DefaultAgentLoop(router, new SpyStore(), options, { memoryContextPolicy: new BaseMemoryContextPolicy() })
      .runTurn({ sessionId, content: "--- * \"x\" phụ cấp", security: extra.identity ?? reader, ...(extra.signal ? { signal: extra.signal } : {}) })
      .then((result) => ({ events: result.events, error: undefined }), (error: unknown) => ({ events: [] as readonly SessionEvent[], error }));
    return { searches, modelCalls: requests.length, messages: requests.map((request) => request.messages), ms: performance.now() - started, ...settled };
  } finally { await host.shutdown(); }
}

const bounds = (event: SessionEvent) => {
  const payload = event.payload as { reason: string; code?: string; message: string };
  assert.doesNotThrow(() => assertValidCoreEventDraft({ type: event.type, turnId: event.turnId!, payload: event.payload }));
  assert.ok(payload.message.length <= 300, "message is cut to 300");
  assert.ok((payload.code?.length ?? 0) <= 64, "code is cut to 64");
  return payload;
};

test("a search that rejects costs the turn its memory, not the turn: it answers and one valid row says why, before the route", async () => {
  const causes: readonly { readonly name: string; readonly thrown: unknown; readonly expect: { readonly code?: string; readonly message: string } }[] = [
    { name: "MySQL parse error", thrown: Object.assign(new Error("syntax error, unexpected '-' | statement: SELECT r.id"), { code: "ER_PARSE_ERROR", errno: 1064 }),
      expect: { code: "ER_PARSE_ERROR", message: "syntax error, unexpected '-' | statement: SELECT r.id" } },
    { name: "transient connection loss", thrown: new AgenticError("transient", "MySQL connections kept failing before the transaction could start", true),
      expect: { code: "transient", message: "MySQL connections kept failing before the transaction could start" } },
    { name: "a rejection that is not an Error", thrown: undefined, expect: { message: "undefined" } },
    { name: "an Error with no message", thrown: new Error(), expect: { message: "" } },
    { name: "a 1,000-character message and a 100-character code", thrown: Object.assign(new Error("m".repeat(1_000)), { code: "c".repeat(100) }),
      expect: { code: "c".repeat(64), message: "m".repeat(300) } },
    { name: "a code that is not a string", thrown: Object.assign(new Error("lost"), { code: 1064 }), expect: { message: "lost" } },
  ];
  for (const cause of causes) {
    const result = await run(async () => { throw cause.thrown; });
    assert.equal(result.error, undefined, `${cause.name}: the turn did not fail`);
    assert.equal(result.searches, 1, `${cause.name}: asked once`);
    assert.ok(result.modelCalls >= 1, `${cause.name}: the model was asked`);
    const rows = unavailable(result.events);
    assert.equal(rows.length, 1, `${cause.name}: exactly one row`);
    assert.deepEqual(bounds(rows[0]!), { reason: "error", ...cause.expect }, cause.name);
    assert.ok(!types(result.events).includes("turn/failed") && !types(result.events).includes("memory/context-selected"), cause.name);
    assert.ok(types(result.events).indexOf("memory/context-unavailable") < types(result.events).indexOf("model/route-selected"), `${cause.name}: before the route`);
  }
});

test("a search that hangs is cut at memoryContextTimeoutMs: the turn answers without memory and says timeout", async () => {
  const result = await run(() => new Promise<MemoryContext>(() => undefined), { memoryContextTimeoutMs: 200 });
  assert.equal(result.error, undefined);
  assert.equal(result.searches, 1);
  assert.equal(result.modelCalls, 1);
  assert.ok(result.ms >= 190, `waited the bound before moving on (${Math.round(result.ms)} ms)`);
  const rows = unavailable(result.events);
  assert.equal(rows.length, 1);
  assert.deepEqual(bounds(rows[0]!), { reason: "timeout", message: "Memory search exceeded 200 ms" });
});

test("the memory wait is bounded by default at 5,000 ms, and by the turn's own clock when that is shorter", async () => {
  assert.equal(DEFAULT_AGENT_OPTIONS.memoryContextTimeoutMs, 5_000);
  const result = await run(() => new Promise<MemoryContext>(() => undefined), { turnTimeoutMs: 500, memoryContextTimeoutMs: 30_000 });
  assert.equal(result.error, undefined, "the silence guard ends the turn unfinished, not failed");
  const end = result.events.at(-1)!;
  assert.deepEqual([end.type, (end.payload as { status?: string }).status, (end.payload as { reason?: string }).reason], ["turn/end", "partial", "time-limit"]);
  assert.equal(result.searches, 1);
  assert.equal(result.modelCalls, 0);
  assert.ok(result.ms >= 450 && result.ms < 3_000, `ended by the turn's 500 ms clock, neither at once nor hung (${Math.round(result.ms)} ms)`);
});

test("a client cancel during the search ends the turn cancelled: an abort is never swallowed", async () => {
  const controller = new AbortController();
  const reason = new Error("Turn cancelled by the client");
  // The cancel is raised from inside the hanging search, so it lands while the turn waits on memory, however long the turn took to start.
  const result = await run(() => { controller.abort(reason); return new Promise<MemoryContext>(() => undefined); }, { memoryContextTimeoutMs: 30_000 }, { signal: controller.signal });
  assert.equal(result.searches, 1, "the search had started");
  assert.equal((result.error as Error).cause, reason, "the turn failed with the client's own reason, as any abort does");
  assert.equal(result.modelCalls, 0);
  assert.ok(result.ms < 3_000, `${Math.round(result.ms)} ms`);
});

test("a search that rejects after the bound raised no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectLate!: (error: Error) => void;
    const result = await run(() => new Promise<MemoryContext>((_resolve, reject) => { rejectLate = reject; }), { memoryContextTimeoutMs: 100 });
    assert.equal(unavailable(result.events).length, 1);
    rejectLate(new Error("connection reset after the bound"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("the wait leaves nothing behind: the timer is cleared and the abort listener removed on every outcome", async () => {
  const query = { text: "x", scopes: [], limit: 1 };
  const identity = reader;
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const baseline = timers();
  const controller = new AbortController();
  const listeners = () => getEventListeners(controller.signal, "abort").length;
  const resolves = await recallMemory({ search: async () => noRecords }, query, identity, controller.signal, 60_000);
  assert.deepEqual(resolves, { context: noRecords });
  const rejects = await recallMemory({ search: async () => { throw new Error("down"); } }, query, identity, controller.signal, 60_000);
  assert.deepEqual(rejects, { unavailable: { reason: "error", message: "down" } });
  const times = await recallMemory({ search: () => new Promise<MemoryContext>(() => undefined) }, query, identity, controller.signal, 20);
  assert.deepEqual(times, { unavailable: { reason: "timeout", message: "Memory search exceeded 20 ms" } });
  assert.equal(timers(), baseline, "no timer left running");
  assert.equal(listeners(), 0, "no abort listener left on the turn's signal");
  const gone = new AbortController();
  const reason = new Error("gone");
  const pending = recallMemory({ search: () => new Promise<MemoryContext>(() => undefined) }, query, identity, gone.signal, 60_000);
  gone.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(getEventListeners(gone.signal, "abort").length, 0);
  assert.equal(timers(), baseline);
  let asked = 0;
  await assert.rejects(recallMemory({ search: async () => { asked += 1; return noRecords; } }, query, identity, gone.signal, 60_000), (error) => error === reason);
  assert.equal(asked, 0, "an aborted turn does not ask");
});

test("a route that fails still fails the turn, memory or not", async () => {
  const result = await run(async () => noRecords, {}, { routeDown: true });
  assert.match(String((result.error as Error | undefined)?.message), /route down/u);
  assert.equal(result.modelCalls, 0);
});

test("an identity without memory.read asks no store; one with it keeps today's selected row", async () => {
  const plain = await run(async () => { throw new Error("must not be asked"); }, {}, { identity: security() });
  assert.equal(plain.error, undefined);
  assert.equal(plain.searches, 0);
  assert.equal(plain.modelCalls, 1);
  assert.deepEqual(types(plain.events).filter((type) => type.startsWith("memory/")), []);

  const selected = await run(async () => ({ records: [], contextText: "remembered", contextHash: "h1" }));
  assert.equal(selected.searches, 1);
  assert.deepEqual(types(selected.events).filter((type) => type.startsWith("memory/")), ["memory/context-selected"]);
  assert.deepEqual(unavailable(selected.events), []);
});

test("without its memory the model sees what it sees when no store is asked: the row is journal-only", async () => {
  const down = await run(async () => { throw new Error("memory down"); });
  const timedOut = await run(() => new Promise<MemoryContext>(() => undefined), { memoryContextTimeoutMs: 100 });
  const none = await run(async () => noRecords, {}, { identity: security() });
  assert.equal(unavailable(down.events).length + unavailable(timedOut.events).length, 2);
  assert.deepEqual(down.messages, none.messages);
  assert.deepEqual(timedOut.messages, none.messages);
});
