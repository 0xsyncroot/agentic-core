import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@0xsyncroot/contracts";
import type { ToolTraceCall } from "../src/index.js";
import { PublicAgentStreamWriter, historyTimelines } from "../src/index.js";

/**
 * A call that ran under the user's standing approval had no card: live and on reload the product's labeller is told so, and
 * the published event carries the flag (and nothing else of the call) for a client that refreshes the setting on it.
 */
test("live: the labeller hears approvalStanding and the published event carries the flag, never the tool id", () => {
  const published: Record<string, unknown>[] = [];
  const heard: (ToolTraceCall | undefined)[] = [];
  const writer = new PublicAgentStreamWriter((_name, value) => published.push(value as Record<string, unknown>), {
    toolTrace: (_toolId, _initiator, call) => { heard.push(call); return "Writing the sheet"; },
  });
  writer.progress({ type: "tool-started", turnId: "t", step: 1, callId: "c1", toolId: "secret_tool", arguments: { a: 1 }, approvalStanding: true });
  writer.progress({ type: "tool-started", turnId: "t", step: 1, callId: "c2", toolId: "secret_tool" });
  writer.progress({ type: "tool-completed", turnId: "t", step: 1, callId: "c1", toolId: "secret_tool", status: "succeeded" });
  assert.deepEqual(heard.map((call) => call?.approvalStanding ?? null), [true, null, null]);
  assert.deepEqual(published.map((event) => event.approvalStanding ?? null), [true, null, null]);
  assert.equal(JSON.stringify(published).includes("secret_tool"), false);
});

test("reload: a call the journal shows ran under the standing approval is replayed with the flag", () => {
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>) => ({ type, turnId: "t", seq: ++seq, payload }) as unknown as SessionEvent;
  const ids = { callId: "c1", executionId: "e1", toolId: "secret_tool" };
  const events = [
    event("tool/intent", { ...ids, arguments: "{}", state: "prepared", sideEffect: "idempotent" }),
    event("tool/policy-decision", { ...ids, decisionId: "standing-1", outcome: "allow", policyRevision: "r", reason: "standing", actionDigest: "d",
      standingApproval: { revision: "rev-1", since: "2026-10-15T01:00:00.000Z" } }),
    event("tool/result", { ...ids, state: "succeeded", dispatched: true }),
    event("tool/intent", { callId: "c2", executionId: "e2", toolId: "secret_tool", arguments: "{}", state: "prepared", sideEffect: "idempotent" }),
  ];
  const heard: (boolean | null)[] = [];
  const timeline = historyTimelines(events, (_toolId, _initiator, call) => {
    if (call?.phase === "started") heard.push(call.approvalStanding ?? null);
    return "Writing the sheet";
  }).get("t") ?? [];
  assert.deepEqual(heard, [true, null]);
  assert.deepEqual(timeline.filter((item) => item.type === "tool-started").map((item) => item.approvalStanding ?? null), [true, null]);
});

/** The widget rewrites a row with the label that ends the call, so the ending is told what the start was. */
test("live: the labeller hears the flags on the ending, and the ending publishes none", () => {
  const published: Record<string, unknown>[] = [];
  const heard: [string, boolean | null, boolean | null][] = [];
  const writer = new PublicAgentStreamWriter((_name, value) => published.push(value as Record<string, unknown>), {
    toolTrace: (_toolId, _initiator, call) => { heard.push([call?.phase ?? "", call?.approvalStanding ?? null, call?.approvalReused ?? null]); return "Writing the sheet"; },
  });
  writer.progress({ type: "tool-completed", turnId: "t", step: 1, callId: "c1", toolId: "secret_tool", status: "succeeded", approvalStanding: true });
  writer.progress({ type: "tool-completed", turnId: "t", step: 1, callId: "c2", toolId: "secret_tool", status: "succeeded", approvalReused: true });
  writer.progress({ type: "tool-completed", turnId: "t", step: 1, callId: "c3", toolId: "secret_tool", status: "succeeded" });
  assert.deepEqual(heard, [["completed", true, null], ["completed", null, true], ["completed", null, null]]);
  assert.deepEqual(published.map((event) => [event.approvalStanding ?? null, event.approvalReused ?? null]), [[null, null], [null, null], [null, null]]);
});

test("reload: the result of a call the journal shows ran without a card is replayed with the same flags", () => {
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>) => ({ type, turnId: "t", seq: ++seq, payload }) as unknown as SessionEvent;
  const call = (id: string, decision?: Record<string, unknown>) => {
    const ids = { callId: id, executionId: `e-${id}`, toolId: "secret_tool" };
    return [
      event("tool/intent", { ...ids, arguments: "{}", state: "prepared", sideEffect: "idempotent" }),
      ...(decision ? [event("tool/policy-decision", { ...ids, decisionId: `d-${id}`, outcome: "allow", policyRevision: "r", reason: "x", actionDigest: "d", ...decision })] : []),
      event("tool/result", { ...ids, state: "succeeded", dispatched: true }),
    ];
  };
  const events = [...call("c1", { standingApproval: { revision: "rev-1", since: "2026-10-15T01:00:00.000Z" } }), ...call("c2", { coveredBy: "a1" }), ...call("c3", {})];
  const heard: [string, boolean | null, boolean | null][] = [];
  historyTimelines(events, (_toolId, _initiator, traced) => {
    if (traced?.phase === "completed") heard.push([traced.phase, traced.approvalStanding ?? null, traced.approvalReused ?? null]);
    return "Writing the sheet";
  });
  assert.deepEqual(heard, [["completed", true, null], ["completed", null, true], ["completed", null, null]]);
});
