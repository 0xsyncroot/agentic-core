import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentAnswer, JudgmentRequest } from "@0xsyncroot/contracts";
import { createJudgedAuditor, firstRoundRequest, passesNeeded, type AuditJudge, type JudgmentRound, type RoundVerdict } from "../src/index.js";

/** The judge decides, cross-checked by itself: what each sequence of round verdicts comes to. */
type Verdict = { ok: boolean; flags?: readonly string[] } | "model";
const signal = new AbortController().signal;
const noul = (p: number): JudgmentAnswer => ({ type: "noul", noul: p });
// Each round asks one question named after itself; the scripted probability decides its verdict.
const round = (id: string): JudgmentRound<string> => ({
  id, questions: { [id]: { type: "noul", instructions: `${id}?` } }, state: (input) => `${id}:${input}`,
  read: (answers) => { const p = (answers[id] as { noul: number }).noul; return p >= 0.9 ? { verdict: "pass", flags: [] } : p <= 0.1 ? { verdict: "fail", flags: [`${id}-failed`] } : { verdict: "doubt", flags: [`${id}-doubt`] }; },
});
const P = 0.99, F = 0.01, D = 0.5;
function run(script: readonly (number | "down")[], extra: Record<string, unknown> = {}, rounds = ["a", "b", "c"]) {
  const asked: string[] = []; const model = { n: 0 };
  const judge: AuditJudge = async (request: JudgmentRequest) => {
    const id = Object.keys(request.questions)[0]!; asked.push(id);
    const next = script[asked.length - 1];
    if (next === "down" || next === undefined) return undefined;
    return { modelId: "fake", answers: { [id]: noul(next) } };
  };
  const audit = createJudgedAuditor<string, Verdict>({
    rounds: rounds.map(round), passedVerdict: { ok: true }, failedVerdict: (flags) => ({ ok: false, flags }),
    modelAudit: async () => { model.n++; return "model"; }, ...extra,
  });
  return { result: audit("x", signal, judge), asked, model };
}

test("a clear first round decides alone, either way", async () => {
  const pass = run([P]); assert.deepEqual([await pass.result, pass.asked, pass.model.n], [{ ok: true }, ["a"], 0]);
  const fail = run([F]); assert.deepEqual([await fail.result, fail.asked, fail.model.n], [{ ok: false, flags: ["a-failed"] }, ["a"], 0]);
});

test("after a doubt the other rounds are asked: two passes carry it, anything less does not, and a clear failure ends it", async () => {
  const carried = run([D, P, P]); assert.deepEqual([await carried.result, carried.asked], [{ ok: true }, ["a", "b", "c"]]);
  // A failure carries the flags of the round that decided it: an earlier doubt a later round answered is settled.
  const short = run([D, P, D]); assert.deepEqual(await short.result, { ok: false, flags: ["c-doubt"] });
  const hopeless = run([D, D]); assert.deepEqual([await hopeless.result, hopeless.asked], [{ ok: false, flags: ["b-doubt"] }, ["a", "b"]], "a third round could no longer make two passes");
  const failed = run([D, F]); assert.deepEqual([await failed.result, failed.asked], [{ ok: false, flags: ["b-failed"] }, ["a", "b"]]);
  const late = run([D, P, F]); assert.deepEqual(await late.result, { ok: false, flags: ["c-failed"] });
  assert.deepEqual([passesNeeded(1), passesNeeded(2), passesNeeded(3)], [1, 1, 2]);
  const two = run([D, P], {}, ["a", "b"]); assert.deepEqual(await two.result, { ok: true }, "with two rounds the cross-check settles a doubt");
});

test("the model audit is only the fallback for a judge that cannot be had", async () => {
  const down = run(["down"]); assert.deepEqual([await down.result, down.model.n], ["model", 1]);
  const midway = run([D, "down"]); assert.deepEqual([await midway.result, midway.model.n], ["model", 1], "a round that cannot be had settles nothing");
  const none = createJudgedAuditor<string, Verdict>({ rounds: [round("a")], passedVerdict: { ok: true }, failedVerdict: () => ({ ok: false }) });
  assert.equal(await none("x", signal), undefined, "no judge and no model audit: no verdict");
  const never = run([P]); await never.result; assert.equal(never.model.n, 0, "a judge that answers is never second-guessed by the model");
});

test("records carry every round; shadow runs the model too and returns its verdict; a cancelled turn is not swallowed", async () => {
  const records: { decision: string; rounds: readonly { id: string; verdict: RoundVerdict }[] }[] = [];
  const seen = run([D, P, P], { onJudged: (record: never) => records.push(record) });
  await seen.result;
  assert.deepEqual([records[0]!.decision, records[0]!.rounds.map((r) => `${r.id}:${r.verdict}`)], ["pass", ["a:doubt", "b:pass", "c:pass"]]);
  const compared: string[] = [];
  const shadow = run([P], { shadow: (record: { decision: string }, verdict: Verdict | undefined) => compared.push(`${record.decision}/${String(verdict)}`) });
  assert.deepEqual([await shadow.result, compared, shadow.model.n], ["model", ["pass/model"], 1]);
  const controller = new AbortController(); controller.abort();
  const cancelled = createJudgedAuditor<string, Verdict>({ rounds: [round("a")], passedVerdict: { ok: true }, failedVerdict: () => ({ ok: false }) });
  await assert.rejects(cancelled("x", controller.signal, async () => { throw new Error("aborted"); }));
});

test("a failure the judge is not trusted to declare alone is settled by the model audit; the others stand as the judge's", async () => {
  const arbitrated = (flags: readonly string[]) => flags.every((flag) => flag.startsWith("a-"));
  const disputed = run([F], { arbitrated });
  assert.deepEqual([await disputed.result, disputed.model.n], ["model", 1]);
  const own = run([D, F], { arbitrated });
  assert.deepEqual([await own.result, own.model.n], [{ ok: false, flags: ["b-failed"] }, 0], "an objection from another round is the judge's to make");
  // The deciding round's objection alone decides whether the model settles it: an earlier round's doubt does not block it.
  const later = run([D, F], { arbitrated: (flags: readonly string[]) => flags.every((flag) => flag.startsWith("b-")) });
  assert.deepEqual([await later.result, later.model.n], ["model", 1]);
  const records: string[] = [];
  await run([F], { arbitrated, onJudged: (record: { decision: string }) => records.push(record.decision) }).result;
  assert.deepEqual(records, ["arbitrated"]);
});

test("a first round asked ahead is read instead of asked again; every later round is asked as before", async () => {
  const asked: string[] = [];
  const judge: AuditJudge = async (request: JudgmentRequest) => { asked.push(Object.keys(request.questions)[0]!); return { modelId: "fake", answers: { [asked.at(-1)!]: noul(asked.length === 1 ? 0.5 : 1) } }; };
  const model = { n: 0 };
  const audit = createJudgedAuditor<string, Verdict>({ rounds: ["a", "b"].map(round), passedVerdict: { ok: true }, failedVerdict: (flags) => ({ ok: false, flags }), modelAudit: async () => { model.n++; return "model"; } });
  const early = judge(audit.firstRound("x"), signal);
  const records: { rounds: readonly { id: string; elapsedMs: number }[] }[] = [];
  const watched = createJudgedAuditor<string, Verdict>({ rounds: ["a", "b"].map(round), passedVerdict: { ok: true }, failedVerdict: (flags) => ({ ok: false, flags }),
    onJudged: (record: never) => records.push(record) });
  assert.deepEqual(await audit("x", signal, judge, { firstRound: early }), { ok: true });
  assert.deepEqual([asked, model.n], [["a", "b"], 0], "round a was asked once, ahead; the doubt it left was cross-checked by an ordinary call");
  const startedAt = performance.now() - 5_000;
  await watched("x", signal, judge, { firstRound: judge(watched.firstRound("x"), signal), startedAt });
  assert.ok(records[0]!.rounds[0]!.elapsedMs >= 5_000, "a pre-asked round is timed from when it was started, not from when the audit began to wait for it");
});

test("the request a pre-asked first round carries is the one the audit would have asked", () => {
  const rounds = ["a", "b"].map(round);
  assert.deepEqual(firstRoundRequest(rounds, "x"), { state: rounds[0]!.state("x"), questions: rounds[0]!.questions });
  assert.deepEqual(createJudgedAuditor<string, Verdict>({ rounds, passedVerdict: { ok: true }, failedVerdict: () => ({ ok: false }) }).firstRound("x"), firstRoundRequest(rounds, "x"));
});

test("a pre-asked first round that was cancelled with the turn rejects the audit, and one that failed on its own is a round that cannot be had", async () => {
  const model = { n: 0 };
  const audit = createJudgedAuditor<string, Verdict>({ rounds: [round("a")], passedVerdict: { ok: true }, failedVerdict: () => ({ ok: false }), modelAudit: async () => { model.n++; return "model"; } });
  const stopped = new AbortController();
  const early = Promise.reject(new Error("turn stopped"));
  early.catch(() => undefined);
  stopped.abort();
  await assert.rejects(audit("x", stopped.signal, async () => undefined, { firstRound: early }), /turn stopped/u);
  assert.equal(model.n, 0, "no model audit after a cancelled turn");
  const failed = Promise.reject(new Error("gateway reset"));
  failed.catch(() => undefined);
  assert.deepEqual([await audit("x", signal, async () => undefined, { firstRound: failed }), model.n], ["model", 1]);
});

test("an arbitrated failure is recorded with what the model audit decided, once it has decided", async () => {
  const records: { decision: string; arbitration?: string }[] = [];
  const order: string[] = [];
  const arbitrating = (model: Verdict | undefined) => createJudgedAuditor<string, Verdict>({
    rounds: [round("a")], passedVerdict: { ok: true }, failedVerdict: (flags) => ({ ok: false, flags }), arbitrated: () => true,
    modelAudit: async () => { order.push("model"); return model; }, passes: (verdict) => verdict !== "model" && verdict.ok,
    onJudged: (record) => { order.push("record"); records.push(record); },
  });
  const judge: AuditJudge = async () => ({ modelId: "fake", answers: { a: noul(F) } });
  assert.deepEqual(await arbitrating({ ok: true })("x", signal, judge), { ok: true });
  assert.deepEqual(await arbitrating({ ok: false })("x", signal, judge), { ok: false });
  assert.deepEqual(await arbitrating(undefined)("x", signal, judge), { ok: false, flags: ["a-failed"] }, "no verdict: the judge's failure stands");
  assert.deepEqual(records.map((record) => [record.decision, record.arbitration]), [["arbitrated", "pass"], ["arbitrated", "fail"], ["arbitrated", "unavailable"]]);
  assert.deepEqual(order, ["model", "record", "model", "record", "model", "record"], "the record follows the arbitration");
  const unread = createJudgedAuditor<string, Verdict>({ rounds: [round("a")], passedVerdict: { ok: true }, failedVerdict: () => ({ ok: false }), arbitrated: () => true,
    modelAudit: async () => ({ ok: true }), onJudged: (record) => records.push(record) });
  await unread("x", signal, judge);
  assert.equal(records.at(-1)!.arbitration, undefined, "without `passes` the record names no arbitration");
});
