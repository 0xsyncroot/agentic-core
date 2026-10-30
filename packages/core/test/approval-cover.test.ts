import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SessionEvent } from "@0xsyncroot/contracts";
import { APPROVAL_COVER_TTL_MS, coveringApproval, settleCover, type CoverCandidate } from "../src/agent/approval-cover.js";

/**
 * The same write is not asked again right after its approval. An approval covers a repeat of its call, or the part that
 * did not go through, within the task, until anything happens the user would want to weigh in on.
 */

const NOW = Date.parse("2026-10-15T02:00:00Z");
const ROWS = [{ EmployeeSalaryBenefitID: "e1", LeaveConfigID: "ts", FromDate: "2026-09-01", ToDate: "2026-09-30" },
  { EmployeeSalaryBenefitID: "e2", LeaveConfigID: "ts", FromDate: "2026-09-01", ToDate: "2026-09-30" }];
const SALARY = [{ EmployeeSalaryBenefitID: "e3", SalaryCoefficient: 2.67, StartDate: "2026-09-01" },
  { EmployeeSalaryBenefitID: "e4", SalaryCoefficient: 2.34, StartDate: "2026-09-01" }];
const APPROVED = { Year: 2026, Month: 9, LeaveTrackings: JSON.stringify(ROWS), SalaryProcesses: SALARY };
const MODES = { LeaveTrackings: "subset", SalaryProcesses: "whole" } as const;
const BINDING = { actorId: "actor", grantRevision: "g1", agentProfileId: "default", runtimeSnapshotId: "rt", runtimeRouteRevision: "route", policyRevision: "rev" };
const TASK = ["t1", "t2", "t3"];

let seq = 0;
function event(type: string, turnId: string, payload: Record<string, JsonValue>): SessionEvent {
  seq += 1;
  return { type, turnId, payload, seq } as unknown as SessionEvent;
}

interface ApprovalOptions {
  readonly decision?: string; readonly turn?: string; readonly resolvedAt?: string; readonly resolvedBy?: string; readonly toolId?: string;
  readonly binding?: Partial<typeof BINDING>; readonly interaction?: JsonValue; readonly dispatched?: boolean;
}

/** The approval of one write as the journal holds it: asked, answered, dispatched and (unless cancelled first) run. */
function approval(id: string, args: Record<string, JsonValue>, options: ApprovalOptions = {}): SessionEvent[] {
  const b = { ...BINDING, ...options.binding };
  const toolId = options.toolId ?? "apply";
  const ids = { callId: "call_0", executionId: `exec-${id}`, toolId };
  return [
    event("tool/intent", options.turn ?? "t1", { ...ids, arguments: JSON.stringify(args), sideEffect: "idempotent", state: "prepared" }),
    event("approval/requested", options.turn ?? "t1", { approvalId: id, ...ids, arguments: JSON.stringify(args),
      actionDigest: `digest-${id}`, policyRevision: b.policyRevision, runtimeSnapshotId: b.runtimeSnapshotId, runtimeRouteRevision: b.runtimeRouteRevision,
      agentProfileId: b.agentProfileId, requestedBy: b.actorId, grantRevision: b.grantRevision, ...(options.interaction ? { interaction: options.interaction } : {}) }),
    event("approval/resolved", "t2", { approvalId: id, decision: options.decision ?? "approve", actionDigest: `digest-${id}`,
      resolvedBy: options.resolvedBy ?? "actor", resolvedAt: options.resolvedAt ?? "2026-10-15T01:56:00Z" }),
    // The answer and the dispatch boundary are one append; a call cancelled before it ran ends not dispatched.
    event("tool/state", "t2", { ...ids, state: "dispatching" }),
    event("tool/result", "t2", { ...ids, state: options.dispatched === false ? "cancelled" : "succeeded", dispatched: options.dispatched !== false }),
  ];
}

const cover = (events: readonly SessionEvent[], args: Record<string, JsonValue>, digest = "digest-new", rows: CoverCandidate["rows"] = MODES) =>
  coveringApproval(events, TASK, { toolId: "apply", rows, arguments: args, actionDigest: digest, binding: BINDING }, NOW);

test("the approved call again, or the part that did not go through, is within the approval", () => {
  const events = approval("a1", APPROVED);
  assert.deepEqual(cover(events, APPROVED, "digest-a1"), { approvalId: "a1", kind: "repeat" });
  // The leave rows only (the salary part went through), as an array this time, in another order and key order.
  assert.deepEqual(cover(events, { LeaveTrackings: [ROWS[1], ROWS[0]] as JsonValue, Month: 9, Year: 2026 }), { approvalId: "a1", kind: "rows" });
  assert.deepEqual(cover(events, { Year: 2026, Month: 9, LeaveTrackings: [ROWS[1]!] }), { approvalId: "a1", kind: "rows" }, "some leave rows");
  assert.deepEqual(cover(events, { Year: 2026, Month: 9, SalaryProcesses: SALARY }), { approvalId: "a1", kind: "rows" }, "all salary rows, in order");
});

test("anything the card did not show is asked", () => {
  const events = approval("a1", APPROVED);
  for (const [why, args] of [
    ["a new row", { ...APPROVED, LeaveTrackings: JSON.stringify([...ROWS, { ...ROWS[0]!, EmployeeSalaryBenefitID: "e9" }]) }],
    ["a changed value", { Year: 2026, Month: 9, LeaveTrackings: [{ ...ROWS[0]!, ToDate: "2026-09-15" }] }],
    ["another period", { Year: 2026, Month: 10, LeaveTrackings: [ROWS[0]!] }],
    ["an extra argument", { Year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!], Note: "x" }],
    ["an alias of a target key", { year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!] }],
    ["a row field under another spelling", { Year: 2026, Month: 9, leaveTrackings: [ROWS[0]!] }],
    ["a row sent twice", { Year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!, ROWS[0]!] }],
    ["some of rows that depend on one another", { Year: 2026, Month: 9, SalaryProcesses: [SALARY[0]!] }],
    ["rows that depend on one another, reordered", { Year: 2026, Month: 9, SalaryProcesses: [SALARY[1]!, SALARY[0]!] }],
    ["an empty row field where rows were approved", { Year: 2026, Month: 9, LeaveTrackings: "[]", SalaryProcesses: SALARY }],
    ["a key every object inherits", { Year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!], constructor: "x" }],
    ["the prototype key", JSON.parse(`{"Year":2026,"Month":9,"LeaveTrackings":[${JSON.stringify(ROWS[0])}],"__proto__":"x"}`)],
    ["a row field that is not a list", { Year: 2026, Month: 9, LeaveTrackings: "e1" }],
    ["no rows at all", { Year: 2026, Month: 9, LeaveTrackings: [] }],
  ] as const) assert.equal(cover(events, args as unknown as Record<string, JsonValue>), undefined, why);
  assert.equal(cover(approval("a2", { Year: 2026, Month: 9 }), { Year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!] }), undefined,
    "a row field the approved call did not send");
  assert.equal(cover(events, { Year: 2026, Month: 9, LeaveTrackings: [ROWS[0]!] }, "digest-new", {}), undefined, "no row fields: only the exact call");
  assert.deepEqual(cover(events, APPROVED, "digest-a1", {}), { approvalId: "a1", kind: "repeat" });
});

test("only an approval of this person's write in this task, bound as a resume binds it, and dispatched", () => {
  const no = (why: string, options: ApprovalOptions) => assert.equal(cover(approval("a1", APPROVED, options), APPROVED, "digest-a1"), undefined, why);
  no("denied", { decision: "deny" });
  no("expired", { decision: "expired" });
  no("another task", { turn: "t0" });
  no("answered by someone else", { resolvedBy: "someone-else" });
  no("another tool", { toolId: "other" });
  no("another runtime", { binding: { runtimeSnapshotId: "rt-old" } });
  no("another route", { binding: { runtimeRouteRevision: "route-old" } });
  no("another grant", { binding: { grantRevision: "g0" } });
  no("another profile", { binding: { agentProfileId: "other" } });
  no("another policy", { binding: { policyRevision: "rev-old" } });
  no("bound to a form answer", { interaction: { action: "accept", continuationDigest: "c" } });
  no("cancelled before it ran", { dispatched: false });
  no("approved too long ago", { resolvedAt: new Date(NOW - APPROVAL_COVER_TTL_MS - 1).toISOString() });
});

test("an approval stops covering once the user writes, answers another card, or another write runs — and after one repeat", () => {
  const base = approval("a1", APPROVED);
  const after = (...events: SessionEvent[]) => cover([...base, ...events], APPROVED, "digest-a1");
  assert.equal(after(event("user/input", "t3", { content: "stop" })), undefined, "a message from the user");
  assert.equal(after(event("interaction/resolved", "t3", { interactionId: "q1", action: "accept", resolvedBy: "actor" })), undefined, "a form the user answered");
  assert.ok(after(event("interaction/resolved", "t3", { interactionId: "q2", action: "cancel", resolvedBy: "runtime" })), "the runtime closing a pause is not the user");
  // A later call reusing X's call id (providers do) is another call: its card voids the cover.
  assert.equal(after(event("tool/policy-decision", "t3", { callId: "call_0", executionId: "exec-later", toolId: "w", outcome: "require_approval" })), undefined,
    "another write under a reused call id");
  assert.equal(after(...approval("b1", { other: 1 }, { toolId: "other_write" })), undefined, "another card answered");
  assert.equal(after(event("tool/policy-decision", "t3", { callId: "c9", executionId: "e9", toolId: "w", outcome: "require_approval" })), undefined, "another write asked for");
  assert.equal(after(event("tool/intent", "t3", { callId: "c8", executionId: "e8", toolId: "ui_click", sideEffect: "nonIdempotent" }),
    event("tool/state", "t3", { callId: "c8", executionId: "e8", state: "dispatching" })), undefined, "a non-idempotent call ran");
  assert.ok(after(event("tool/intent", "t3", { callId: "c7", executionId: "e7", toolId: "ui_open", sideEffect: "idempotent" }),
    event("tool/state", "t3", { callId: "c7", executionId: "e7", state: "dispatching" }), event("tool/policy-decision", "t3", { callId: "c7", executionId: "e7", outcome: "allow" })),
  "reads and navigation change nothing");
  assert.equal(after(event("tool/policy-decision", "t3", { callId: "call_0", executionId: "e6", toolId: "apply", outcome: "allow", coveredBy: "a1" })), undefined,
    "one repeat per approval, whatever call id it came under");
});

test("the settled decision: allowed and bound to the same action when covered; a policy cannot claim a cover itself", () => {
  const decision = { decisionId: "d", outcome: "require_approval" as const, policyRevision: "rev", reason: "Approval required", actionDigest: "digest-a1",
    approvalPresentation: { summary: "s", action: "a", target: "t", impact: "i" } };
  const covered = settleCover(decision, { approvalId: "a1", kind: "rows" });
  assert.deepEqual([covered.outcome, covered.actionDigest, covered.coveredBy, "approvalPresentation" in covered], ["allow", "digest-a1", "a1", false]);
  assert.notEqual(covered.decisionId, "d");
  const claimed = settleCover({ ...decision, coveredBy: "forged" }, undefined);
  assert.deepEqual([claimed.outcome, claimed.coveredBy, claimed.approvalPresentation?.summary], ["require_approval", undefined, "s"]);
});

test("the coordinator covers a new call only: never the resumed call, a vetoed card, a tool that asks, or one without repeatable rows", async () => {
  const { ToolExecutionCoordinator } = await import("../src/agent/tool-execution-coordinator.js");
  const { resolveAgentOptions } = await import("../src/agent/agent-options.js");
  const tool = (id: string, extra: Record<string, unknown> = {}) => ({
    id, version: "1.0.0", description: "write", inputSchema: { type: "object" } as JsonValue, outputSchema: {} as JsonValue,
    requiredPermissions: [], sideEffect: "idempotent" as const, timeoutMs: 1_000, execute: async () => ({ ok: true }) as never, ...extra,
  });
  const policy = {
    discover: async (tools: readonly unknown[]) => tools as never,
    authorize: async (input: { tool: { id: string } }) => ({ decisionId: "d", outcome: "require_approval" as const, policyRevision: "rev", reason: "Approval required",
      actionDigest: "digest", ...(input.tool.id === "vetoed" ? { coverable: false as const } : {}) }),
  };
  const asked: string[] = [];
  const lookup = async (definition: { id: string }) => { asked.push(definition.id); return { approvalId: "a1", kind: "repeat" as const }; };
  const coordinator = new ToolExecutionCoordinator([tool("apply", { repeatableRows: { Rows: "subset" } }), tool("insert"), tool("vetoed", { repeatableRows: {} }),
    tool("asks", { repeatableRows: {}, asksUser: true })], resolveAgentOptions({}), policy as never, undefined, undefined, undefined, undefined, undefined, { approvalCover: lookup });
  const context = { sessionId: "s", turnId: "t3", stepId: "st", security: { actorId: "actor" } as never, runtime: { id: "rt" } as never };
  const fresh = await coordinator.prepare({ id: "c1", name: "apply", arguments: "{}" }, context);
  assert.equal(fresh.kind === "ready" && fresh.execution.policyDecision.coveredBy, "a1");
  assert.equal((await coordinator.prepareResumed({ id: "c2", name: "apply", arguments: "{}" }, context)).kind, "approval", "the approved call keeps its own path");
  for (const name of ["insert", "vetoed", "asks"]) assert.equal((await coordinator.prepare({ id: `c-${name}`, name, arguments: "{}" }, context)).kind, "approval", name);
  assert.deepEqual(asked, ["apply"], "the lookup is asked only for a new call of a tool that may be covered");
});

test("through the loop: the user approves a write once, its failed part goes again without a card, a new row is asked", async () => {
  const { DefaultAgentLoop } = await import("@0xsyncroot/core");
  const { createSystemPromptPlugin } = await import("@0xsyncroot/plugins-base");
  const { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } = await import("./turn-harness.js");
  const sent: string[][] = [];
  const progress: Record<string, unknown>[] = [];
  const rowsTool = {
    id: "test_rows", version: "1.0.0", description: "writes rows", repeatableRows: { rows: "subset" },
    inputSchema: { type: "object", properties: { target: { type: "string" }, rows: { type: "array", items: { type: "string" } } },
      required: ["target", "rows"], additionalProperties: false } as JsonValue,
    outputSchema: {} as JsonValue, requiredPermissions: ["test.write"], sideEffect: "idempotent" as const, timeoutMs: 1_000,
    execute: async (invocation: { arguments: JsonValue }) => {
      const rows = (invocation.arguments as { rows: string[] }).rows;
      sent.push(rows);
      return (sent.length === 1 ? { written: rows.filter((row) => row !== "b"), failed: ["b"] } : { written: rows }) as never;
    },
  };
  const { adapter } = scriptedModel([
    call("w1", "test_rows", { target: "sheet-9", rows: ["a", "b"] }),
    call("w2", "test_rows", { rows: ["b"], target: "sheet-9" }),
    call("w3", "test_rows", { target: "sheet-9", rows: ["c"] }),
    answer("done"),
  ]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [rowsTool as never])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore());
    const paused = await agent.runTurn({ sessionId: "cover", content: "write rows a and b", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    const resumed = await agent.resumeTurn({ sessionId: "cover", approvalId: paused.approval!.approvalId, decision: "approve", security: security(),
      idempotencyKey: "approve-1", onProgress: (event) => progress.push(event as never) });
    assert.deepEqual(sent, [["a", "b"], ["b"]], "the failed row went again after the one approval");
    assert.equal(resumed.outcome, "awaiting_approval", "a row the card never showed is asked");
    const decisions = resumed.events.filter((event) => event.type === "tool/policy-decision").map((event) => event.payload as Record<string, JsonValue>);
    assert.deepEqual(decisions.map((decision) => [decision.callId, decision.outcome, decision.coveredBy ?? null]),
      [["w1", "require_approval", null], ["w2", "allow", paused.approval!.approvalId], ["w3", "require_approval", null]]);
    assert.deepEqual(progress.filter((event) => event.type === "tool-started").map((event) => [event.callId, event.approvalReused ?? null]),
      [["w1", null], ["w2", true]], "the delivery is told the call ran within the earlier approval");
    assert.deepEqual(progress.filter((event) => event.type === "tool-completed").map((event) => [event.callId, event.approvalReused ?? null]),
      [["w1", null], ["w2", true]], "and so is the ending, from the same decision");
  } finally { await host.shutdown(); }
});
