import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { AgentProgressEvent, SessionEvent } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { SpyStore, activeHost, answer, call, planningPlugin, planStep, scriptedModel, security, toolPlugin, writeTool } from "./turn-harness.js";

/**
 * The user talking while the agent is still working.
 *
 * What these pin down is not that the words reach the model — a side channel would do that too —
 * but *how*: as an ordinary `user/input` in the journal, at the boundary where it was applied.
 * That is what makes the correction visible afterwards to the person, the auditor and the next
 * turn, instead of being a whisper that changed an answer with nothing anywhere recording it.
 */

function userMessages(request: { readonly messages: readonly { readonly role: string; readonly content: string | null }[] }): readonly string[] {
  return request.messages.filter((message) => message.role === "user").map((message) => message.content ?? "");
}

function journalOf(events: readonly SessionEvent[], source: string): readonly string[] {
  return events
    .filter((event) => event.type === "user/input" && (event.payload as Record<string, unknown>).source === source)
    .map((event) => String((event.payload as Record<string, unknown>).content));
}

test("what the user adds mid-turn reaches the next step, as their own message in the journal", async () => {
  const store = new SpyStore();
  const pending: string[] = [];
  const { adapter, requests } = scriptedModel([
    // Said while this step is in flight: the user watching the trace sees the wrong sheet go by.
    () => { pending.push("nhầm sheet rồi, lấy ở PT CTX"); return call("c1", "agentic_echo", { value: "reading" })(); },
    answer("đã sửa theo anh/chị"),
  ]);
  const { router } = await activeHost(adapter, [createEchoToolPlugin()]);
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(router, store).runTurn({
    sessionId: "s1", content: "lập biểu chi thường xuyên", security: security(),
    interjections: { take: () => pending.splice(0, pending.length) },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.outcome, "completed");

  // Not in the step that was already running when it was typed, and present in the next one.
  assert.ok(!userMessages(requests[0]!).some((content) => content.includes("PT CTX")), "the step already in flight must not be rewritten");
  assert.ok(userMessages(requests[1]!).some((content) => content.includes("nhầm sheet rồi, lấy ở PT CTX")),
    `the next step should carry it: ${JSON.stringify(userMessages(requests[1]!))}`);

  // As a user message in the transcript, not as transient step feedback — the whole point.
  const events = await store.inner.load("s1", security());
  assert.deepEqual(journalOf(events, "interjection"), ["nhầm sheet rồi, lấy ở PT CTX"]);
  assert.deepEqual(journalOf(events, "external"), ["lập biểu chi thường xuyên"]);

  // Reported at the boundary it was applied at, carrying the words back for a second viewer.
  const received = progress.filter((event) => event.type === "interjection-received");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.type === "interjection-received" && received[0].step, 2);
  assert.equal(received[0]!.type === "interjection-received" && received[0].content, "nhầm sheet rồi, lấy ở PT CTX");
});

test("a turn nobody interrupts is byte-for-byte the turn it always was", async () => {
  const store = new SpyStore();
  const { adapter, requests } = scriptedModel([call("c1", "agentic_echo", { value: "reading" }), answer("xong")]);
  const { router } = await activeHost(adapter, [createEchoToolPlugin()]);
  const progress: AgentProgressEvent[] = [];
  await new DefaultAgentLoop(router, store).runTurn({
    sessionId: "s2", content: "lập biểu", security: security(),
    interjections: { take: () => [] },
    onProgress: (event) => progress.push(event),
  });
  const events = await store.inner.load("s2", security());
  assert.deepEqual(journalOf(events, "interjection"), []);
  assert.equal(progress.filter((event) => event.type === "interjection-received").length, 0);
  assert.equal(requests.length, 2);
});

test("several interjections keep the order they were said in, and are read exactly once", async () => {
  const store = new SpyStore();
  const pending: string[] = [];
  const { adapter, requests } = scriptedModel([
    () => { pending.push("một", "hai"); return call("c1", "agentic_echo", { value: "a" })(); },
    call("c2", "agentic_echo", { value: "b" }),
    answer("xong"),
  ]);
  const { router } = await activeHost(adapter, [createEchoToolPlugin()]);
  await new DefaultAgentLoop(router, store).runTurn({
    sessionId: "s3", content: "bắt đầu", security: security(),
    interjections: { take: () => pending.splice(0, pending.length) },
  });
  const events = await store.inner.load("s3", security());
  assert.deepEqual(journalOf(events, "interjection"), ["một", "hai"]);
  // Read once, not re-applied at every later boundary: a correction repeated on each step would
  // read to the model as the user saying it again, and each repeat as fresh insistence.
  const third = userMessages(requests[2]!).filter((content) => content === "một").length;
  assert.equal(third, 1, "the third step should still see it exactly once, from the journal");
});

test("a correction arriving during the final response replaces the draft in the same turn", async () => {
  const store = new SpyStore();
  const pending = ["đọc tháng 9"];
  const { adapter, requests } = scriptedModel([
    () => { pending.push("sửa lại: tháng 8"); return answer("đã mở tháng 9")(); },
    answer("đã mở tháng 8"),
  ]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, store).runTurn({
      sessionId: "final-correction", content: "mở bảng", security: security(),
      interjections: { take: () => pending.splice(0) },
    });
    assert.equal(result.content, "đã mở tháng 8");
    assert.equal(requests.length, 2);
    assert.ok(userMessages(requests[1]!).includes("sửa lại: tháng 8"));
    assert.deepEqual(journalOf(result.events, "interjection"), ["đọc tháng 9", "sửa lại: tháng 8"]);
    assert.equal(result.events.filter((event) => event.type === "usage/recorded").length, 2);
    assert.equal(result.events.some((event) => event.type === "assistant/message" &&
      (event.payload as Record<string, unknown>).content === "đã mở tháng 9"), false);
  } finally { await host.shutdown(); }
});

test("a correction received after the model prevents its stale proposed write and approval card", async () => {
  const pending: string[] = [];
  let writes = 0;
  const { adapter } = scriptedModel([
    () => { pending.push("đừng ghi nữa"); return call("stale-write", "test_write", { value: "a" })(); },
    answer("đã dừng thao tác ghi"),
  ]);
  const { host, router } = await activeHost(adapter, [toolPlugin("write", [writeTool(() => { writes += 1; })])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({
      sessionId: "correct-before-approval", content: "ghi", security: security(),
      interjections: { take: () => pending.splice(0) },
    });
    assert.equal(result.outcome, "completed");
    assert.equal(writes, 0);
    assert.equal(result.events.some((event) => event.type === "approval/requested" || event.type === "tool/intent"), false);
  } finally { await host.shutdown(); }
});

test("when no step remains to apply a correction it stays queued for the edge to return", async () => {
  const pending: string[] = [];
  const { adapter, requests } = scriptedModel([() => { pending.push("đổi tháng"); return answer("chưa xác minh")(); }]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 1 }).runTurn({
      sessionId: "late-at-limit", content: "mở", security: security(), interjections: { take: () => pending.splice(0) },
    });
    assert.equal(requests.length, 1);
    assert.equal(result.outcome, "partial");
    assert.deepEqual(pending, ["đổi tháng"]);
    assert.deepEqual(journalOf(result.events, "interjection"), []);
  } finally { await host.shutdown(); }
});

test("empty response recovery keeps tools available and can finish the requested work", async () => {
  const { adapter, requests } = scriptedModel([answer(""), call("read-after-empty", "agentic_echo", { value: "checked" }), answer("checked")]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "empty-recovery", content: "read", security: security() });
    assert.equal(requests[1]!.tools.length, 1);
    assert.notEqual(requests[1]!.toolChoice, "none");
    assert.equal(requests[1]!.messages.some((message) => message.content?.includes("No tools remain")), false);
    assert.equal(result.outcome, "completed");
    assert.equal(result.events.filter((event) => event.type === "tool/result").length, 1);
    assert.equal(result.content, "checked");
  } finally { await host.shutdown(); }
});

test("a productive turn completes beyond 32 steps, under its step ceiling, without losing its tools", async () => {
  const replies = Array.from({ length: 42 }, (_, index) => call(`read-${index}`, "agentic_echo", { value: `page-${index}` }));
  const { adapter, requests } = scriptedModel([...replies, answer("all checked")]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxToolCalls: 64 }).runTurn({
      sessionId: "productive-long-turn", content: "read all", security: security(),
    });
    assert.equal(result.outcome, "completed");
    assert.equal(requests.length, 43);
    assert.ok(requests.every((request) => request.tools.length === 1));
    assert.equal(result.events.filter((event) => event.type === "tool/result" && (event.payload as Record<string, unknown>).state === "succeeded").length, 42);
  } finally { await host.shutdown(); }
});

test("a productive turn still stops at the tool budget and reports the actual cause", async () => {
  // Eight calls configured, every one bringing something new: the ninth step has no tools.
  const { adapter, requests } = scriptedModel([
    ...[..."abcdefgh"].map((value, index) => call(`c${index}`, "agentic_echo", { value })), answer("eight checked; more remain"),
  ]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48, maxToolCalls: 8 }).runTurn({
      sessionId: "tool-budget", content: "read all", security: security(),
    });
    assert.equal(result.outcome, "partial");
    assert.equal(requests[8]!.tools.length, 0);
    assert.equal((result.events.at(-1)!.payload as Record<string, unknown>).reason, "tool-call-limit");
  } finally { await host.shutdown(); }
});

test("a numeric step ceiling produces partial even when the final model response contains prose", async () => {
  const { adapter } = scriptedModel([
    call("c1", "agentic_echo", { value: "a" }), call("c2", "agentic_echo", { value: "b" }), answer("some read; remainder unverified"),
  ]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 3 }).runTurn({
      sessionId: "step-ceiling", content: "read all", security: security(),
    });
    assert.equal(result.outcome, "partial");
    assert.equal((result.events.at(-1)!.payload as Record<string, unknown>).reason, "step-limit");
  } finally { await host.shutdown(); }
});

test("two empty responses end partial with an empty-response cause, never invented business prose", async () => {
  const { adapter, requests } = scriptedModel([answer(""), answer("")]);
  const { host, router } = await activeHost(adapter, []);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "silent-twice", content: "read", security: security() });
    assert.equal(requests.length, 2);
    assert.equal(result.content, "");
    assert.equal(result.outcome, "partial");
    assert.equal((result.events.at(-1)!.payload as Record<string, unknown>).reason, "empty-response");
  } finally { await host.shutdown(); }
});

test("tool proposals after a resource stop are never delivered as a final progress promise", async () => {
  const { adapter, requests } = scriptedModel([
    call("read", "agentic_echo", { value: "a" }, "Em sẽ đọc tiếp."),
    call("retry", "agentic_echo", { value: "b" }, "Em đang đọc tiếp."),
  ]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 1 }).runTurn({
      sessionId: "tool-proposal-at-stop", content: "read all", security: security(),
    });
    assert.equal(requests.length, 2);
    assert.equal(result.content, "");
    assert.equal(result.outcome, "partial");
    assert.equal(result.events.some((event) => event.type === "tool/intent"), false);
    assert.equal((result.events.at(-1)!.payload as Record<string, unknown>).reason, "step-limit");
  } finally { await host.shutdown(); }
});

test("an opening plan announcement is never returned as completed work when the model goes silent", async () => {
  const steps = [{ id: "read", description: "Đọc màn hình", status: "in_progress" }];
  const { adapter, requests } = scriptedModel([
    planStep("plan", "read", steps, "Em sẽ đọc màn hình."), answer(""),
    call("read", "agentic_echo", { value: "screen evidence" }), answer("Đã đọc màn hình."),
  ]);
  const { host, router } = await activeHost(adapter, [createEchoToolPlugin(), planningPlugin()]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 48 }).runTurn({
      sessionId: "silent-after-plan", content: "read", security: security(),
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.content, "Đã đọc màn hình.");
    assert.equal(requests.length, 4);
    assert.ok(requests[2]!.tools.some((tool) => tool.name === "agentic_echo"));
    assert.equal(result.events.filter((event) => event.type === "tool/result" &&
      (event.payload as Record<string, unknown>).toolId === "agentic_echo").length, 1);
  } finally { await host.shutdown(); }
});
