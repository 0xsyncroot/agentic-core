import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError, CAPABILITIES, type EventDraft, type JudgmentCallOptions, type JudgmentPort, type JudgmentRequest, type TurnControlPolicy, type TurnControlServices } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { BREAKER_COOLDOWN_MS, JUDGMENT_ATTEMPT_TIMEOUT_MS, JudgmentLatency } from "../src/agent/judgment-latency.js";
import { createTurnJudge } from "../src/agent/turn-judge.js";
import type { TurnEventWriter } from "../src/agent/turn-event-writer.js";
import { JUDGMENT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { activeHost, answer, scriptedModel, security, SpyStore } from "./turn-harness.js";

/**
 * The judge a turn lends its policies: every judgment journaled as `judgment/classified`, the
 * caller handed exactly the rounded values the journal holds, a failure journaled and turned into
 * "no judgment", and no judge at all when no provider is mounted.
 */
function judgmentPlugin(port: JudgmentPort): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.judgment", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:judgment", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.judgment]: { version: "1.0.0", cardinality: "single" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => { context.registrations.provide(JUDGMENT_CAPABILITY, port); return { dispose: () => undefined }; },
    },
  };
}

function askingPolicy(seen: { services?: TurnControlServices; answer?: unknown }): TurnControlPolicy {
  return {
    id: "test.asking", revision: "1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async (_input, signal, services) => {
      seen.services = services;
      const judged = await services?.judge?.("completion-audit", { state: "s", questions: { ok: { type: "noul", instructions: "ok?" } } }, signal);
      seen.answer = judged?.answers.ok;
      return { decision: "accept" };
    },
  };
}

async function run(plugins: readonly PluginDescriptor[]) {
  const seen: { services?: TurnControlServices; answer?: unknown } = {};
  const { adapter } = scriptedModel([answer("Xong.")]);
  const { host, router } = await activeHost(adapter, plugins);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), {}, { turnControlPolicy: askingPolicy(seen) })
      .runTurn({ sessionId: `judge-${Math.random()}`, content: "làm đi", security: security() });
    return { result, seen, judged: result.events.filter((event) => event.type === "judgment/classified").map((event) => event.payload as Record<string, unknown>) };
  } finally { await host.shutdown(); }
}

test("a judgment is journaled under its seam and the caller gets the rounded value the journal holds", async () => {
  const { seen, judged } = await run([judgmentPlugin({ providerId: "fake", model: "fake-1",
    judge: async () => ({ modelId: "fake-1", answers: { ok: { type: "noul", noul: 0.987654321 } } }) })]);
  assert.deepEqual(seen.answer, { type: "noul", noul: 0.9877 });
  assert.equal(judged.length, 1);
  assert.equal(judged[0]!.seam, "completion-audit");
  assert.equal(judged[0]!.outcome, "answered");
  assert.deepEqual(judged[0]!.answers, { ok: { type: "noul", value: 0.9877 } });
  assert.equal(judged[0]!.providerId, "fake");
});

test("a failing provider is journaled as failed and the caller gets no judgment, not an error", async () => {
  const { result, seen, judged } = await run([judgmentPlugin({ providerId: "fake", model: "fake-1", judge: async () => { throw new Error("gateway 429"); } })]);
  assert.equal(result.outcome, "completed");
  assert.equal(seen.answer, undefined);
  assert.equal(judged[0]!.outcome, "failed");
  assert.match(String(judged[0]!.reason), /429/u);
});

test("without a judgment provider the policy is lent no judge and nothing is journaled", async () => {
  const { seen, judged } = await run([]);
  assert.deepEqual(seen.services, {});
  assert.equal(judged.length, 0);
});

test("a wall clock set back during a judgment does not fail the turn: elapsed time is monotonic and never negative", async () => {
  const realNow = Date.now;
  let calls = 0;
  // Every reading is an hour earlier than the last: any elapsed time taken from the wall clock is negative.
  Date.now = () => realNow() - 3_600_000 * (calls++);
  try {
    const { result, judged } = await run([judgmentPlugin({ providerId: "fake", model: "fake-1",
      judge: async () => ({ modelId: "fake-1", answers: { ok: { type: "noul", noul: 0.5 } } }) })]);
    assert.equal(result.outcome, "completed");
    assert.ok((judged[0]!.elapsedMs as number) >= 0);
  } finally { Date.now = realNow; }
});

/**
 * Seam deadlines and the breaker, on the judge itself. The provider is simulated: a call "takes" its scripted latency, and
 * the deadline it was given (JudgmentCallOptions.timeoutMs) decides whether it answers or times out as the adapters do.
 */
const question: JudgmentRequest = { state: "s", questions: { ok: { type: "noul", instructions: "ok?" } } };
const answered = { modelId: "fake-1", answers: { ok: { type: "noul" as const, noul: 0.5 } } };
const advisory = ["skill-relevance", "observation-review", "result-relevance"] as const;

function rig(latencyOf: (seam: string) => number | "cancel" | "transport" = () => 100) {
  const rows: Record<string, unknown>[] = [];
  const writer = { append: async (drafts: readonly EventDraft[]) => { for (const draft of drafts) rows.push(draft.payload as Record<string, unknown>); } } as unknown as TurnEventWriter;
  const asked: { seam: string; options: JudgmentCallOptions | undefined }[] = [];
  let current = "";
  const port: JudgmentPort = {
    providerId: "fake", model: "fake-1",
    judge: async (_request, _signal, options) => {
      asked.push({ seam: current, options });
      const took = latencyOf(current);
      if (took === "cancel") throw new AgenticError("cancelled", "cancelled");
      if (took === "transport") throw new AgenticError("transient", "Test judgment provider transport failed", true);
      if (options?.timeoutMs !== undefined && took > options.timeoutMs) throw new AgenticError("timeout", `fake request exceeded ${options.timeoutMs} ms`);
      return answered;
    },
  };
  let now = 0;
  const judge = createTurnJudge(port, writer, "turn-1", new JudgmentLatency(() => now))!;
  const ask = (seam: string, signal: AbortSignal = new AbortController().signal) => { current = seam; return judge(seam, question, signal); };
  return { ask, rows, asked, tick: (ms: number) => { now += ms; }, breakerRows: () => rows.filter((row) => row.seam === "judgment-breaker") };
}

test("every seam is asked with the one attempt deadline, a seam this table does not know included", async () => {
  const { ask, asked } = rig();
  for (const seam of ["completion-audit", "procedure-audit", "skill-suggestion", ...advisory, "action-gate", "step-claim", "a-product-seam"]) await ask(seam);
  assert.equal(JUDGMENT_ATTEMPT_TIMEOUT_MS, 2_000);
  assert.equal(asked.length, 9, "nothing answered late, so nothing was asked twice");
  assert.ok(asked.every(({ options }) => options?.timeoutMs === JUDGMENT_ATTEMPT_TIMEOUT_MS));
});

test("a judge answering after 1.9 s: every verdict is used; after 4 s every seam gives up, the deciding ones after a second attempt", async () => {
  const slow = (ms: number) => rig(() => ms);
  const quick = slow(1_900);
  for (const seam of [...advisory, "completion-audit", "skill-suggestion", "action-gate"]) assert.ok(await quick.ask(seam), `${seam} answers after 1.9 s and is used`);
  assert.equal(quick.breakerRows().length, 0);
  assert.equal(quick.asked.length, 6, "no retry for an answer");
  const stuck = slow(4_000);
  for (const seam of ["completion-audit", "procedure-audit", "skill-suggestion"]) assert.equal(await stuck.ask(seam), undefined, `${seam} falls to its fallback after two attempts`);
  assert.equal(stuck.asked.length, 6, "a deciding seam asks twice");
  for (const seam of [...advisory, "action-gate", "step-claim", "a-product-seam"]) assert.equal(await stuck.ask(seam), undefined, `${seam} gives up at its 2 000 ms`);
  assert.equal(stuck.asked.length, 12, "every other seam asks once");
  const failed = stuck.rows.filter((row) => row.outcome === "failed" && row.seam !== "judgment-breaker");
  assert.equal(failed.length, 12, "one failed row per failed attempt");
  assert.ok(failed.every((row) => /exceeded 2000 ms/u.test(String(row.reason))), "the row names the deadline that applied");
});

/** A provider that plays one scripted outcome per call: it answers, hangs until its deadline, fails in transport, or refuses the request. */
function scripted(steps: readonly ("answer" | "hang" | "transport" | "refused" | "garbled" | "gateway")[]) {
  const rows: Record<string, unknown>[] = [];
  const writer = { append: async (drafts: readonly EventDraft[]) => { for (const draft of drafts) rows.push(draft.payload as Record<string, unknown>); } } as unknown as TurnEventWriter;
  let calls = 0;
  const port: JudgmentPort = { providerId: "fake", model: "fake-1", judge: async (_request, signal, options) => {
    const step = steps[calls] ?? "answer"; calls += 1;
    signal.throwIfAborted();
    if (step === "hang") throw new AgenticError("timeout", `fake request exceeded ${options?.timeoutMs} ms`);
    if (step === "transport") throw new AgenticError("transient", "fake transport failed", true);
    if (step === "gateway") throw new AgenticError("transient", "fake request failed (502)", true);
    if (step === "refused") throw new AgenticError("permanent", "fake request failed (400)", false);
    if (step === "garbled") throw new AgenticError("permanent", "fake answer has no answers");
    return answered;
  } };
  const judge = createTurnJudge(port, writer, "turn-1")!;
  return { judge, rows, calls: () => calls };
}
const signalOf = () => new AbortController().signal;

test("a deciding seam that hangs once is sent again and the second answer is used; the failed attempt stays in the journal", async () => {
  for (const seam of ["completion-audit", "procedure-audit", "skill-suggestion"]) {
    const { judge, rows, calls } = scripted(["hang", "answer"]);
    const judged = await judge(seam, question, signalOf());
    assert.deepEqual(judged?.answers.ok, { type: "noul", noul: 0.5 }, seam);
    assert.equal(calls(), 2);
    assert.deepEqual(rows.map((row) => [row.seam, row.outcome]), [[seam, "failed"], [seam, "answered"]], "the failed attempt, then the answer");
    assert.match(String(rows[0]!.reason), /exceeded 2000 ms/u);
    assert.equal(typeof rows[0]!.elapsedMs, "number", "each attempt has its own elapsed time");
  }
});

test("hanging twice gives up (the seam's fallback): two failed rows, no third attempt", async () => {
  const { judge, rows, calls } = scripted(["hang", "hang", "answer"]);
  assert.equal(await judge("completion-audit", question, signalOf()), undefined);
  assert.equal(calls(), 2);
  assert.deepEqual(rows.map((row) => row.outcome), ["failed", "failed"]);
});

test("a transport failure and a gateway error are sent again; a refused request, a malformed answer and a cancel are not", async () => {
  for (const kind of ["transport", "gateway"] as const) {
    const { judge, calls } = scripted([kind, "answer"]);
    assert.ok(await judge("procedure-audit", question, signalOf()), kind);
    assert.equal(calls(), 2, kind);
  }
  for (const kind of ["refused", "garbled"] as const) {
    const { judge, rows, calls } = scripted([kind, "answer"]);
    assert.equal(await judge("procedure-audit", question, signalOf()), undefined, kind);
    assert.equal(calls(), 1, `${kind}: not sent again`);
    assert.deepEqual(rows.map((row) => row.outcome), ["failed"]);
  }
  const cancelled = new AbortController();
  const { judge, rows, calls } = scripted(["hang", "answer"]);
  const asking = judge("completion-audit", question, cancelled.signal);
  cancelled.abort(new Error("review done"));
  await assert.rejects(asking);
  assert.equal(calls(), 1, "a call cancelled is not sent again");
  assert.equal(rows.length, 0);
});

test("a turn cancelled while the failed attempt is being journaled does not send the second one", async () => {
  const cancel = new AbortController();
  let calls = 0;
  const port: JudgmentPort = { providerId: "fake", model: "fake-1", judge: async () => { calls += 1; throw new AgenticError("timeout", "fake request exceeded 2000 ms"); } };
  const writer = { append: async () => { cancel.abort(new Error("turn cancelled")); } } as unknown as TurnEventWriter;
  await assert.rejects(createTurnJudge(port, writer, "turn-1")!("completion-audit", question, cancel.signal), /turn cancelled/u);
  assert.equal(calls, 1);
});

test("an advisory or background seam makes one attempt and fails open", async () => {
  for (const seam of [...advisory, "action-gate", "step-claim", "a-product-seam"]) {
    const { judge, rows, calls } = scripted(["hang", "answer"]);
    assert.equal(await judge(seam, question, signalOf()), undefined, seam);
    assert.equal(calls(), 1, `${seam}: no second attempt`);
    assert.deepEqual(rows.map((row) => row.outcome), ["failed"]);
  }
});

test("a deciding call that is retried and answers is not a stall: only the advisory seams feed the breaker", async () => {
  const { ask, breakerRows, tick } = rig((seam) => seam === "completion-audit" ? 4_000 : 100);
  for (let i = 0; i < 5; i += 1) { await ask("completion-audit"); tick(2_000); }
  assert.equal(breakerRows().length, 0, "deciding timeouts, retried or not, never open it");
  assert.ok(await ask("observation-review"));
});

test("three advisory stalls open the breaker: later advisory calls are not asked and write no row; one breaker row says so", async () => {
  const { ask, asked, rows, tick, breakerRows } = rig(() => 4_000);
  for (const seam of advisory) { assert.equal(await ask(seam), undefined); tick(2_000); }
  assert.deepEqual(breakerRows(), [{ seam: "judgment-breaker", providerId: "fake", modelId: "fake-1", outcome: "failed", elapsedMs: 0, reason: "breaker: open 60000 ms" }]);
  const before = { asked: asked.length, rows: rows.length };
  for (let i = 0; i < 5; i += 1) assert.equal(await ask(advisory[i % 3]!), undefined);
  assert.deepEqual({ asked: asked.length, rows: rows.length }, before, "an open breaker asks nothing and journals nothing per skipped call");
  assert.equal(await ask("completion-audit"), undefined, "a deciding seam is still asked while the breaker is open, and the 4 s answer is past its 2 s");
  assert.equal(asked.length, before.asked + 1, "once: a second 2 s wait on a gateway known to be stuck buys nothing; the seam's fallback answers");
});

test("a parallel batch that stalls together is one stall: three skill questions timing out at once do not open the breaker", async () => {
  const { ask, breakerRows, tick } = rig(() => 4_000);
  await Promise.all([ask("skill-relevance"), ask("skill-relevance"), ask("skill-relevance"), ask("skill-relevance")]);
  assert.equal(breakerRows().length, 0);
  tick(2_000);
  await ask("observation-review");
  assert.equal(breakerRows().length, 0, "the second stall");
  tick(2_000);
  await ask("result-relevance");
  assert.equal(breakerRows().length, 1, "the third stall opens it");
});

test("after the cool-down one probe decides: a stall opens it again, an answer closes it; each transition is one row", async () => {
  let latency = 4_000;
  const { ask, asked, tick, breakerRows, rows } = rig(() => latency);
  for (let i = 0; i < 3; i += 1) { await ask("observation-review"); tick(2_000); }
  tick(BREAKER_COOLDOWN_MS - 2_001);
  const askedWhenOpen = asked.length;
  assert.equal(await ask("observation-review"), undefined);
  assert.equal(asked.length, askedWhenOpen, "still inside the cool-down");
  tick(1);
  assert.equal(await ask("observation-review"), undefined, "the probe stalls");
  assert.deepEqual(breakerRows().map((row) => row.reason), ["breaker: open 60000 ms", "breaker: probe", "breaker: open 60000 ms"]);
  assert.equal(asked.length, askedWhenOpen + 1);
  assert.equal(await ask("skill-relevance"), undefined);
  assert.equal(asked.length, askedWhenOpen + 1, "open again: not asked");
  tick(BREAKER_COOLDOWN_MS);
  latency = 100;
  assert.ok(await ask("result-relevance"), "the probe answers within the cap");
  assert.deepEqual(breakerRows().map((row) => [row.outcome, row.reason]).slice(3), [["failed", "breaker: probe"], ["answered", "breaker: closed"]]);
  const rowsAfterClose = rows.length;
  assert.ok(await ask("skill-relevance"));
  assert.equal(rows.length, rowsAfterClose + 1, "closed: asked and journaled as any call");
});

test("while a probe is out the other advisory calls wait: they are not asked", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const rows: unknown[] = [];
  let calls = 0;
  const port: JudgmentPort = { providerId: "fake", model: "fake-1", judge: async (_r, _s, options) => {
    calls += 1;
    if (calls <= 3) throw new AgenticError("timeout", `exceeded ${options?.timeoutMs} ms`);
    await hold; return answered;
  } };
  let now = 0;
  const judge = createTurnJudge(port, { append: async (d: readonly EventDraft[]) => { rows.push(...d); } } as unknown as TurnEventWriter, "t", new JudgmentLatency(() => now))!;
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i += 1) { await judge("observation-review", question, signal); now += 2_000; }
  now += BREAKER_COOLDOWN_MS;
  const probe = judge("observation-review", question, signal);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await judge("skill-relevance", question, signal), undefined, "skipped while the probe is out");
  assert.equal(calls, 4);
  release();
  assert.ok(await probe);
});

test("a call that was cancelled, or failed in transport, is not a stall; a probe it was leaves the next call to probe", async () => {
  const { ask, breakerRows, tick, asked } = rig((seam) => seam === "skill-relevance" ? "cancel" : seam === "result-relevance" ? "transport" : 4_000);
  const aborted = new AbortController(); aborted.abort(new Error("review done"));
  for (let i = 0; i < 4; i += 1) { await assert.rejects(ask("skill-relevance", aborted.signal)); tick(2_000); }
  for (let i = 0; i < 4; i += 1) { assert.equal(await ask("result-relevance"), undefined); tick(2_000); }
  assert.equal(breakerRows().length, 0, "cancels and transport errors count for nothing");
  // A stall, an unrelated cancel and a transport error between stalls do not break or extend the run: only timeouts count.
  await ask("observation-review"); tick(2_000);
  await ask("observation-review"); tick(2_000);
  await ask("result-relevance"); tick(2_000);
  await ask("observation-review");
  assert.equal(breakerRows().length, 1);
  tick(BREAKER_COOLDOWN_MS);
  await assert.rejects(ask("skill-relevance", aborted.signal));
  const askedAfterCancelledProbe = asked.length;
  assert.equal(await ask("observation-review"), undefined);
  assert.equal(asked.length, askedAfterCancelledProbe + 1, "the cancelled probe decided nothing: the next call is asked as the probe");
  assert.deepEqual(breakerRows().map((row) => row.reason), ["breaker: open 60000 ms", "breaker: probe", "breaker: probe", "breaker: open 60000 ms"]);
});

test("a healthy judge interleaved with 1.5 s background answers never opens the breaker and never changes a deciding seam's deadline", async () => {
  const { ask, asked, breakerRows, tick } = rig((seam) => seam === "action-gate" || seam === "step-claim" ? 1_500 : 100);
  for (let i = 0; i < 20; i += 1) {
    await ask("action-gate"); await ask(advisory[i % 3]!); await ask("step-claim"); await ask("completion-audit"); tick(2_000);
  }
  assert.equal(breakerRows().length, 0);
  assert.ok(asked.filter(({ seam }) => seam === "completion-audit").every(({ options }) => options?.timeoutMs === JUDGMENT_ATTEMPT_TIMEOUT_MS));
});

test("a stall of a background or deciding seam does not count towards the breaker", async () => {
  const { ask, breakerRows, tick } = rig((seam) => seam === "observation-review" ? 100 : 20_000);
  for (let i = 0; i < 6; i += 1) { await ask(["completion-audit", "procedure-audit", "skill-suggestion", "action-gate", "step-claim"][i % 5]!); tick(2_000); }
  assert.equal(breakerRows().length, 0);
  assert.ok(await ask("observation-review"));
});

test("a cancelled turn still throws from a skipped call, as it does from an asked one", async () => {
  const { ask, tick } = rig(() => 4_000);
  for (let i = 0; i < 3; i += 1) { await ask("observation-review"); tick(2_000); }
  const aborted = new AbortController(); aborted.abort(new Error("turn cancelled"));
  await assert.rejects(ask("skill-relevance", aborted.signal), /turn cancelled/u);
});
