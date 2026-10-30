import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_EXECUTION_RESPONSE_PROTOCOL, type JsonValue, type SessionEvent, type StandingApproval, type StandingApprovalSource, type ToolAuthorizationInput,
  type ToolDefinition, type ToolPolicyDecision,
} from "@0xsyncroot/contracts";
import { DefaultAgentLoop, PermissionToolExecutionPolicy } from "@0xsyncroot/core";
import { createSystemPromptPlugin } from "@0xsyncroot/plugins-base";
import { bindApprovalPresentation } from "../src/agent/approval-presentation.js";
import { settleStanding, standingApprovalLookup } from "../src/agent/standing-approval.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";

/**
 * A person's standing approval answers the card a new call would ask, in core, after the
 * approval cover; the journal keeps the card it replaced and the digest it bound. A refusal stays a refusal, a card already
 * shown is still answered by a click, and the setting is read live for every call.
 */

const STANDING: StandingApproval = { revision: "rev-1", since: "2026-10-15T01:00:00.000Z" };
const CARD = { summary: "Writes one value", action: "Write value", target: "Sheet 9", impact: "The value is replaced" };

/** A switch the test flips between calls, and a log of every read. */
function switchable(initial: boolean) {
  const state = { on: initial, reads: [] as string[] };
  const source: StandingApprovalSource = { current: async (query) => { state.reads.push(query.toolId); return state.on ? STANDING : undefined; } };
  return { state, source };
}

/** The baseline policy plus a card, the way a product presents its writes. */
const presented = {
  discover: (tools: readonly ToolDefinition[], context: Parameters<PermissionToolExecutionPolicy["discover"]>[1]) => new PermissionToolExecutionPolicy().discover(tools, context),
  authorize: async (input: ToolAuthorizationInput): Promise<ToolPolicyDecision> => {
    const decision = await new PermissionToolExecutionPolicy().authorize(input);
    return decision.outcome === "require_approval" ? { ...decision, approvalPresentation: CARD } : decision;
  },
};

function writer(id: string, onRun: (args: JsonValue) => void = () => undefined, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id, version: "1.0.0", description: "writes rows", inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "string" } } },
      required: ["rows"], additionalProperties: false },
    outputSchema: {}, requiredPermissions: ["test.write"], sideEffect: "idempotent", timeoutMs: 1_000,
    execute: async (invocation) => { onRun(invocation.arguments); return { written: true }; }, ...extra,
  };
}

const payloads = (events: readonly SessionEvent[], type: string) =>
  events.filter((event) => event.type === type).map((event) => event.payload as Record<string, JsonValue>);

test("under a standing approval a write runs without a card; the journal keeps the card it replaced and the digest it bound", async () => {
  const ran: JsonValue[] = [];
  const progress: Record<string, unknown>[] = [];
  const { adapter, requests } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [writer("test_rows", (args) => ran.push(args))])]);
  const { state, source } = switchable(true);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { toolExecutionPolicy: presented, standingApproval: source });
    const result = await agent.runTurn({ sessionId: "standing-on", content: "write a", security: security(), onProgress: (event) => progress.push(event as never) });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(ran, [{ rows: ["a"] }]);
    assert.equal(result.events.some((event) => event.type === "approval/requested"), false, "no card");
    const [decision] = payloads(result.events, "tool/policy-decision");
    assert.equal(decision?.outcome, "allow");
    assert.match(String(decision?.decisionId), /^standing-/u);
    assert.deepEqual(decision?.standingApproval, { ...STANDING, presentation: CARD }, "the card it replaced");
    assert.equal(decision?.approvalPresentation, undefined);
    // The digest is the one the card would have bound: its presentation included.
    const policy = await new PermissionToolExecutionPolicy().authorize({ ...({} as ToolAuthorizationInput), security: security(), runtime: { id: host.snapshot.id, policyRevision: decision?.policyRevision } as never,
      tool: writer("test_rows"), arguments: { rows: ["a"] } as JsonValue, sessionId: "standing-on", turnId: "t", stepId: "s", callId: "w1", executionId: "e" });
    assert.equal(decision?.actionDigest, bindApprovalPresentation({ ...policy, approvalPresentation: CARD }).actionDigest);
    assert.deepEqual(progress.filter((event) => event.type === "tool-started").map((event) => event.approvalStanding), [true]);
    assert.deepEqual(progress.filter((event) => event.type === "tool-completed").map((event) => [event.approvalStanding ?? null, event.approvalReused ?? null]), [[true, null]],
      "the ending repeats the start's flag, from the same decision");
    assert.deepEqual(state.reads, ["test_rows"]);
    // The model reads exactly what it reads after an approved card: the tool's own result, no note about the setting.
    const told = requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "w1")?.content ?? "";
    assert.deepEqual(JSON.parse(told), { written: true });
  } finally { await host.shutdown(); }
});

test("a source that answers nothing, throws, is late or malformed leaves the card asked", async () => {
  const tool = writer("test_rows");
  const decision: ToolPolicyDecision = { decisionId: "d", outcome: "require_approval", policyRevision: "r", reason: "ask", actionDigest: "x" };
  const scope = { security: security(), sessionId: "s" };
  const late: StandingApprovalSource = { current: (_query, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(STANDING))) };
  const answers: StandingApprovalSource[] = [
    { current: async () => undefined },
    { current: async () => { throw new Error("store down"); } },
    { current: () => new Promise(() => undefined) },
    late,
    { current: async () => ({ revision: "", since: STANDING.since }) },
    { current: async () => ({ revision: "r", since: "not a date" }) },
  ];
  for (const [index, source] of answers.entries()) {
    assert.equal(await standingApprovalLookup(source, scope, new AbortController().signal, 20)(tool, decision), undefined, `answer ${index}`);
  }
  const stopped = new AbortController(); stopped.abort();
  let asked = false;
  assert.equal(await standingApprovalLookup({ current: async () => { asked = true; return STANDING; } }, scope, stopped.signal)(tool, decision), undefined);
  assert.equal(asked, false, "a stopped turn reads nothing");

  // Through the loop: a throwing source is a card.
  const { adapter } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [tool])]);
  try {
    const paused = await new DefaultAgentLoop(router, new SpyStore(), {}, { standingApproval: answers[1]! })
      .runTurn({ sessionId: "standing-throws", content: "write a", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
  } finally { await host.shutdown(); }
});

test("a refusal is never turned into an allow, a policy cannot claim the setting, and only new calls are read for it", async () => {
  const { ToolExecutionCoordinator } = await import("../src/agent/tool-execution-coordinator.js");
  const { resolveAgentOptions } = await import("../src/agent/agent-options.js");
  const outcomes: Record<string, ToolPolicyDecision["outcome"]> = { denied: "deny", asks: "require_approval", write: "require_approval" };
  const policy = {
    discover: async (tools: readonly ToolDefinition[]) => tools,
    authorize: async (input: ToolAuthorizationInput): Promise<ToolPolicyDecision> => ({
      decisionId: "d", outcome: outcomes[input.tool.id]!, policyRevision: "rev", reason: "policy", actionDigest: "digest",
      // A policy that claims the setting itself is not believed.
      ...(input.tool.id === "write" ? { standingApproval: { revision: "forged", since: STANDING.since } } : {}),
    }),
  };
  const read: string[] = [];
  const coordinator = new ToolExecutionCoordinator([writer("denied"), writer("asks", undefined, { asksUser: true }), writer("write")], resolveAgentOptions({}),
    policy, undefined, undefined, undefined, undefined, undefined, { standingApproval: async (tool) => { read.push(tool.id); return STANDING; } });
  const context = { sessionId: "s", turnId: "t", stepId: "st", security: security(), runtime: { id: "rt" } as never };
  const denied = await coordinator.prepare({ id: "c1", name: "denied", arguments: JSON.stringify({ rows: [] }) }, context);
  assert.equal(denied.kind === "terminal" && denied.outcome.state, "denied", "a missing permission stays a refusal");
  assert.equal((await coordinator.prepare({ id: "c2", name: "asks", arguments: JSON.stringify({ rows: [] }) }, context)).kind, "approval", "a tool that asks the user");
  const resumed = await coordinator.prepareResumed({ id: "c3", name: "write", arguments: JSON.stringify({ rows: [] }) }, context);
  assert.equal(resumed.kind, "approval", "a call resumed from its card keeps its card");
  assert.equal(resumed.kind === "approval" && resumed.execution.policyDecision.standingApproval, undefined, "the forged claim is dropped");
  const fresh = await coordinator.prepare({ id: "c4", name: "write", arguments: JSON.stringify({ rows: [] }) }, context);
  assert.deepEqual(fresh.kind === "ready" && fresh.execution.policyDecision.standingApproval, STANDING, "the core's own reading, not the policy's");
  assert.deepEqual(read, ["write"]);
  // A decision the cover already allowed is left as it is.
  const covered = settleStanding({ decisionId: "d", outcome: "allow", policyRevision: "r", reason: "covered", actionDigest: "x", coveredBy: "a1" }, STANDING);
  assert.deepEqual([covered.outcome, covered.coveredBy, covered.standingApproval], ["allow", "a1", undefined]);
});

test("a card shown before the setting was turned on is still answered by its click, and runs once", async () => {
  const ran: JsonValue[] = [];
  const progress: Record<string, unknown>[] = [];
  const { adapter } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [writer("test_rows", (args) => ran.push(args))])]);
  const { state, source } = switchable(false);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { toolExecutionPolicy: presented, standingApproval: source });
    const paused = await agent.runTurn({ sessionId: "pending", content: "write a", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    state.on = true;
    const resumed = await agent.resumeTurn({ sessionId: "pending", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1",
      onProgress: (event) => progress.push(event as never) });
    assert.equal(resumed.outcome, "completed");
    assert.deepEqual(ran, [{ rows: ["a"] }]);
    assert.deepEqual(progress.filter((event) => event.type === "tool-completed").map((event) => event.approvalStanding ?? null), [null], "a click is not the setting: no flag on the ending");
    // The resume journals the approved call's own decision: the card's, never the setting's.
    const decisions = payloads(resumed.events, "tool/policy-decision");
    assert.deepEqual(decisions.map((decision) => [decision.outcome, decision.standingApproval ?? null]), [["require_approval", null]],
      "resumed by the click: the setting never answered this card");
    assert.equal(payloads(resumed.events, "approval/resolved")[0]?.decision, "approve");
  } finally { await host.shutdown(); }
});

test("turned off mid-turn, the next write asks", async () => {
  const { state, source } = switchable(true);
  const ran: JsonValue[] = [];
  const { adapter } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), call("w2", "test_rows", { rows: ["b"] }), answer("done")]);
  const tool = writer("test_rows", (args) => { ran.push(args); state.on = false; });
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [tool])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { standingApproval: source })
      .runTurn({ sessionId: "off-mid-turn", content: "write a then b", security: security() });
    assert.equal(result.outcome, "awaiting_approval");
    assert.deepEqual(ran, [{ rows: ["a"] }]);
    assert.deepEqual(state.reads, ["test_rows", "test_rows"], "read again for the second write");
  } finally { await host.shutdown(); }
});

test("a write the setting ran voids the approval cover: approve A, B unasked, turn it off, A again asks", async () => {
  const { state, source } = switchable(false);
  const ran: JsonValue[] = [];
  const rowsTool = writer("test_rows", (args) => {
    ran.push(args);
    if (JSON.stringify(args).includes("b")) state.on = false;
  }, { repeatableRows: { rows: "subset" } });
  const { adapter } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), call("w2", "test_rows", { rows: ["b"] }), call("w3", "test_rows", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("rows", [rowsTool])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { standingApproval: source });
    const paused = await agent.runTurn({ sessionId: "cover-voided", content: "write rows", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    state.on = true;
    const resumed = await agent.resumeTurn({ sessionId: "cover-voided", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1" });
    assert.deepEqual(ran, [{ rows: ["a"] }, { rows: ["b"] }]);
    assert.equal(resumed.outcome, "awaiting_approval", "the repeat of A is asked: B ran since it was approved");
    const decisions = payloads(resumed.events, "tool/policy-decision");
    assert.deepEqual(decisions.slice(-2).map((decision) => [decision.callId, decision.outcome, decision.coveredBy ?? null, Boolean(decision.standingApproval)]),
      [["w2", "allow", null, true], ["w3", "require_approval", null, false]]);
  } finally { await host.shutdown(); }
});

test("a write run under the setting that asks a question resumes as the approved call it stands for", async () => {
  const answered: JsonValue[] = [];
  const asking = writer("test_ask", undefined, {
    execute: async (invocation) => {
      if (!invocation.interaction) {
        return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required", request: { kind: "form", message: "Which unit?",
          requestedSchema: { type: "object", properties: { unit: { type: "string", title: "Unit" } } } } } as never;
      }
      answered.push(invocation.interaction.content ?? null);
      return { written: true };
    },
  });
  // A policy whose digest does not follow the answer (a product's own binding): the answered call is the one allowed.
  const policy = {
    discover: presented.discover,
    authorize: async (input: ToolAuthorizationInput) => ({ ...await new PermissionToolExecutionPolicy().authorize({ ...input, interaction: undefined } as never) }),
  };
  const { adapter } = scriptedModel([call("w1", "test_ask", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("ask", [asking])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { toolExecutionPolicy: policy, standingApproval: switchable(true).source });
    const paused = await agent.runTurn({ sessionId: "standing-asks", content: "write a", security: security() });
    assert.equal(paused.outcome, "awaiting_interaction");
    const requested = payloads(paused.events, "interaction/requested")[0];
    assert.equal(requested?.authorizationOutcome, "require_approval", "the question remembers the call stood for an approval");
    const resumed = await agent.resumeInteraction({
      sessionId: "standing-asks", interactionId: paused.interaction!.interactionId, action: "accept", content: { unit: "u-1" }, security: security(), idempotencyKey: "answer-1",
    });
    assert.equal(resumed.outcome, "completed");
    assert.deepEqual(answered, [{ unit: "u-1" }]);
  } finally { await host.shutdown(); }
});

test("a card the policy marks `standable: false` is asked under the setting, its click runs it once, and an unmarked write still runs unasked", async () => {
  const ran: string[] = [];
  const irreversible = {
    discover: presented.discover,
    authorize: async (input: ToolAuthorizationInput): Promise<ToolPolicyDecision> => {
      const decision = await presented.authorize(input);
      return input.tool.id === "test_delete" ? { ...decision, standable: false } : decision;
    },
  };
  const { adapter } = scriptedModel([call("w1", "test_rows", { rows: ["a"] }), call("d1", "test_delete", { rows: ["a"] }), answer("done")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(),
    toolPlugin("rows", [writer("test_rows", () => ran.push("rows")), writer("test_delete", () => ran.push("delete"))])]);
  const { state, source } = switchable(true);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), {}, { toolExecutionPolicy: irreversible, standingApproval: source });
    const paused = await agent.runTurn({ sessionId: "irreversible", content: "write then delete", security: security() });
    assert.equal(paused.outcome, "awaiting_approval");
    assert.deepEqual(ran, ["rows"], "the unmarked write ran unasked; the marked one waits for its card");
    assert.deepEqual(state.reads, ["test_rows"], "the setting is not even read for a marked card");
    assert.deepEqual(payloads(paused.events, "approval/requested").map((payload) => payload.toolId), ["test_delete"]);
    const resumed = await agent.resumeTurn({ sessionId: "irreversible", approvalId: paused.approval!.approvalId, decision: "approve", security: security(), idempotencyKey: "approve-1" });
    assert.equal(resumed.outcome, "completed");
    assert.deepEqual(ran, ["rows", "delete"]);
  } finally { await host.shutdown(); }
  // The invariant sits in settleStanding too: a standing approval handed to it never answers a marked card.
  const marked = settleStanding({ decisionId: "d", outcome: "require_approval", policyRevision: "r", reason: "ask", actionDigest: "x", standable: false,
    standingApproval: { revision: "forged", since: STANDING.since } }, STANDING);
  assert.deepEqual([marked.outcome, marked.standingApproval], ["require_approval", undefined]);
});
