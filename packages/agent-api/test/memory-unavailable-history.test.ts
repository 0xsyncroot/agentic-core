import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryService } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { BaseMemoryContextPolicy, createMemoryPlugin } from "@0xsyncroot/plugins-base";
import { activeHost, answer, scriptedModel, security, SpyStore } from "../../core/test/turn-harness.js";
import { visibleMessages } from "../src/history-view.js";

/**
 * A turn whose memory store is down journals `memory/context-unavailable`. That row is an operator signal: the
 * model's messages and the history a user reads must be what a session with no memory at all produces.
 */

async function twoTurns(search: MemoryService["search"] | undefined) {
  const store: MemoryService = { propose: async () => { throw new Error("not used"); }, forget: async () => false, search: search ?? (async () => { throw new Error("must not be asked"); }) };
  const { adapter, requests } = scriptedModel([answer("Mot."), answer("Hai.")]);
  const { host, router } = await activeHost(adapter, [createMemoryPlugin(store)]);
  try {
    const loop = new DefaultAgentLoop(router, new SpyStore(), {}, { memoryContextPolicy: new BaseMemoryContextPolicy() });
    const identity = security({ permissions: new Set(["tool.echo", ...(search ? ["memory.read"] : [])]) });
    const sessionId = `memory-history-${Math.random()}`;
    const first = await loop.runTurn({ sessionId, content: "cau mot", security: identity });
    const second = await loop.runTurn({ sessionId, content: "cau hai", security: identity });
    return { requests, events: [...first.events, ...second.events] };
  } finally { await host.shutdown(); }
}

test("history and the model's messages are the same with the memory store down as with no memory.read", async () => {
  const down = await twoTurns(async () => { throw new Error("memory down"); });
  const none = await twoTurns(undefined);
  assert.equal(down.events.filter((event) => event.type === "memory/context-unavailable").length, 2, "the down session journals the row on both turns");
  assert.deepEqual(none.events.filter((event) => event.type.startsWith("memory/")), [], "the session without memory.read journals none");
  assert.deepEqual(down.requests.map((request) => request.messages), none.requests.map((request) => request.messages), "the model's messages");
  // Ids, timestamps and the measured duration differ between any two runs.
  const withoutIds = (messages: readonly Record<string, unknown>[]) => messages.map(({ id: _id, turnId: _turnId, at: _at, work, ...rest }) => {
    const { durationMs: _durationMs, ...stable } = (work ?? {}) as Record<string, unknown>;
    return { ...rest, ...(work ? { work: stable } : {}) } as Record<string, unknown>;
  });
  const shown = withoutIds(visibleMessages(down.events));
  assert.deepEqual(shown.map((message) => message.role), ["user", "assistant", "user", "assistant"], "both turns are shown, and only as messages");
  assert.deepEqual(shown, withoutIds(visibleMessages(none.events)), "visibleMessages");
});
