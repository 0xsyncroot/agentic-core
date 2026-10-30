import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnControlPolicy, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { WRITE_PRECONDITION_MARKER, withToolPreconditions } from "../src/index.js";

type Review = Parameters<NonNullable<TurnControlPolicy["reviewToolCalls"]>>[0];
const signal = new AbortController().signal;
const result = (turnId: string, toolId: string, state = "succeeded") => ({ eventId: `${turnId}-${toolId}-${state}`, seq: 1, turnId, type: "tool/result", payload: { toolId, state, dispatched: state === "succeeded" } });
const review = (calls: readonly string[], events: readonly unknown[] = [], taskTurnIds: readonly string[] = ["t1"]) => ({
  turnId: taskTurnIds.at(-1) ?? "t1", taskTurnIds, directive: {}, availableTools: [], context: { events },
  toolCalls: calls.map((name, index) => ({ id: `c${index}`, name, arguments: "{}" })),
}) as unknown as Review;

function inner(decision: TurnTerminalDecision = { decision: "accept", reason: "inner" }) {
  const seen: string[] = [];
  const policy: TurnControlPolicy = {
    id: "inner", revision: "7", keepDraftsAsNarration: true,
    beforeModelStep: async () => { seen.push("before"); return { allowedToolIds: ["x"] }; },
    reviewToolCalls: async () => { seen.push("tools"); return decision; },
    reviewTerminal: async () => { seen.push("terminal"); return { decision: "accept", reason: "terminal" }; },
    fallbackText(input) { return `${this.id}:${input.kind}`; },
  };
  return { policy, seen };
}

const DECLARED = new Map([["create_item", ["read_data"]]]);

test("a declared write with no succeeded read in the task is refused before the wrapped policy, under a fixed marker", async () => {
  const { policy, seen } = inner();
  const guarded = withToolPreconditions(policy, { preconditions: () => DECLARED, fallback: "Chưa ghi." });
  for (const events of [[], [result("t1", "read_data", "failed")], [result("t0", "read_data")], [result("t1", "other_read")]]) {
    const decision = await guarded.reviewToolCalls!(review(["plan_update", "create_item"], events), signal);
    assert.deepEqual(decision, {
      decision: "continue", fallback: "Chưa ghi.",
      feedback: `${WRITE_PRECONDITION_MARKER} create_item needs a succeeded read_data in this task first. None of this step's calls ran. `
        + "Call read_data in a step of its own, without the write, and propose the write again only after it has succeeded.",
    }, JSON.stringify(events));
  }
  assert.deepEqual(seen, [], "a refused step never reaches the wrapped policy");
});

test("a succeeded read in any turn of the task lets the write through to the wrapped policy, whose decision stands", async () => {
  const objection: TurnTerminalDecision = { decision: "continue", feedback: "inner objection" };
  const { policy, seen } = inner(objection);
  const guarded = withToolPreconditions(policy, { preconditions: () => DECLARED, fallback: "x" });
  assert.deepEqual(await guarded.reviewToolCalls!(review(["create_item"], [result("t0", "read_data")], ["t0", "t1"]), signal), objection,
    "a read before the form answer, in the turn the task resumed from, counts");
  assert.deepEqual(await guarded.reviewToolCalls!(review(["read_data"]), signal), objection, "an undeclared call is the wrapped policy's alone");
  assert.deepEqual(seen, ["tools", "tools"]);
});

test("several writes: each names what it is missing, and the missing calls are listed once", async () => {
  const declared = { create_item: ["read_data", "read_rules"], close_item: ["read_data"] } as const;
  const guarded = withToolPreconditions(inner().policy, { preconditions: () => declared, fallback: "x" });
  const decision = await guarded.reviewToolCalls!(review(["create_item", "close_item", "create_item"], [result("t1", "read_rules")]), signal);
  assert.equal(decision.decision === "continue" && decision.feedback,
    `${WRITE_PRECONDITION_MARKER} create_item needs a succeeded read_data in this task first; close_item needs a succeeded read_data in this task first. `
    + "None of this step's calls ran. Call read_data in a step of its own, without the write, and propose the write again only after it has succeeded.");
  const both = await guarded.reviewToolCalls!(review(["create_item"]), signal);
  assert.match(both.decision === "continue" ? both.feedback : "", /needs a succeeded read_data and read_rules in this task first\. .*Call read_data, read_rules in a step of its own.*after they have succeeded\.$/u);
});

test("nothing declared: a no-op that hands every review to the wrapped policy", async () => {
  const { policy, seen } = inner();
  const guarded = withToolPreconditions(policy, { preconditions: () => new Map(), fallback: "x" });
  assert.deepEqual(await guarded.reviewToolCalls!(review(["create_item"]), signal), { decision: "accept", reason: "inner" });
  const { reviewToolCalls: _review, ...withoutReview } = policy;
  const bare = withToolPreconditions(withoutReview, { preconditions: () => DECLARED, fallback: "x" });
  assert.deepEqual(await bare.reviewToolCalls!(review(["create_item"], [result("t1", "read_data")]), signal), { decision: "accept" });
  assert.deepEqual(seen, ["tools"]);
});

test("the declarations are read on every review, so a composition binds them after boot", async () => {
  const bound = new Map<string, readonly string[]>();
  const guarded = withToolPreconditions(inner().policy, { preconditions: () => bound, fallback: "x" });
  assert.equal((await guarded.reviewToolCalls!(review(["create_item"]), signal)).decision, "accept");
  bound.set("create_item", ["read_data"]);
  assert.equal((await guarded.reviewToolCalls!(review(["create_item"]), signal)).decision, "continue");
});

test("the declarations are asked with the reviewed state, so each runtime answers with its own catalog", async () => {
  const byRuntime = new Map([["r1", DECLARED], ["r2", new Map<string, readonly string[]>()]]);
  const guarded = withToolPreconditions(inner().policy, { preconditions: (state) => byRuntime.get(state.runtime.id)!, fallback: "x" });
  const on = (runtimeId: string) => ({ ...review(["create_item"]), runtime: { id: runtimeId } }) as unknown as Review;
  assert.equal((await guarded.reviewToolCalls!(on("r1"), signal)).decision, "continue", "r1 declares the precondition");
  assert.equal((await guarded.reviewToolCalls!(on("r2"), signal)).decision, "accept", "r2 declares none");
});

test("every other member of the wrapped policy is forwarded as it is", async () => {
  const { policy, seen } = inner();
  const guarded = withToolPreconditions(policy, { preconditions: () => DECLARED, fallback: "x" });
  assert.equal(guarded.id, "inner");
  assert.equal(guarded.revision, "7+preconditions");
  assert.equal(guarded.keepDraftsAsNarration, true);
  assert.equal(guarded.fallbackText?.({ kind: "choice-violation", writesDispatched: false }), "inner:choice-violation", "bound to the wrapped policy");
  assert.deepEqual(await guarded.beforeModelStep(review([]), signal), { allowedToolIds: ["x"] });
  assert.deepEqual(await guarded.reviewTerminal({ ...review([]), candidate: { content: "a", finishReason: "stop" } }, signal), { decision: "accept", reason: "terminal" });
  assert.deepEqual(seen, ["before", "terminal"]);
  const plain = withToolPreconditions({ id: "p", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) },
    { preconditions: () => DECLARED, fallback: "x" });
  assert.equal("fallbackText" in plain, false);
  assert.equal("keepDraftsAsNarration" in plain, false);
});
