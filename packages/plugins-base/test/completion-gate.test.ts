import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentRequest, LlmAdapter, TurnControlPolicy, TurnControlServices, TurnTerminalDecision } from "@0xsyncroot/contracts";
import { figuresInSources } from "../src/audit/verbatim-figures.js";
import { arbitratedByModel, COMPLETION_CROSS_QUESTIONS, COMPLETION_QUESTIONS, COMPLETION_ROUNDS, firstRoundRequest, goalAuditInput, readCriteria, readCross, unmetProcedureCriteria, withCompletionAudit, withoutRuntimeFacts } from "../src/index.js";

const n = (noul: number) => ({ type: "noul" as const, noul });

const events = [
  { eventId: "e1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "Tổng thực lĩnh tháng 9?" } },
  { eventId: "e2", seq: 2, turnId: "t1", type: "tool/result", payload: { toolId: "read_sheet", dispatched: true, state: "succeeded", result: { rows: [{ amount: 40 }, { amount: 60 }] } } },
];
const state = (withEvidence = true) => ({
  turnId: "t1", taskTurnIds: ["t1"], context: { events: withEvidence ? events : events.slice(0, 1) },
  directive: {}, candidate: { content: "Tổng thực lĩnh là 100.", finishReason: "stop" },
}) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];

function inner(decision: TurnTerminalDecision): TurnControlPolicy {
  return { id: "p", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => decision };
}
function model(reply: string, calls: { n: number }): LlmAdapter {
  return { model: "fake", async *stream() { calls.n++; yield { type: "final", content: reply, toolCalls: [], finishReason: "stop", status: "completed", usage: {} }; } } as unknown as LlmAdapter;
}
// Answers every question of whichever round is asked: probabilities for yes/no questions, a label for `kind`.
const judgeWith = (p: Record<string, number>, asked: string[], kind = "result"): TurnControlServices => ({
  judge: async (seam: string, request: JudgmentRequest) => {
    asked.push(`${seam}:${Object.keys(request.questions)[0]}`);
    return { modelId: "fake", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, question.type === "choice"
      ? { type: "choice" as const, choice: kind, confidence: 0.98, probabilities: { [kind]: 0.98 } } : { type: "noul" as const, noul: p[id] ?? 0 }])) };
  },
});
const signal = new AbortController().signal;
const notice = () => "Yêu cầu chưa hoàn tất.";
const phrases = { notDelivered: "kết quả được yêu cầu", contradicted: "số liệu chưa có trong dữ liệu đã đọc", unsupportedAbsence: "nói không có khi chưa xem", computedFigure: "cộng lại con số" };
const CLEAR = { delivers: 1, contradicted: 0, unsupportedAbsence: 0, derivedFigure: 0, supported: 1, looked: 1 };

test("the product's own objection stands and nothing is asked", async () => {
  const asked: string[] = [];
  const gate = withCompletionAudit(inner({ decision: "continue", feedback: "đọc tiếp", workRemains: true }), { notice, phrases });
  const decision = await gate.policy.reviewTerminal(state(), signal, judgeWith(CLEAR, asked));
  assert.equal(decision.decision, "continue");
  assert.deepEqual(asked, []);
});

test("a clear first round keeps the product's accepted answer and its notice: one judgment, no model call", async () => {
  const asked: string[] = [], calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept", notice: "Ghi chú của sản phẩm" }), { notice, phrases });
  gate.bindModel(model('{"achieved":false,"missing":["x"],"unsupported":[]}', calls));
  const decision = await gate.policy.reviewTerminal(state(), signal, judgeWith(CLEAR, asked));
  assert.deepEqual(decision, { decision: "accept", notice: "Ghi chú của sản phẩm" });
  assert.deepEqual([asked, calls.n], [["completion-audit:ending", "completion-audit:delivers"], 0], "how it ends is asked first, apart from the rounds");
});

test("a doubt is settled by the judge's own cross-check, not by the model", async () => {
  const asked: string[] = [], calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  gate.bindModel(model('{"achieved":false,"missing":["x"],"unsupported":[]}', calls));
  const decision = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, delivers: 0.6 }, asked));
  assert.deepEqual(decision, { decision: "accept" });
  assert.deepEqual([asked, calls.n], [["completion-audit:ending", "completion-audit:delivers", "completion-audit:kind"], 0]);
});

test("a clear failure sends the work on with the product's words for what the judge objected to", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept", notice: "Ghi chú của sản phẩm" }), { notice, phrases });
  const decision = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, delivers: 0.01, contradicted: 0.99 }, []));
  assert.equal(decision.decision, "continue");
  if (decision.decision !== "continue") return;
  assert.equal(decision.workRemains, true);
  assert.match(decision.feedback, /kết quả được yêu cầu/u);
  assert.match(decision.feedback, /số liệu chưa có trong dữ liệu đã đọc/u);
  assert.equal(decision.fallback, "Yêu cầu chưa hoàn tất.\nGhi chú của sản phẩm");
  assert.equal(decision.delivered, undefined, "an answer the judge found not delivered is never marked as one");
});

test("an objection beside a delivered result is marked delivered: a figure the judge objects to alone, or a done criterion", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  const absent = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, unsupportedAbsence: 0.99 }, []));
  assert.deepEqual([absent.decision, absent.decision === "continue" && absent.delivered], ["continue", true]);
  const undelivered = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, delivers: 0.01, unsupportedAbsence: 0.99 }, []));
  assert.deepEqual([undelivered.decision, undelivered.decision === "continue" && undelivered.delivered], ["continue", undefined]);
});

test("an objection that is only about figures is settled by the model audit; any other is the judge's own", async () => {
  const calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  gate.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', calls));
  const figures = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, contradicted: 0.99 }, []));
  assert.deepEqual([figures.decision, calls.n], ["accept", 1], "the judge fails one correct multi-figure answer in five: the model looks");
  const absence = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, unsupportedAbsence: 0.99 }, []));
  assert.deepEqual([absence.decision, calls.n], ["continue", 1], "an unsupported absence is the judge's to fail");
});

test("an answer stating a computed figure goes back once to be recomputed, then stands on the other criteria", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  const first = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, derivedFigure: 0.9 }, []));
  assert.equal(first.decision, "continue");
  if (first.decision === "continue") assert.match(first.feedback, /cộng lại con số/u);
  // The journal now holds that judgment: the same answer is not sent back for it a second time.
  const judged = { eventId: "j1", seq: 3, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { derivedFigure: { type: "noul", value: 0.9 } } } };
  const again = { ...state(), context: { events: [...events, judged] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  assert.deepEqual(await gate.policy.reviewTerminal(again, signal, judgeWith({ ...CLEAR, derivedFigure: 0.9 }, [])), { decision: "accept" });
});

test("without evidence only the ending is judged; a judge that cannot be had leaves it to the model audit", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  // An answer given without any tool is audited too. The evidence rounds stay out: with no results they fail greetings.
  const asked: string[] = [];
  assert.deepEqual(await gate.policy.reviewTerminal(state(false), signal, judgeWith(CLEAR, asked, "done")), { decision: "accept" });
  assert.deepEqual(asked, ["completion-audit:ending"], "how it ends is judged, the rounds are not asked");
  const handBack = await gate.policy.reviewTerminal(state(false), signal, judgeWith(CLEAR, [], "continue"));
  assert.equal(handBack.decision, "continue", "a tool-less answer that hands the work back goes back");
  assert.deepEqual(await gate.policy.reviewTerminal(state(), signal, {}), { decision: "accept" }, "no judge and no bound model: no verdict, the answer stands");
  const calls = { n: 0 };
  gate.bindModel(model('{"achieved":false,"missing":["đọc bảng lương tháng 9"],"unsupported":[]}', calls));
  const fallback = await gate.policy.reviewTerminal(state(), signal, { judge: async () => undefined });
  assert.deepEqual([fallback.decision, calls.n], ["continue", 1]);
  assert.match(gate.policy.revision, /\+completion-audit$/u);
});

test("a computed figure with the calculator offered and never used always goes back, and is never arbitrated away", async () => {
  // Differences worked out by hand, flagged contradicted + derived, must not pass through the "figures only" arbitration.
  // With `calculate` offered, only computing clears it.
  const calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  gate.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', calls));
  const offered = (extra: unknown[] = []) => ({ ...state(), availableTools: [{ id: "calculate", computes: true }, { id: "reconcile_tables", computes: true }], context: { events: [...events, ...extra] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const judged = { eventId: "j1", seq: 3, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { derivedFigure: { type: "noul", value: 0.9 } } } };
  const byHand = await gate.policy.reviewTerminal(offered([judged]), signal, judgeWith({ ...CLEAR, contradicted: 0.99, derivedFigure: 0.9 }, []));
  assert.deepEqual([byHand.decision, calls.n], ["continue", 0], "sent back by the judge alone, even after a first send-back, and the model audit is not asked");
  if (byHand.decision === "continue") assert.match(byHand.feedback, /cộng lại con số/u);
  const computed = { eventId: "c1", seq: 4, turnId: "t1", type: "tool/result", payload: { toolId: "calculate", dispatched: true, state: "succeeded", result: { value: { total: 100 } } } };
  const afterCalculating = await gate.policy.reviewTerminal(offered([computed]), signal, judgeWith({ ...CLEAR, contradicted: 0.99, derivedFigure: 0.9 }, []));
  assert.deepEqual([afterCalculating.decision, calls.n], ["accept", 1], "once computed, a figures-only objection goes to the model audit as before");
  const reconciled = { ...computed, payload: { ...computed.payload, toolId: "reconcile_tables" } };
  const afterReconciling = await gate.policy.reviewTerminal(offered([reconciled]), signal, judgeWith({ ...CLEAR, contradicted: 0.99, derivedFigure: 0.9 }, []));
  assert.deepEqual([afterReconciling.decision, calls.n], ["accept", 2], "any tool declaring `computes` counts as computed — by its flag, not a name the audit keeps");
  // A correct reconciliation from reconcile_tables does not go back "to recompute" its totals.
  const firstTime = await gate.policy.reviewTerminal(offered([reconciled]), signal, judgeWith({ ...CLEAR, derivedFigure: 0.9 }, []));
  assert.deepEqual([firstTime.decision, calls.n], ["accept", 2], "figures code computed are not sent back to be recomputed");
});

test("a hand-back goes back on the ending alone: no rounds, no model, the runtime's words for it", async () => {
  // A full report that ends by asking whether to look further passes every criterion; the ending alone sends it back.
  const asked: string[] = [];
  const calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases: { ...phrases, handsBack: "phần việc còn lại", unprovenBlocker: "thử cách khác" } });
  gate.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', calls));
  const decision = await gate.policy.reviewTerminal(state(), signal, judgeWith(CLEAR, asked, "continue"));
  assert.deepEqual([decision.decision, asked, calls.n], ["continue", ["completion-audit:ending"], 0]);
  if (decision.decision === "continue") assert.match(decision.feedback, /hands the work back.*Do that step yourself now/su);
  if (decision.decision === "continue") assert.equal(decision.delivered, undefined, "work handed back delivers nothing");
});

test("a passing answer is held to the loaded procedure's done criteria: a clearly unmet one goes back by name, doubt passes", async () => {
  // The generic questions pass an answer that skips a step the procedure requires; the done criteria catch it.
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["Mỗi người lệch thuộc một nhóm nguyên nhân có căn cứ.", "Mọi số lấy từ kết quả công cụ."] } } };
  const withSkill = () => ({ ...state(), context: { events: [...events, loaded] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on" });
  const procedure = (met: number[]): TurnControlServices => {
    let n = 0;
    return { judge: async (seam: string, request: JudgmentRequest) => {
      if (seam === "procedure-audit") return { modelId: "fake", answers: { met: { type: "noul" as const, noul: met[n++] ?? 1 } } };
      return judgeWith(CLEAR, []).judge!(seam, request, signal);
    } } as TurnControlServices;
  };
  const unmet = await gate.policy.reviewTerminal(withSkill(), signal, procedure([0.05, 0.9]));
  assert.equal(unmet.decision, "continue");
  if (unmet.decision === "continue") {
    assert.match(unmet.feedback, /Mỗi người lệch thuộc một nhóm nguyên nhân có căn cứ\./u, "the unmet criterion is named");
    assert.doesNotMatch(unmet.feedback, /Mọi số lấy từ kết quả công cụ/u, "a met criterion is not");
    assert.equal(unmet.workRemains, true, "bounded like every work-remains objection");
    assert.equal(unmet.delivered, true, "a done criterion is asked only of an answer the rounds passed");
    assert.match(unmet.feedback, /from the results you already have/u, "a missing section is completed from what was read");
    assert.doesNotMatch(unmet.feedback, /re-read the screen/u, "not sent back to the screen for it");
  }
  assert.deepEqual(await gate.policy.reviewTerminal(withSkill(), signal, procedure([0.5, 0.6])), { decision: "accept" }, "doubt lets the answer stand");
  assert.deepEqual(await gate.policy.reviewTerminal(state(), signal, procedure([0.01])), { decision: "accept" }, "no procedure loaded: nothing to hold it to");
  // At most two objecting rounds per task: after two, the next answer stands — rounds in an
  // earlier turn of the same task count, rounds of another task do not. A round is a contiguous run of the seam's judgments.
  const judged = (answers: Record<string, unknown>, turnId: string, seq: number) => ({ eventId: `j${seq}`, seq, turnId, type: "judgment/classified", payload: { seam: "procedure-audit", answers } });
  const gap = (turnId: string, seq: number) => ({ eventId: `g${seq}`, seq, turnId, type: "turn/control-decision", payload: { decision: "continue" } });
  const after = (rounds: readonly Record<string, unknown>[][], turnIds: readonly string[]) => ({ ...state(), taskTurnIds: ["t0", "t1"],
    context: { events: [...events, loaded, ...rounds.flatMap((round, r) => [...round.map((answers, i) => judged(answers, turnIds[r] ?? "t1", 10 + r * 10 + i)), gap(turnIds[r] ?? "t1", 19 + r * 10)])] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const unmetRound = [{ met: { type: "noul", value: 0.05 } }, { met: { type: "noul", value: 0.9 } }];
  assert.equal((await gate.policy.reviewTerminal(after([unmetRound], ["t1"]), signal, procedure([0.05, 0.9]))).decision, "continue", "one objecting round: judged again");
  assert.deepEqual(await gate.policy.reviewTerminal(after([unmetRound, unmetRound], ["t0", "t1"]), signal, procedure([0.05, 0.05])), { decision: "accept" },
    "two objecting rounds in the task, one in an earlier turn: the answer stands");
  assert.equal((await gate.policy.reviewTerminal(after([unmetRound, unmetRound], ["t-other", "t1"]), signal, procedure([0.05, 0.9]))).decision, "continue",
    "a round of another task does not count");
  const conditionalOnly = [{ met: { type: "noul", value: 0.05 }, applies: { type: "noul", value: 0.1 } }];
  assert.equal((await gate.policy.reviewTerminal(after([conditionalOnly, conditionalOnly], ["t0", "t1"]), signal, procedure([0.05, 0.9]))).decision,
    "continue", "rounds whose only unmet criterion did not apply objected to nothing");
});

test("a loaded procedure the task's request does not call for is not held to its criteria; one it calls for is", async () => {
  // A one-person lookup that loaded the reconciliation skill is not held to that skill's criteria.
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] } } };
  const skills = [{ id: "x.screen", name: "screen", description: "read the open screen" }, { id: "x.recon", name: "reconcile", description: "compare two payrolls" }];
  const withSkill = () => ({ ...state(), availableSkills: skills, context: { events: [...events, loaded] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on" });
  const judged = (fits: number, asked: string[]): TurnControlServices => ({ judge: async (seam: string, request: JudgmentRequest) => {
    if (seam !== "procedure-audit") return judgeWith(CLEAR, []).judge!(seam, request, signal);
    const key = Object.keys(request.questions)[0]!;
    asked.push(key);
    return { modelId: "fake", answers: { [key]: { type: "noul" as const, noul: key === "fits" ? fits : 0.01 } } };
  } } as TurnControlServices);
  const lookup: string[] = [];
  assert.deepEqual(await gate.policy.reviewTerminal(withSkill(), signal, judged(0.01, lookup)), { decision: "accept" });
  assert.deepEqual(lookup, ["fits"], "not called for: no criterion is asked");
  const reconciliation: string[] = [];
  assert.equal((await gate.policy.reviewTerminal(withSkill(), signal, judged(1, reconciliation))).decision, "continue");
  assert.deepEqual(reconciliation, ["fits", "met"]);
});

test("a figure added up by hand is sent to the computing tool on the stored results, not back to read them", async () => {
  // "Re-read before stating any figure" would send the agent to read the file again, draft after draft.
  const { goalAuditFeedback } = await import("../src/index.js");
  const feedback = goalAuditFeedback({ achieved: false, missing: ["kiểm lại con số"], unsupported: [], flags: ["computedFigure"] },
    { request: "r", answer: "a", steps: [], evidence: [], computingTools: ["calculate", "compare_tables"] });
  assert.match(feedback, /comes from calculate or compare_tables run on the stored results: they are kept whole, so compute — do not read them again/u);
  assert.doesNotMatch(feedback, /read_result/u, "nothing was contradicted: no re-reading");
});

test("by default the procedure criteria are judged and journaled but never send an answer back", async () => {
  // Sending answers back on the criteria is a product's choice; by default it only measures (history in the procedure audit).
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] } } };
  const withSkill = () => ({ ...state(), context: { events: [...events, loaded] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const asked: string[] = [];
  const services = { judge: async (seam: string, request: JudgmentRequest) => {
    if (seam !== "procedure-audit") return judgeWith(CLEAR, []).judge!(seam, request, signal);
    asked.push(Object.keys(request.questions)[0]!);
    return { modelId: "fake", answers: { met: { type: "noul" as const, noul: 0.01 } } };
  } } as TurnControlServices;
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  assert.deepEqual(await gate.policy.reviewTerminal(withSkill(), signal, services), { decision: "accept" });
  assert.deepEqual(asked, ["met"], "the criterion was still asked, so the journal keeps the judgment");
});

test("a turn carried on from the user's answer to the agent's own form is not held to the report's criteria; the runtime's continue question is", async () => {
  // After the user answers the proposal form, the fixing turn is not sent back for the report's criteria.
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] } } };
  const answered = (requesterId?: string) => ({ eventId: "s2", seq: 4, turnId: "t1", type: "interaction/resolved", payload: { interactionId: "i1", action: "accept", ...(requesterId ? { requesterId } : {}) } });
  const withAnswer = (requesterId?: string) => ({ ...state(), context: { events: [...events, loaded, answered(requesterId)] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const services = { judge: async (seam: string, request: JudgmentRequest) => seam !== "procedure-audit" ? judgeWith(CLEAR, []).judge!(seam, request, signal)
    : { modelId: "fake", answers: { met: { type: "noul" as const, noul: 0.01 } } } } as TurnControlServices;
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on" });
  assert.deepEqual(await gate.policy.reviewTerminal(withAnswer(), signal, services), { decision: "accept" }, "the agent's form was answered");
  assert.equal((await gate.policy.reviewTerminal(withAnswer("runtime"), signal, services)).decision, "continue", "the runtime's continue question resumes the same work");
  // An approval of a write answered in an earlier turn of the same task counts too; a read-only permission does not.
  const asked = (sideEffect: string) => ({ eventId: "s2a", seq: 4, turnId: "t0", type: "approval/requested", payload: { approvalId: "a1", toolId: "x_tool", sideEffect } });
  const approved = { eventId: "s3", seq: 5, turnId: "t0", type: "approval/resolved", payload: { approvalId: "a1", decision: "approve" } };
  const afterApproval = (sideEffect: string) => ({ ...state(), taskTurnIds: ["t0", "t1"], context: { events: [...events, loaded, asked(sideEffect), approved] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  assert.deepEqual(await gate.policy.reviewTerminal(afterApproval("idempotent"), signal, services), { decision: "accept" }, "a write approved earlier in the task");
  assert.equal((await gate.policy.reviewTerminal(afterApproval("none"), signal, services)).decision, "continue",
    "the screen permission at the start of a task leaves the report to be judged");
  // Pauses the runtime closed because the user wrote something else were never answered.
  const closed = (type: string) => ({ eventId: "s4", seq: 6, turnId: "t1", type, payload: { approvalId: "a1", interactionId: "i1", decision: "superseded", resolvedBy: "runtime" } });
  for (const type of ["approval/resolved", "interaction/resolved"]) {
    const afterClosed = { ...state(), taskTurnIds: ["t1"], context: { events: [...events, loaded, asked("idempotent"), closed(type)] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
    assert.equal((await gate.policy.reviewTerminal(afterClosed, signal, services)).decision, "continue", `${type} closed by the runtime is no answer`);
  }
});

test("a conditional criterion (\"<condition> => <requirement>\") is held only to answers its condition describes", async () => {
  // A conditional rule asked as one question fails every answer its condition does not describe; asked beside its
  // requirement, a case that only resembled the condition was taken for one. The condition is asked alone, first.
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["explains a code from the file => the meaning has a source, or the code is marked to confirm"] } } };
  const withSkill = () => ({ ...state(), context: { events: [...events, loaded] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on" });
  let asked: string[] = [];
  const judged = (applies: number, met: number): TurnControlServices => ({ judge: async (seam: string, request: JudgmentRequest) => {
    if (seam !== "procedure-audit") return judgeWith(CLEAR, []).judge!(seam, request, signal);
    const ids = Object.keys(request.questions);
    assert.equal(ids.length, 1, "one question per call");
    asked.push(ids[0]!);
    if (ids[0] === "applies") assert.match(String((request.questions.applies as { instructions: string }).instructions), /exactly what this condition describes: "explains a code from the file"/u);
    return { modelId: "fake", answers: { [ids[0]!]: { type: "noul" as const, noul: ids[0] === "applies" ? applies : met } } };
  } } as TurnControlServices);
  assert.deepEqual(await gate.policy.reviewTerminal(withSkill(), signal, judged(0.02, 0.01)), { decision: "accept" }, "not concerned: not held to it");
  assert.deepEqual(asked, ["applies"], "the requirement is not asked where the condition does not hold");
  asked = [];
  const unmet = await gate.policy.reviewTerminal(withSkill(), signal, judged(0.98, 0.01));
  assert.deepEqual(asked, ["applies", "met"], "the condition first, then the requirement");
  assert.equal(unmet.decision, "continue", "concerned and unmet: sent back");
  if (unmet.decision === "continue") {
    assert.match(unmet.feedback, /\(1\) the meaning has a source, or the code is marked to confirm \(required because your answer does this: explains a code from the file\)/u,
      "the model reads the requirement and why it applies, never the raw separator");
    assert.doesNotMatch(unmet.feedback, /=>/u);
  }
  assert.deepEqual(await gate.policy.reviewTerminal(withSkill(), signal, judged(0.98, 0.9)), { decision: "accept" }, "concerned and met");
});

test("a proven blocker is accepted as the task's partial end once its figures hold: no continue card, only the product's own notice", async () => {
  // The criteria rounds have no notion of blocked: on a proven blocker they would answer "not delivered" and send it back.
  // The rounds still run where there is evidence: "not delivered" is the blocker itself, a contradicted figure is not.
  const blockedJudge = (asked: string[], p: Record<string, number> = { delivers: 0, contradicted: 0, unsupportedAbsence: 0, derivedFigure: 0 }): TurnControlServices => ({ judge: async (seam: string, request: JudgmentRequest) => {
    asked.push(`${seam}:${Object.keys(request.questions)[0]}`);
    return { modelId: "fake", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, id === "ending"
      ? { type: "choice" as const, choice: "blocked", confidence: 0.99, probabilities: { blocked: 0.99, done: 0.01 } }
      : request.questions[id]!.type === "choice" ? { type: "choice" as const, choice: "progress", confidence: 0.99, probabilities: { progress: 0.99 } }
        : { type: "noul" as const, noul: p[id] ?? 0 }])) };
  } });
  const claim = (seq: number) => ({ eventId: `b${seq}`, seq, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { ending: { type: "choice", choice: "blocked", value: 0.99 } } } });
  const twice = { ...state(), context: { events: [...events, claim(3), claim(4)] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const asked: string[] = [], calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept", notice: "Ghi chú của sản phẩm" }), { notice, phrases });
  gate.bindModel(model('{"achieved":false,"missing":["x"],"unsupported":[]}', calls));
  const decision = await gate.policy.reviewTerminal(twice, signal, blockedJudge(asked));
  assert.deepEqual(decision, { decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú của sản phẩm" });
  assert.deepEqual([asked, calls.n], [["completion-audit:ending", "completion-audit:delivers"], 0],
    "the criteria round is asked; its \"not delivered\" and \"absent\" are the blocker itself");
  assert.ok(!(decision.decision === "accept" && decision.reason?.startsWith("work-remains-")), "not the runtime's limit: no continue card");
  // A figure the evidence contradicts is wrong whatever stopped the rest: it goes back, without "not delivered" in what it reads.
  // A figures-only objection is the model audit's to settle, as for any answer; what it finds missing is the blocker.
  const figures = { delivers: 0, contradicted: 0.99, unsupportedAbsence: 0, derivedFigure: 0 };
  const checked = (reply: string, n: { n: number }) => { const g = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases }); g.bindModel(model(reply, n)); return g; };
  const confirmed = { n: 0 };
  const contradicted = await checked('{"achieved":false,"missing":["đối soát tệp"],"unsupported":["Tổng 100 — dữ liệu là 90"]}', confirmed).policy.reviewTerminal(twice, signal, blockedJudge([], figures));
  assert.deepEqual([contradicted.decision, confirmed.n], ["continue", 1]);
  if (contradicted.decision === "continue") {
    assert.match(contradicted.feedback, /Tổng 100 — dữ liệu là 90/u);
    assert.doesNotMatch(contradicted.feedback, /đối soát tệp/u, "the blocker is not objected to again");
    assert.equal(contradicted.workRemains, true);
  }
  const cleared = await checked('{"achieved":false,"missing":["đối soát tệp"],"unsupported":[]}', { n: 0 }).policy.reviewTerminal(twice, signal, blockedJudge([], figures));
  assert.deepEqual(cleared, { decision: "accept", outcome: "partial", reason: "blocker-proven" }, "the model audit finds the figures hold");
  // A doubt goes to the cross-check, which for a proven blocker weighs only whether its statements are in the evidence.
  const crossAsked: string[] = [];
  const doubted = await gate.policy.reviewTerminal(twice, signal, blockedJudge(crossAsked, { delivers: 0, contradicted: 0.5, unsupportedAbsence: 0, derivedFigure: 0, supported: 1, looked: 0 }));
  assert.deepEqual([doubted, crossAsked], [{ decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú của sản phẩm" },
    ["completion-audit:ending", "completion-audit:delivers", "completion-audit:kind"]], "its kind (\"progress\") and the absence are the blocker itself");
  // A product's own rounds that still name the blocker's consequences: those flags alone send nothing back.
  const own = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, rounds: [{ id: "own", questions: { delivers: { type: "noul", instructions: "x", criteria: { true: "y", false: "n" } } },
    state: () => ({}), read: () => ({ verdict: "fail" as const, flags: ["notDelivered", "unsupportedAbsence"] }) }] });
  assert.deepEqual(await own.policy.reviewTerminal(twice, signal, blockedJudge([])), { decision: "accept", outcome: "partial", reason: "blocker-proven" });
  const absence = await gate.policy.reviewTerminal(twice, signal, blockedJudge([], { delivers: 0, contradicted: 0, unsupportedAbsence: 0.99, derivedFigure: 0 }));
  assert.deepEqual(absence, { decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú của sản phẩm" }, "an absence it could not look for is the blocker itself");
  const byHand = await gate.policy.reviewTerminal(twice, signal, blockedJudge([], { delivers: 0, contradicted: 0, unsupportedAbsence: 0, derivedFigure: 0.9 }));
  assert.equal(byHand.decision, "continue", "a figure added up by hand goes back once to be computed, as before");
  if (byHand.decision === "continue") assert.match(byHand.feedback, /cộng lại con số/u);
  // The same answer before the journal proves it still goes back as an unproven blocker.
  const first = await gate.policy.reviewTerminal(state(), signal, blockedJudge([]));
  assert.equal(first.decision, "continue");
  // Without a tool result: a call refused because its source is down this turn proves it on the first answer.
  const refused = { eventId: "r1", seq: 2, turnId: "t1", type: "tool/result", payload: { toolId: "mcp_office-docs_read_document", state: "not_started", dispatched: false,
    unavailable: "source-unavailable", error: { type: "tool_error", code: "validation", retryable: false, message: "Tool mcp_office-docs_read_document is not available" },
    attempt: { signature: "mcp_office-docs_read_document {}", failure: "validation", failures: 1 } } };
  const bare = { ...state(), context: { events: [events[0], refused] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const bareAsked: string[] = [];
  const accepted = await gate.policy.reviewTerminal(bare, signal, blockedJudge(bareAsked));
  assert.deepEqual(accepted, { decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú của sản phẩm" });
  assert.deepEqual(bareAsked, ["completion-audit:ending"]);
  assert.doesNotMatch(JSON.stringify(accepted), /mcp_office-docs|validation/u, "no tool name or error code reaches the user");
  // Files attached while the source that reads them is down: the turn's own fact proves it, no call needed.
  const attached = { eventId: "e1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "Đối soát tệp này", attachments: [{ id: "doc_1", name: "luong.xlsx", mediaType: "x", byteSize: 10 }] } };
  const readerDown = { ...state(false), context: { events: [attached] }, unavailable: { sources: [{ sourceId: "mcp_office-docs", readsAttachments: true }], withheldTools: [] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  assert.deepEqual(await gate.policy.reviewTerminal(readerDown, signal, blockedJudge([])), { decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú của sản phẩm" });
});

test("the procedure audit fails open on a judge error, and stops when the turn was stopped", async () => {
  const { unmetProcedureCriteria } = await import("../src/index.js");
  const procedures = [{ skillId: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] }];
  const audited = { request: "đối soát", answer: "Tổng chênh 0.", steps: [], evidence: [] };
  const failing = async () => { throw new Error("judge unavailable"); };
  assert.deepEqual(await unmetProcedureCriteria(procedures, audited, state() as never, failing, signal), [], "a judge that cannot be had settles nothing");
  const stopped = new AbortController();
  const aborting = async () => { stopped.abort(new Error("turn stopped")); throw new Error("aborted"); };
  await assert.rejects(unmetProcedureCriteria(procedures, audited, state() as never, aborting, stopped.signal), /aborted/u, "an abort is not read as \"nothing unmet\"");
});

test("three failed calls elsewhere do not settle a blocked answer: it is judged on delivery and goes back", async () => {
  // Three mislabelled clicks on other targets, then "the Save button is locked" after one try.
  const clicks = [1, 2, 3].map((i) => ({ eventId: `c${i}`, seq: 2 + i, turnId: "t1", type: "tool/result", payload: { toolId: "ui_click", state: "failed", dispatched: true,
    error: { code: "validation", retryable: false, message: "label" }, attempt: { signature: `click ${i}`, failure: "label mismatch", failures: 1 } } }));
  const tried = { ...state(), context: { events: [...events, ...clicks] } } as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const asked: string[] = [];
  const blocked: TurnControlServices = { judge: async (seam: string, request: JudgmentRequest) => {
    asked.push(Object.keys(request.questions)[0]!);
    if ("ending" in request.questions) return { modelId: "fake", answers: { ending: { type: "choice" as const, choice: "blocked", confidence: 0.99, probabilities: { blocked: 0.99 } } } };
    return judgeWith({ ...CLEAR, delivers: 0 }, []).judge!(seam, request, signal);
  } };
  const decision = await withCompletionAudit(inner({ decision: "accept" }), { notice, phrases }).policy.reviewTerminal(tried, signal, blocked);
  assert.equal(decision.decision, "continue");
  if (decision.decision === "continue") {
    assert.match(decision.feedback, /kết quả được yêu cầu/u, "not delivered, as before");
    assert.doesNotMatch(decision.feedback, /reports a step as blocked/u, "no longer an unproven blocker either");
  }
  assert.deepEqual(asked, ["ending", "delivers"]);
});

test("AGENTIC_JUDGMENT_MODE=shadow: the gate asks the ending and the rounds, and the model audit alone decides", async () => {
  const loaded = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
    result: { id: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] } } };
  const claim = (seq: number) => ({ eventId: `b${seq}`, seq, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { ending: { type: "choice", choice: "blocked", value: 0.99 } } } });
  const with_ = (extra: unknown[]) => ({ ...state(), context: { events: [...events, ...extra] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const asked: string[] = [], calls = { n: 0 };
  const services = (kind: string): TurnControlServices => ({ judge: async (seam: string, request: JudgmentRequest) => {
    if (seam === "procedure-audit") { asked.push("met"); return { modelId: "fake", answers: { met: { type: "noul" as const, noul: 0.01 } } }; }
    return judgeWith({ ...CLEAR, delivers: 0 }, asked, kind).judge!(seam, request, signal);
  } });
  const shadowed = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on", judgmentShadow: true });
  shadowed.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', calls));
  // A hand-back the ending would send back, rounds that would fail it, and an unmet criterion: the model audit passes it.
  assert.deepEqual(await shadowed.policy.reviewTerminal(with_([loaded]), signal, services("continue")), { decision: "accept" });
  assert.deepEqual([asked.includes("completion-audit:ending"), asked.includes("completion-audit:delivers"), asked.includes("met"), calls.n], [true, true, true, 1],
    "every judgment is still asked (core journals them)");
  // A proven blocker is not accepted early in shadow: the model audit's verdict stands.
  const notDone = { n: 0 };
  const strict = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, judgmentShadow: true });
  strict.bindModel(model('{"achieved":false,"missing":["đối soát tệp"],"unsupported":[]}', notDone));
  assert.equal((await strict.policy.reviewTerminal(with_([claim(4), claim(5)]), signal, services("blocked"))).decision, "continue");
  // Without a tool result the ending alone was judged; in shadow nothing goes back.
  assert.deepEqual(await strict.policy.reviewTerminal(state(false), signal, services("continue")), { decision: "accept" });
  // With the judgment acting, the same hand-back goes back.
  assert.equal((await withCompletionAudit(inner({ decision: "accept" }), { notice, phrases }).policy.reviewTerminal(state(false), signal, services("continue"))).decision, "continue");
});

test("the user declined the write and the agent says it will not write: accepted at once; a write that went through after it is judged as usual", async () => {
  // A denial settles a blocked answer only while nothing has gone past it.
  const denied = { eventId: "d1", seq: 5, turnId: "t2", type: "tool/result", payload: { toolId: "payroll_update_employee", state: "denied", dispatched: false,
    error: { code: "denied", retryable: false, message: "Người dùng từ chối" } } };
  const readBack = [{ eventId: "i2", seq: 6, turnId: "t2", type: "tool/intent", payload: { callId: "r2", executionId: "x-r2", toolId: "read_sheet", arguments: "{}", state: "prepared", sideEffect: "none" } },
    { eventId: "r2", seq: 7, turnId: "t2", type: "tool/result", payload: { callId: "r2", executionId: "x-r2", toolId: "read_sheet", dispatched: true, state: "succeeded", result: { total: 100 } } }];
  const after = [{ eventId: "i3", seq: 8, turnId: "t2", type: "tool/intent", payload: { callId: "w3", executionId: "x-w3", toolId: "payroll_add_employee_allowance", arguments: "{}", state: "prepared", sideEffect: "idempotent" } },
    { eventId: "r3", seq: 9, turnId: "t2", type: "tool/result", payload: { callId: "w3", executionId: "x-w3", toolId: "payroll_add_employee_allowance", dispatched: true, state: "succeeded", result: { ok: true } } }];
  const resumed = (extra: unknown[]) => ({ ...state(), turnId: "t2", taskTurnIds: ["t1", "t2"], context: { events: [...events, denied, ...extra] } }) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
  const blocked = (asked: string[]): TurnControlServices => ({ judge: async (seam: string, request: JudgmentRequest) => {
    asked.push(Object.keys(request.questions)[0]!);
    if ("ending" in request.questions) return { modelId: "fake", answers: { ending: { type: "choice" as const, choice: "blocked", confidence: 0.99, probabilities: { blocked: 0.99 } } } };
    return judgeWith({ ...CLEAR, delivers: 0 }, []).judge!(seam, request, signal);
  } });
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  const asked: string[] = [];
  assert.deepEqual(await gate.policy.reviewTerminal(resumed([]), signal, blocked(asked)), { decision: "accept", outcome: "partial", reason: "blocker-proven" });
  assert.deepEqual(asked, ["ending", "delivers"], "its figures are still weighed");
  assert.deepEqual(await gate.policy.reviewTerminal(resumed(readBack), signal, blocked([])), { decision: "accept", outcome: "partial", reason: "blocker-proven" },
    "reading the value back to report it unchanged does not go past the refusal");
  const moved = await gate.policy.reviewTerminal(resumed(after), signal, blocked([]));
  assert.equal(moved.decision, "continue", "a later blocked report rests on more than the old denial");
  if (moved.decision === "continue") assert.doesNotMatch(moved.feedback, /reports a step as blocked/u, "the denial still counts as trying");
});

// The judgments of a terminal review that do not depend on the ending are asked together with it.
type Review = Parameters<TurnControlPolicy["reviewTerminal"]>[0];
type Call = { readonly key: string; readonly seam: string; readonly start: number; end?: number; aborted?: boolean };

/** A judge that answers after `latency` ms, honours the abort signal and logs when each call started, ended or was cancelled. */
function slowJudge(latency: number, p: Record<string, number>, calls: Call[], kind = "result"): TurnControlServices {
  return { judge: async (seam: string, request: JudgmentRequest, abort: AbortSignal) => {
    const call: Call = { key: Object.keys(request.questions)[0]!, seam, start: performance.now() };
    calls.push(call);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, latency);
      abort.addEventListener("abort", () => { clearTimeout(timer); call.aborted = true; reject(abort.reason); }, { once: true });
    });
    call.end = performance.now();
    return { modelId: "fake", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, question.type === "choice"
      ? { type: "choice" as const, choice: kind, confidence: 0.98, probabilities: { [kind]: 0.98 } } : { type: "noul" as const, noul: p[id] ?? 0 }])) };
  } };
}
const calculator = [{ id: "calculate", computes: true }];
const reviewOf = (extra: Record<string, unknown> = {}, more: unknown[] = []) =>
  ({ ...state(), availableTools: calculator, context: { events: [...events, ...more] }, ...extra }) as unknown as Review;
const LATENCY = 150;
const recon = { eventId: "s1", seq: 3, turnId: "t1", type: "tool/result", payload: { toolId: "skill_load", dispatched: true, state: "succeeded",
  result: { id: "x.recon", done: ["Nêu tổng chênh trên cùng tập người."] } } };
const skills = [{ id: "x.screen", name: "screen", description: "read the open screen" }, { id: "x.recon", name: "reconcile", description: "compare two payrolls" }];

test("terminal review: with the ending passing and no procedure loaded, the review takes about one judgment, not two", async () => {
  const calls: Call[] = [];
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  const started = performance.now();
  assert.deepEqual(await gate.policy.reviewTerminal(reviewOf(), signal, slowJudge(LATENCY, CLEAR, calls)), { decision: "accept" });
  const took = performance.now() - started;
  assert.deepEqual(calls.map((c) => c.key), ["ending", "delivers"], "the same two questions, the ending first");
  assert.ok(took >= LATENCY - 10 && took < LATENCY * 1.7, `one judgment latency (${LATENCY} ms), took ${Math.round(took)} ms`);
});

test("terminal review: a procedure the request calls for adds its criteria after the applicability, about two judgments in all; criteria are never asked early", async () => {
  const calls: Call[] = [];
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases, procedureAudit: "on" });
  const started = performance.now();
  const judge = slowJudge(LATENCY, { ...CLEAR, fits: 1, met: 1 }, calls);
  assert.deepEqual(await gate.policy.reviewTerminal(reviewOf({ availableSkills: skills }, [recon]), signal, judge), { decision: "accept" });
  const took = performance.now() - started;
  assert.deepEqual(calls.map((c) => c.key), ["ending", "delivers", "fits", "met"]);
  const fits = calls.find((c) => c.key === "fits")!, met = calls.find((c) => c.key === "met")!;
  assert.ok(met.start >= fits.end!, "the criteria wait for the applicability");
  assert.ok(took >= 2 * LATENCY - 10 && took < 3 * LATENCY, `two judgment latencies, took ${Math.round(took)} ms`);
  // A procedure the request does not call for: its criteria are never asked, early or late.
  const lookup: Call[] = [];
  assert.deepEqual(await gate.policy.reviewTerminal(reviewOf({ availableSkills: skills }, [recon]), signal, slowJudge(20, { ...CLEAR, fits: 0.01, met: 0 }, lookup)), { decision: "accept" });
  assert.deepEqual(lookup.map((c) => c.key), ["ending", "delivers", "fits"]);
});

test("terminal review: the first round waits for the ending unless its journal row cannot change a later reading", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  const plain = { ...state() } as unknown as Review; // no computing tool offered, no figure sent back yet
  const waiting: Call[] = [];
  const handedBack = await gate.policy.reviewTerminal(plain, signal, slowJudge(10, CLEAR, waiting, "continue"));
  assert.deepEqual([handedBack.decision, waiting.map((c) => c.key)], ["continue", ["ending"]], "an ending that sends the answer back leaves no round-1 row");
  // The next review of the same task: the figure was never sent back, so it still goes back once to be recomputed. A round-1
  // row left by the hand-back (derivedFigure 0.99) would have made the next review read it as already sent back.
  const journaled: unknown[] = [];
  const journaling: TurnControlServices = { judge: async (seam: string, request: JudgmentRequest, abort: AbortSignal) => {
    const answered = await slowJudge(5, { ...CLEAR, derivedFigure: 0.99 }, [], journaled.length === 0 ? "continue" : "result").judge!(seam, request, abort);
    journaled.push({ eventId: `j${journaled.length}`, seq: 10 + journaled.length, turnId: "t1", type: "judgment/classified", payload: { seam, answers:
      Object.fromEntries(Object.entries(answered!.answers).map(([id, a]) => [id, a.type === "noul" ? { type: "noul", value: a.noul } : { type: "choice", choice: a.type === "choice" ? a.choice : "", value: 0.98 }])) } });
    return answered;
  } };
  assert.equal((await gate.policy.reviewTerminal(plain, signal, journaling)).decision, "continue");
  assert.equal(journaled.length, 1, "only the ending was asked and journaled");
  const next = await gate.policy.reviewTerminal(reviewOf({ availableTools: undefined }, journaled), signal, journaling);
  assert.equal(next.decision, "continue");
  if (next.decision === "continue") assert.match(next.feedback, /cộng lại con số|figure/u, "the computed figure is still sent back once");
  // Where the row cannot matter, round 1 starts with the ending (a calculator was offered and never used).
  const early: Call[] = [];
  await gate.policy.reviewTerminal(reviewOf(), signal, slowJudge(10, CLEAR, early, "continue"));
  assert.deepEqual(early.map((c) => c.key), ["ending", "delivers"]);
  const sentBack = { eventId: "j9", seq: 9, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { derivedFigure: { type: "noul", value: 0.9 } } } };
  assert.equal(goalAuditInput(reviewOf({ availableTools: undefined }, [sentBack]), "a", () => false)!.computedFigureChecked, true);
  const alreadyChecked: Call[] = [];
  await gate.policy.reviewTerminal(reviewOf({ availableTools: undefined }, [sentBack]), signal, slowJudge(10, CLEAR, alreadyChecked, "continue"));
  assert.deepEqual(alreadyChecked.map((c) => c.key), ["ending", "delivers"], "a figure already sent back: the row changes nothing, so round 1 is early");
});

test("terminal review: the proven-blocker path reuses the first round asked ahead and reads it as a blocker", async () => {
  // The request is the same with or without `provenBlocker` (the runtime's facts never reach the judge), so one call serves both.
  const audited = goalAuditInput(reviewOf(), "Tổng thực lĩnh là 100.", () => false)!;
  assert.deepEqual(firstRoundRequest(COMPLETION_ROUNDS, { ...audited, provenBlocker: true }), firstRoundRequest(COMPLETION_ROUNDS, audited),
    "the state invariant that makes the reuse identical to asking again");
  const claim = (seq: number) => ({ eventId: `b${seq}`, seq, turnId: "t1", type: "judgment/classified", payload: { seam: "completion-audit", answers: { ending: { type: "choice", choice: "blocked", value: 0.99 } } } });
  const rounds: { id: string; verdict: string }[] = [];
  const gate = withCompletionAudit(inner({ decision: "accept", notice: "Ghi chú" }), { notice, phrases, onJudged: (record) => rounds.push(...record.rounds) });
  const calls: Call[] = [];
  // delivers 0 ("not delivered") passes the first round only when it is read as a proven blocker.
  const decision = await gate.policy.reviewTerminal(reviewOf({}, [claim(3), claim(4)]), signal, slowJudge(20, { ...CLEAR, delivers: 0 }, calls, "blocked"));
  assert.deepEqual(decision, { decision: "accept", outcome: "partial", reason: "blocker-proven", notice: "Ghi chú" });
  assert.deepEqual(calls.map((c) => c.key), ["ending", "delivers"], "round 1 was asked once");
  assert.deepEqual(rounds.map((r) => `${r.id}:${r.verdict}`), ["criteria:pass"]);
});

test("terminal review: stopping the turn mid-review rejects with the stop and asks no model audit", async () => {
  const modelCalls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
  gate.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', modelCalls));
  const turn = new AbortController();
  const calls: Call[] = [];
  const review = gate.policy.reviewTerminal(reviewOf(), turn.signal, slowJudge(500, CLEAR, calls));
  const settled = assert.rejects(review, (error: unknown) => error === turn.signal.reason);
  setImmediate(() => turn.abort(new Error("turn stopped")));
  await settled;
  assert.equal(modelCalls.n, 0, "no LLM audit after an abort");
  assert.deepEqual(calls.map((c) => [c.key, c.aborted]), [["ending", true], ["delivers", true]], "everything in flight was cancelled with the turn");
});

test("terminal review: calls asked ahead and not read are cancelled when the review returns, and their rejection is never unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases });
    // The ending answers at once and hands the work back; round 1, asked beside it, is still out.
    const calls: Call[] = [];
    const judge: TurnControlServices = { judge: async (seam: string, request: JudgmentRequest, abort: AbortSignal) =>
      slowJudge("ending" in request.questions ? 5 : 2_000, CLEAR, calls, "continue").judge!(seam, request, abort) };
    const started = performance.now();
    const decision = await gate.policy.reviewTerminal(reviewOf(), signal, judge);
    assert.equal(decision.decision, "continue");
    assert.ok(performance.now() - started < 500, "the review did not wait for the call it did not need");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.map((c) => [c.key, c.aborted === true]), [["ending", false], ["delivers", true]]);
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

/** A knowledge-style search that found nothing, and the same search with an item: `notFound` is the tool's own result field. */
const nothing = { items: [], searched: { query: "giới thiệu sản phẩm" }, threshold: 0.45, notFound: true };
const searchTurn = (result: unknown, extra: readonly unknown[] = []) => ({
  turnId: "t1", taskTurnIds: ["t1"], directive: {}, candidate: { content: "Em đã tra cứu tài liệu nhưng chưa tìm thấy nội dung này.", finishReason: "stop" },
  context: { events: [
    { eventId: "s1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "Sản phẩm là gì?" } },
    { eventId: "s2", seq: 2, turnId: "t1", type: "tool/result", payload: { toolId: "docs_search", dispatched: true, state: "succeeded", result } }, ...extra] },
}) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];

test("a search that found nothing is a runtime fact of the audit input, kept from what the judges read", () => {
  const audited = goalAuditInput(searchTurn(nothing), "Chưa tìm thấy.", () => false)!;
  assert.deepEqual(audited.notFound, [{ tool: "docs_search", searched: { query: "giới thiệu sản phẩm" } }]);
  assert.equal("notFound" in withoutRuntimeFacts(audited), false);
  assert.equal(JSON.stringify(COMPLETION_ROUNDS.map((round) => round.state(audited))).includes("\"notFound\":[{"), false, "every round reads it only inside the evidence");
  assert.equal(goalAuditInput(searchTurn({ items: [{ title: "x" }], searched: {} }), "a", () => false)!.notFound, undefined, "items returned: no fact");
  const failed = searchTurn(nothing, [{ eventId: "s3", seq: 3, turnId: "t0", type: "tool/result", payload: { toolId: "docs_search", dispatched: true, state: "succeeded", result: nothing } },
    { eventId: "s4", seq: 4, turnId: "t1", type: "tool/result", payload: { toolId: "docs_search", dispatched: true, state: "failed", result: nothing } }]);
  assert.equal(goalAuditInput(failed, "a", () => false)!.notFound?.length, 1, "only the task's succeeded results count");
  const withItems = { eventId: "s5", seq: 5, turnId: "t1", type: "tool/result", payload: { toolId: "docs_search", dispatched: true, state: "succeeded", result: { items: [{ title: "x" }] } } };
  assert.equal(goalAuditInput(searchTurn(nothing, [withItems]), "a", () => false)!.notFound, undefined, "the same tool returned items once: no fact (K2-L4)");
  const otherTool = { ...withItems, payload: { ...withItems.payload, toolId: "payroll_read" } };
  assert.equal(goalAuditInput(searchTurn(nothing, [otherTool]), "a", () => false)!.notFound?.length, 1, "another tool's results do not count against it");
});

test("with the fact, not delivered and absence without looking are the answer itself; what it states is still weighed", () => {
  const empty = { request: "r", answer: "a", steps: [], evidence: [], notFound: [{ tool: "docs_search" }] };
  const objecting = { delivers: n(0), contradicted: n(0), unsupportedAbsence: n(1), derivedFigure: n(0), screensUnsupported: n(0) };
  assert.deepEqual(readCriteria(objecting, empty), { verdict: "pass", flags: [] });
  assert.deepEqual(readCriteria(objecting, { ...empty, notFound: undefined }), { verdict: "fail", flags: ["notDelivered", "unsupportedAbsence"] });
  assert.deepEqual(readCriteria({ ...objecting, contradicted: n(0.99) }, empty).flags, ["contradicted"]);
  assert.deepEqual(readCriteria({ ...objecting, screensUnsupported: n(0.99) }, empty).flags, ["screensUnsupported"]);
  const cross = { kind: { type: "choice" as const, choice: "progress", confidence: 0.99, probabilities: { progress: 0.99 } }, supported: n(1), looked: n(0), screensUnsupported: n(0) };
  assert.deepEqual(readCross(cross, empty), { verdict: "pass", flags: [] });
  assert.deepEqual(readCross(cross, { ...empty, notFound: undefined }), { verdict: "fail", flags: ["notDelivered", "unsupportedAbsence"] });
});

test("through the gate: an honest not-found after an empty search stands; after a search with items it goes back as before", async () => {
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases: { ...phrases, screensUnsupported: "thao tác chưa có", handsBack: "phần còn lại" } });
  const handsBack = (p: Record<string, number>, asked: string[]) => ({ judge: async (seam: string, request: JudgmentRequest) => {
    if ("ending" in request.questions) return { modelId: "fake", answers: { ending: { type: "choice" as const, choice: "continue", confidence: 0.99, probabilities: { continue: 0.99 } } } };
    return judgeWith(p, asked).judge!(seam, request, signal);
  } });
  assert.deepEqual(await gate.policy.reviewTerminal(searchTurn(nothing), signal, handsBack({ ...CLEAR, delivers: 0 }, [])), { decision: "accept" });
  assert.equal((await gate.policy.reviewTerminal(searchTurn({ items: [{ title: "x" }] }), signal, handsBack(CLEAR, []))).decision, "continue");
  assert.equal((await gate.policy.reviewTerminal(searchTurn(nothing), signal, judgeWith({ ...CLEAR, delivers: 0 }, []))).decision, "accept");
  assert.equal((await gate.policy.reviewTerminal(searchTurn({ items: [{ title: "x" }] }), signal, judgeWith({ ...CLEAR, delivers: 0 }, []))).decision, "continue");
});

test("screen steps are their own question, in every round, and never go to the figures arbitration", async () => {
  for (const questions of [COMPLETION_QUESTIONS, COMPLETION_CROSS_QUESTIONS]) assert.ok(questions.screensUnsupported, "asked in every round");
  const folded = JSON.stringify([COMPLETION_QUESTIONS.contradicted, COMPLETION_CROSS_QUESTIONS.supported]);
  assert.doesNotMatch(folded, /\b(?:menus?|buttons?|screens?|tabs?)\b/iu, "contradicted and supported weigh values only");
  assert.deepEqual([arbitratedByModel(["screensUnsupported"]), arbitratedByModel(["contradicted", "screensUnsupported"]), arbitratedByModel(["contradicted"])], [false, false, true]);
  assert.deepEqual(readCriteria({ delivers: n(1), contradicted: n(0), unsupportedAbsence: n(0), derivedFigure: n(0) }), { verdict: "pass", flags: [] }, "a round that does not ask it raises nothing");
  const calls = { n: 0 };
  const gate = withCompletionAudit(inner({ decision: "accept" }), { notice, phrases: { ...phrases, screensUnsupported: "thao tác chưa có" } });
  gate.bindModel(model('{"achieved":true,"missing":[],"unsupported":[]}', calls));
  const screens = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, contradicted: 0.99, screensUnsupported: 0.99 }, []));
  assert.deepEqual([screens.decision, calls.n], ["continue", 0], "the judge decides screen steps; the model audit is not asked");
  if (screens.decision === "continue") assert.match(screens.feedback, /thao tác chưa có.*only as a tool result shows or describes it/su);
  const figures = await gate.policy.reviewTerminal(state(), signal, judgeWith({ ...CLEAR, contradicted: 0.99 }, []));
  assert.deepEqual([figures.decision, calls.n], ["accept", 1], "figures alone: arbitrated as before");
});

test("the procedure criteria read the searches that found nothing, only when every search of that tool came back empty (K2-L4)", async () => {
  const states: unknown[] = [];
  const ask = async (request: { readonly state: unknown }) => { states.push(request.state); return { answers: { met: { type: "noul", noul: 1 }, applies: { type: "noul", noul: 0 } } }; };
  const criteria = (turn: Parameters<TurnControlPolicy["reviewTerminal"]>[0]) =>
    unmetProcedureCriteria([{ skillId: "docs", done: ["Ý lấy từ tài liệu => dẫn nguồn."] }], goalAuditInput(turn, "Chưa tìm thấy.", () => false)!, turn, ask, signal);
  await criteria(searchTurn(nothing));
  const withItems = { eventId: "s5", seq: 5, turnId: "t1", type: "tool/result", payload: { toolId: "docs_search", dispatched: true, state: "succeeded", result: { items: [{ title: "x" }] } } };
  await criteria(searchTurn(nothing, [withItems]));
  await criteria(searchTurn({ items: [{ title: "x" }] }));
  assert.deepEqual(states, [
    { request: "Sản phẩm là gì?", answer: "Chưa tìm thấy.", searchesThatFoundNothing: [{ tool: "docs_search", searched: { query: "giới thiệu sản phẩm" } }] },
    { request: "Sản phẩm là gì?", answer: "Chưa tìm thấy." },
    { request: "Sản phẩm là gì?", answer: "Chưa tìm thấy." },
  ], "a search that returned items once: the state is the request and the answer, as before");
});

test("a figure the evidence writes in another separator convention is the same figure; codes and words are not figures", () => {
  const list = JSON.stringify({ nodes: [{ role: "cell", label: "1132885748" }, { role: "cell", label: "4.09" }, { role: "cell", ref: "e62", label: "NV001" }] });
  assert.equal(figuresInSources("Tổng chi trả là 1.132.885.748 đồng, hệ số 4,09.", [list]), true);
  assert.equal(figuresInSources("Total 1,132,885,748.", ["Tổng: 1.132.885.748"]), true);
  assert.equal(figuresInSources("Hệ số 5,20.", ["5.2"]), true, "trailing decimal zeros");
  assert.equal(figuresInSources("Tổng là 1.132.885.753.", [list]), false, "a total the evidence does not write");
  assert.equal(figuresInSources("Mã 62 có 1 dòng.", [list]), false, "e62 is a ref and NV001 a code: neither writes 62 or 1");
  assert.equal(figuresInSources("Không có phụ cấp nào.", [list]), false, "no figure in digits: nothing is cleared, the judge's reading stands");
  assert.equal(figuresInSources("Còn 3 dòng.", []), false);
  assert.equal(figuresInSources("Bản 1.2.3.", ["1.2.3"]), false, "a string that is no number in either convention is never cleared");
});

test("a tool result's JSON numbers are read one by one: the commas between items never join two figures", () => {
  const result = JSON.stringify({ amounts: [42000000, 38500000], rate: 0.3, note: "Tổng 80.500.000" });
  assert.equal(figuresInSources("Hai khoản 42.000.000 và 38.500.000, tổng 80.500.000, tỷ lệ 0,3.", [result]), true);
  assert.equal(figuresInSources("Khoản 42.000.000,385.", [result]), false, "two adjacent items are not one figure");
});

const viewEvents = (result: unknown) => [
  { eventId: "e1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "Tổng chi trả đợt 1?" } },
  { eventId: "e2", seq: 2, turnId: "t1", type: "tool/result", payload: { toolId: "get_current_view", dispatched: true, state: "succeeded", result } },
];
const reviewOfView = (answer: string, result: unknown) => ({
  turnId: "t1", taskTurnIds: ["t1"], context: { events: viewEvents(result) }, directive: {}, availableTools: [{ id: "calculate", computes: true }],
  candidate: { content: answer, finishReason: "stop" },
}) as unknown as Parameters<TurnControlPolicy["reviewTerminal"]>[0];
const accepting: TurnControlPolicy = { id: "p", revision: "1", beforeModelStep: async () => ({}), reviewTerminal: async () => ({ decision: "accept" }) as TurnTerminalDecision };
const judgeAll = (p: Record<string, number>): TurnControlServices => ({
  judge: async (_seam: string, request: JudgmentRequest) => ({ modelId: "fake", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, question.type === "choice"
    ? { type: "choice" as const, choice: "result", confidence: 0.98, probabilities: { result: 0.98 } } : n(p[id] ?? 0)])) }),
});
const figurePhrases = { notDelivered: "kết quả", contradicted: "số liệu", unsupportedAbsence: "không có", computedFigure: "cộng lại con số" };

test("a total the list itself prints is not a computed figure: no send-back to recompute, calculator unused or not", async () => {
  const gate = withCompletionAudit(accepting, { notice: () => "chưa xong", phrases: figurePhrases });
  const scored = { delivers: 1, contradicted: 0, unsupportedAbsence: 0, derivedFigure: 0.84 };
  const printed = { nodes: [{ role: "cell", label: "Đợt 1" }, { role: "cell", label: "1.132.885.748" }] };
  assert.deepEqual(await gate.policy.reviewTerminal(reviewOfView("Tổng chi trả đợt 1 là 1.132.885.748 đồng.", printed), signal, judgeAll(scored)), { decision: "accept" });
  const parts = { nodes: [{ role: "cell", label: "Đợt 1" }, { role: "cell", label: "1.000.000.000" }, { role: "cell", label: "132.885.748" }] };
  const added = await gate.policy.reviewTerminal(reviewOfView("Tổng chi trả đợt 1 là 1.132.885.748 đồng.", parts), signal, judgeAll(scored));
  assert.equal(added.decision, "continue", "a sum of the rows, by hand, while the calculator went unused, still goes back");
  if (added.decision === "continue") assert.match(added.feedback, /cộng lại con số/u);
});

test("the fact is the runtime's: read from whole results, kept from what the judges read, and it clears only the computed-figure question", () => {
  const long = { nodes: [{ role: "note", label: "x".repeat(20_000) }, { role: "cell", label: "1.132.885.748" }] };
  const audited = goalAuditInput(reviewOfView("Tổng là 1.132.885.748.", long), "Tổng là 1.132.885.748.", () => false)!;
  assert.equal(audited.figuresInEvidence, true, "a figure past the audit's cut of a result is still in what the task read");
  assert.ok(!audited.evidence[0]!.result.includes("1.132.885.748"), "the judge's copy is cut before it");
  assert.equal("figuresInEvidence" in withoutRuntimeFacts(audited), false);
  const answers = { delivers: n(1), contradicted: n(0.99), unsupportedAbsence: n(0), derivedFigure: n(0.9), screensUnsupported: n(0) };
  assert.deepEqual(readCriteria(answers, audited), { verdict: "fail", flags: ["contradicted"] }, "a figure that contradicts the evidence is still the judge's to raise");
});
