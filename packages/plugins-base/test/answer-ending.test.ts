import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgmentAnswer, SessionEvent } from "@0xsyncroot/contracts";
import { attemptEvidence, blockerFinal, blockerProven, endingFeedback, goalAuditInput, judgeEnding, readCriteria, readEnding, type AttemptEvidence } from "../src/index.js";

/**
 * How an answer ends decides whether a turn may end on it, for any product and tool: a hand-back
 * always goes back; a blocked step goes back until the journal proves it (three failed calls, a
 * denial, or the third time the same answer is given). The judge names the ending; the runtime counts.
 */

const ending = (choice: string, probabilities: Record<string, number>): JudgmentAnswer => ({ type: "choice", choice, confidence: probabilities[choice] ?? 0, probabilities });
const none: AttemptEvidence = { failures: 0, denied: false, stillDenied: false, unavailable: false, blockedClaims: 0, finalRefusal: false, tried: [] };
const CLEAR = { delivers: { type: "noul", noul: 1 }, contradicted: { type: "noul", noul: 0 }, unsupportedAbsence: { type: "noul", noul: 0 }, derivedFigure: { type: "noul", noul: 0 } } as const;

test("a hand-back fails whatever the answer reports; an offer of extras after a finished result does not", async () => {
  assert.deepEqual(readEnding(ending("continue", { continue: 0.99, done: 0.01 }), none), ["handsBack"]);
  assert.deepEqual(readEnding(ending("delegate", { delegate: 0.6, continue: 0.39, done: 0.01 }), none), ["handsBack"], "asking the user to do it, or to allow going on: both hand back");
  assert.deepEqual(readEnding(ending("done", { done: 0.75, continue: 0.25 }), none), [], "a doubt is not a hand-back");
  assert.deepEqual(readEnding(ending("decision", { decision: 1 }), none), []);
  // Asked on the request, the plan and the answer only: the evidence drowned the answer's last lines (0.996 "done" live).
  const seen: unknown[] = [];
  const input = { request: "r", goal: "g", steps: [], answer: "a", evidence: [{ tool: "t", state: "succeeded", result: "x".repeat(50_000) }], attempts: none };
  const reading = await judgeEnding(input, async (request) => { seen.push(request.state); return { modelId: "f", answers: { ending: ending("continue", { continue: 1 }) } }; }, new AbortController().signal);
  assert.deepEqual(reading, { flags: ["handsBack"], choice: "continue", confidence: 1, provenBlocker: false });
  assert.deepEqual(seen, [{ request: "r", goal: "g", steps: [], answer: "a" }]);
  assert.deepEqual(readCriteria({ ...CLEAR, ending: ending("continue", { continue: 1 }) }, input), { verdict: "pass", flags: [] }, "the rounds no longer read the ending");
});

test("a blocked step stands only on evidence: three failures, a denial, or the third time it is reported", () => {
  const blocked = ending("blocked", { blocked: 0.99, done: 0.01 });
  assert.deepEqual(readEnding(blocked, none), ["unprovenBlocker"]);
  assert.deepEqual(readEnding(blocked, { ...none, failures: 2 }), ["unprovenBlocker"]);
  assert.deepEqual(readEnding(blocked, { ...none, failures: 3 }), []);
  assert.deepEqual(readEnding(blocked, { ...none, denied: true }), []);
  assert.deepEqual(readEnding(blocked, { ...none, blockedClaims: 2 }), [], "never a loop: the third report stands");
  assert.deepEqual(readEnding(ending("blocked", { blocked: 0.6, done: 0.4 }), none), [], "only a clear reading counts");
  assert.deepEqual(readEnding(blocked, undefined), [], "no journal facts: nothing to prove against");
});

test("the evidence is counted from the task's journal: attempts on results, denials, earlier blocked endings", () => {
  const event = (type: string, turnId: string, payload: unknown) => ({ type, turnId, payload }) as unknown as SessionEvent;
  const events = [
    event("tool/result", "t1", { state: "succeeded", attempt: { signature: "ui_press {\"label\":\"Xóa\"}", failure: "target-covered", failures: 2 } }),
    event("tool/result", "t1", { state: "succeeded", attempt: { signature: "read_table {}", failures: 0 } }),
    event("judgment/classified", "t1", { seam: "completion-audit", answers: { ending: { type: "choice", choice: "blocked", value: 0.99 } } }),
    event("judgment/classified", "t1", { seam: "observation-review", answers: { ending: { type: "choice", choice: "blocked", value: 0.99 } } }),
    event("tool/result", "other", { state: "denied" }),
  ];
  const evidence = attemptEvidence(events, new Set(["t1"]));
  assert.deepEqual({ ...evidence, tried: evidence.tried.length }, { failures: 2, denied: false, stillDenied: false, unavailable: false, blockedClaims: 1, finalRefusal: false, tried: 1 });
  assert.equal(attemptEvidence(events, new Set(["t1", "other"])).denied, true);
  const lines = endingFeedback(["unprovenBlocker"], evidence).join(" ");
  assert.match(lines, /shows 2 failed attempts \(ui_press \{"label":"Xóa"\} → target-covered ×2\)/u);
  assert.match(endingFeedback(["handsBack"], none).join(" "), /Do that step yourself now.*request_user_input/u);
});

test("a decision asked in prose goes back to be asked as a form, only while a form can carry it", () => {
  // A decision the user has to make comes as a form with something to click, not as text.
  const decision = ending("decision", { decision: 0.99, done: 0.01 });
  assert.deepEqual(readEnding(decision, none, true), ["askedInProse"]);
  assert.deepEqual(readEnding(decision, none, false), [], "no form offered, or the turn's last step: text is all there is");
  assert.match(endingFeedback(["askedInProse"], none).join(" "), /request_user_input.*select field.*suggest field/su);
});

test("a form is offered when the structured-question tool is listed and the step is not the forced last one", () => {
  const state = (finalStep?: { reason: string }) => ({
    turnId: "t1", taskTurnIds: ["t1"], availableTools: [{ id: "request_user_input", version: "1", sideEffect: "none" }],
    context: { events: [{ eventId: "e1", seq: 1, turnId: "t1", type: "user/input", payload: { content: "đối soát" } },
      { eventId: "e2", seq: 2, turnId: "t1", type: "tool/result", payload: { callId: "c", toolId: "read", state: "succeeded", dispatched: true, result: { ok: true } } }] },
    ...(finalStep ? { finalStep } : {}),
  }) as unknown as Parameters<typeof goalAuditInput>[0];
  assert.equal(goalAuditInput(state(), "Anh/chị chọn sheet nào?", () => false)?.formOffered, true);
  assert.equal(goalAuditInput(state({ reason: "progress-stalled" }), "Anh/chị chọn sheet nào?", () => false)?.formOffered, undefined);
});

test("the ending reading carries the judge's label and whether the journal proves the blocker it names", async () => {
  // A proven blocker must not be graded by the completion rounds ("not delivered"), or the turn loops.
  const blockedJudge = async () => ({ modelId: "f", answers: { ending: ending("blocked", { blocked: 0.99, done: 0.01 }) } });
  const input = (attempts: AttemptEvidence | undefined) => ({ request: "r", steps: [], answer: "Em chưa đọc được tệp.", evidence: [], ...(attempts ? { attempts } : {}) });
  const signal = new AbortController().signal;
  assert.deepEqual(await judgeEnding(input({ ...none, blockedClaims: 2 }), blockedJudge, signal), { flags: [], choice: "blocked", confidence: 0.99, provenBlocker: true });
  assert.deepEqual(await judgeEnding(input(none), blockedJudge, signal), { flags: ["unprovenBlocker"], choice: "blocked", confidence: 0.99, provenBlocker: false });
  assert.equal((await judgeEnding(input(undefined), blockedJudge, signal)).provenBlocker, false, "no journal facts: nothing proves it");
  const unsure = async () => ({ modelId: "f", answers: { ending: ending("blocked", { blocked: 0.6, done: 0.4 }) } });
  assert.equal((await judgeEnding(input({ ...none, denied: true }), unsure, signal)).provenBlocker, false, "only a clear reading counts");
  assert.deepEqual(await judgeEnding(input(none), undefined, signal), { flags: [], provenBlocker: false }, "no judge: no reading");
});

test("a missing capability proves the blocker: the refused call's own mark, or the turn's facts about what is missing", () => {
  const event = (type: string, turnId: string, payload: unknown) => ({ type, turnId, payload }) as unknown as SessionEvent;
  const task = new Set(["t1"]);
  const refused = event("tool/result", "t1", { toolId: "mcp_office-docs_read_document", state: "not_started", dispatched: false, unavailable: "source-unavailable",
    error: { type: "tool_error", code: "validation", retryable: false, message: "Tool mcp_office-docs_read_document is not available in this session, so it was not run." } });
  const evidence = attemptEvidence([refused], task, { turnId: "t1" });
  assert.deepEqual([evidence.unavailable, evidence.finalRefusal, blockerProven(evidence), blockerFinal(evidence)], [true, true, true, true], "one refusal of a missing capability is final");
  assert.equal(attemptEvidence([refused], new Set(["other"]), { turnId: "t1" }).unavailable, false, "another task's refusal proves nothing here");
  // The same refusal before the runtime marks it: the state says the source is down, and the task tried one of its tools.
  const { unavailable: _mark, ...unmarked } = (refused.payload as Record<string, unknown>);
  const tried = event("tool/result", "t1", unmarked);
  const down = { sources: [{ sourceId: "mcp_office-docs", readsAttachments: true }], withheldTools: [] };
  assert.equal(attemptEvidence([tried], task).unavailable, false);
  assert.equal(attemptEvidence([tried], task, { unavailable: down }).unavailable, true);
  const withheld = { sources: [], withheldTools: [{ toolId: "mcp_office-docs_read_document", missingPermissions: ["mcp.office-docs.invoke"] }] };
  assert.equal(attemptEvidence([tried], task, { unavailable: withheld }).unavailable, true, "a tool withheld by permission");
  // Files attached while every reader is down: the answer cannot read them, whether or not it tried.
  const attached = event("user/input", "t1", { content: "đối soát tệp này", attachments: [{ id: "doc_1", name: "luong.xlsx", mediaType: "x", byteSize: 10 }] });
  assert.equal(attemptEvidence([attached], task, { unavailable: down }).unavailable, true);
  assert.equal(attemptEvidence([attached], task, { unavailable: { sources: [{ sourceId: "mcp_ava", readsAttachments: false }], withheldTools: [] } }).unavailable, false,
    "a source that reads no attachments says nothing about them");
  assert.equal(attemptEvidence([event("user/input", "t1", { content: "x" })], task, { unavailable: down }).unavailable, false, "nothing attached, nothing tried");
});

test("a missing capability proves nothing once it is back, or once the file was read: only this turn's facts count", () => {
  // A refusal marked in an earlier turn of the task, or a read made before the reader went down, must not prove a blocked
  // answer in a turn where nothing is blocking it.
  const event = (type: string, turnId: string, payload: unknown) => ({ type, turnId, payload }) as unknown as SessionEvent;
  const attached = event("user/input", "t1", { content: "Đọc tệp đính kèm", attachments: [{ id: "a1", name: "f.xlsx", mediaType: "x", byteSize: 1 }] });
  const refused = event("tool/result", "t1", { toolId: "mcp_office-docs_read_table", state: "not_started", dispatched: false, unavailable: "source-unavailable",
    error: { code: "validation", retryable: false, message: "x" } });
  const down = { sources: [{ sourceId: "mcp_office-docs", readsAttachments: true }], withheldTools: [] };
  const resumed = attemptEvidence([attached, refused], new Set(["t1", "t2"]), { turnId: "t2" });
  assert.deepEqual([resumed.unavailable, resumed.finalRefusal, blockerProven(resumed)], [false, false, false], "resumed with the reader back");
  assert.equal(attemptEvidence([attached, refused], new Set(["t1", "t2"]), { turnId: "t2", unavailable: down }).unavailable, true, "still down this turn");
  const read = event("tool/result", "t1", { toolId: "mcp_office-docs_read_table", state: "succeeded", dispatched: true, result: { rows: 84 } });
  const readBefore = attemptEvidence([attached, read], new Set(["t1", "t2"]), { turnId: "t2", unavailable: down });
  assert.deepEqual([readBefore.unavailable, blockerProven(readBefore)], [false, false], "the file was read before the reader went down");
  const offered = attemptEvidence([attached], new Set(["t1"]), { turnId: "t1", unavailable: down,
    availableTools: [{ id: "mcp_office-docs_read_table", version: "1", sideEffect: "none" }] });
  assert.equal(offered.unavailable, false, "a reader of that source is offered this turn");
});

test("failed calls counted over every target stop the unproven-blocker objection, and never settle the blocker", async () => {
  // Three mislabelled clicks elsewhere, then "the Save button is locked" after one try: not a proven blocker.
  const many: AttemptEvidence = { ...none, failures: 3 };
  assert.deepEqual([blockerProven(many), blockerFinal(many)], [true, false]);
  const blocked = async () => ({ modelId: "f", answers: { ending: ending("blocked", { blocked: 0.99, done: 0.01 }) } });
  const reading = await judgeEnding({ request: "r", steps: [], answer: "a", evidence: [], attempts: many }, blocked, new AbortController().signal);
  assert.deepEqual([reading.flags, reading.provenBlocker], [[], false], "not sent back as unproven, and judged on delivery as any answer");
  assert.equal(blockerFinal({ ...none, denied: true, stillDenied: true }), true);
  assert.deepEqual([blockerProven({ ...none, denied: true }), blockerFinal({ ...none, denied: true })], [true, false], "a denial the work went past");
  assert.equal(blockerFinal({ ...none, blockedClaims: 2 }), true);
});

test("after a final refusal the feedback no longer says to call again; after a refusal of the arguments it still does", () => {
  const event = (payload: unknown) => ({ type: "tool/result", turnId: "t1", payload }) as unknown as SessionEvent;
  const failed = (error: Record<string, unknown>) => event({ toolId: "payroll_x", state: "failed", dispatched: true, error, attempt: { signature: "payroll_x {}", failure: String(error.code), failures: 1 } });
  // A tool's own refusal names what to fix (e.g. an MCP error "sheet 'Bang luong ' not found; nearest: 'Bang luong'").
  const mcpRefusal = attemptEvidence([failed({ code: "permanent", retryable: false, message: "MCP tool read_table returned an error: sheet not found" })], new Set(["t1"]));
  assert.equal(mcpRefusal.finalRefusal, false);
  assert.match(endingFeedback(["unprovenBlocker"], mcpRefusal).join(" "), /first do what the refusal says to fix and call again/u);
  assert.equal(attemptEvidence([failed({ code: "timeout", retryable: false, message: "Tool timed out" })], new Set(["t1"])).finalRefusal, false, "a timeout may pass on a smaller call");
  for (const final of [failed({ code: "cycle-detected", retryable: false, message: "x" }), failed({ code: "budget-exceeded", retryable: false, message: "x" }),
    event({ toolId: "payroll_x", state: "denied", dispatched: false, error: { code: "denied", retryable: false, message: "x" } })]) {
    const stopped = attemptEvidence([final], new Set(["t1"]));
    assert.equal(stopped.finalRefusal, true, JSON.stringify((final as unknown as { payload: unknown }).payload));
    assert.doesNotMatch(endingFeedback(["unprovenBlocker"], stopped).join(" "), /call again/u);
    assert.match(endingFeedback(["unprovenBlocker"], stopped).join(" "), /latest refusal is final/u);
  }
  const argumentsRefused = attemptEvidence([failed({ code: "validation", retryable: false, message: "Month must be 1-12" })], new Set(["t1"]));
  assert.equal(argumentsRefused.finalRefusal, false);
  assert.match(endingFeedback(["unprovenBlocker"], argumentsRefused).join(" "), /first do what the refusal says to fix and call again/u);
  const transient = attemptEvidence([failed({ code: "transient", retryable: true, message: "timeout" })], new Set(["t1"]));
  assert.equal(transient.finalRefusal, false, "a retryable failure may pass next time");
  const recovered = attemptEvidence([failed({ code: "permanent", retryable: false, message: "x" }), failed({ code: "validation", retryable: false, message: "y" })], new Set(["t1"]));
  assert.equal(recovered.finalRefusal, false, "the newest failure decides");
  // A later call of the same step the runtime held back behind a failure ran nothing: it neither fails nor hides the refusal.
  const stoppedBehind = event({ toolId: "payroll_y", state: "not_started", dispatched: false,
    error: { type: "tool_error", code: "not-started", retryable: true, message: "Not run: payroll_x (call 1 of this step, in your order) did not succeed before it." } });
  for (const final of [failed({ code: "cycle-detected", retryable: false, message: "x" }), event({ toolId: "payroll_x", state: "denied", dispatched: false })]) {
    const masked = attemptEvidence([final, stoppedBehind], new Set(["t1"]));
    assert.equal(masked.finalRefusal, true, "a call stopped behind a final refusal leaves it the latest failure");
    assert.match(endingFeedback(["unprovenBlocker"], masked).join(" "), /latest refusal is final/u);
  }
  assert.equal(attemptEvidence([failed({ code: "validation", retryable: false, message: "y" }), stoppedBehind], new Set(["t1"])).finalRefusal, false,
    "behind a refusal of the arguments it still says to call again");
});

test("the runtime's own fact that the task's files cannot be read settles it, a withheld reader included", () => {
  // A reader withheld by permission leaves no source down, and a model that obeys the manifest's "do not call" leaves no
  // refused call: the blocker is still real and must not go back as unproven.
  const event = (type: string, turnId: string, payload: unknown) => ({ type, turnId, payload }) as unknown as SessionEvent;
  const attached = event("user/input", "t1", { content: "Đối chiếu với tệp này", attachments: [{ id: "a1", name: "f.xlsx", mediaType: "x", byteSize: 1 }] });
  const withheld = { sources: [], withheldTools: [{ toolId: "mcp_office-docs_read_table", missingPermissions: ["docs.read"] }] };
  const task = new Set(["t1"]);
  assert.equal(attemptEvidence([attached], task, { turnId: "t1", unavailable: withheld }).unavailable, false, "the generic layer cannot tell a reader from another tool");
  for (const attachments of ["withheld", "source-unavailable"] as const) {
    const said = attemptEvidence([attached], task, { turnId: "t1", unavailable: { ...withheld, attachments } });
    assert.deepEqual([said.unavailable, blockerFinal(said)], [true, true], attachments);
  }
  assert.equal(attemptEvidence([event("user/input", "t1", { content: "x" })], task, { turnId: "t1", unavailable: { ...withheld, attachments: "withheld" } }).unavailable, false,
    "no file in the conversation");
  // A later task about something else is not blocked by the earlier, unread file.
  const later = [attached, event("user/input", "t2", { content: "September totals" })];
  const unrelated = attemptEvidence(later, new Set(["t2"]), { turnId: "t2", unavailable: { ...withheld, attachments: "withheld" } });
  assert.deepEqual([unrelated.unavailable, blockerFinal(unrelated), readEnding(ending("blocked", { blocked: 0.99 }), unrelated)], [false, false, ["unprovenBlocker"]], "unrelated: sent back as before");
  // P: the follow-up names the earlier file in one of its calls — it is about that file.
  const named = [...later, event("tool/intent", "t2", { callId: "r1", toolId: "mcp_office-docs_read_table", arguments: JSON.stringify({ documentId: "a1" }) })];
  const reached = attemptEvidence(named, new Set(["t2"]), { turnId: "t2", unavailable: { ...withheld, attachments: "withheld" } });
  assert.deepEqual([reached.unavailable, blockerFinal(reached)], [true, true], "reached for: proven");
});

test("a denial settles a blocked answer until a write goes through after it, or the denied tool runs", () => {
  // A user who declined one write and then let other writes go through has not blocked what comes later; reading the
  // value back to report it unchanged does not go past the refusal.
  const event = (type: string, payload: unknown) => ({ type, turnId: "t2", payload }) as unknown as SessionEvent;
  const task = new Set(["t1", "t2"]);
  const denied = event("tool/result", { callId: "w1", toolId: "payroll_update_employee", state: "denied", dispatched: false, error: { code: "denied", retryable: false, message: "x" } });
  const intent = (callId: string, toolId: string, sideEffect: string) => event("tool/intent", { callId, executionId: `x-${callId}`, toolId, arguments: "{}", state: "prepared", sideEffect });
  const result = (callId: string, toolId: string) => event("tool/result", { callId, executionId: `x-${callId}`, toolId, state: "succeeded", dispatched: true, result: {} });
  const readBack = [intent("r1", "payroll_get_employee", "none"), result("r1", "payroll_get_employee")];
  const plan = [intent("p1", "plan_update", "none"), result("p1", "plan_update")];
  const standing = attemptEvidence([...readBack, denied, ...readBack, ...plan], task, { turnId: "t2" });
  assert.deepEqual([standing.stillDenied, blockerFinal(standing)], [true, true], "declined, then a read-back and a plan update: the refusal stands");
  const write = [intent("w2", "payroll_add_employee_allowance", "idempotent"), result("w2", "payroll_add_employee_allowance")];
  const passed = attemptEvidence([denied, ...write], task, { turnId: "t2" });
  assert.deepEqual([passed.denied, passed.stillDenied, blockerProven(passed), blockerFinal(passed)], [true, false, true, false],
    "another write went through: still no unproven-blocker objection, but judged on delivery");
  const rerun = attemptEvidence([denied, intent("w1b", "payroll_update_employee", "idempotent"), result("w1b", "payroll_update_employee")], task, { turnId: "t2" });
  assert.equal(rerun.stillDenied, false, "the denied write itself went through later");
  // A refused read (control of the screen, say) stands until that same tool runs; another read does not lift it.
  const deniedRead = event("tool/result", { callId: "s1", toolId: "ui_get_current_view", state: "denied", dispatched: false, error: { code: "denied", retryable: false, message: "x" } });
  assert.equal(attemptEvidence([deniedRead, ...readBack], task, { turnId: "t2" }).stillDenied, true);
  assert.equal(attemptEvidence([deniedRead, intent("s2", "ui_get_current_view", "none"), result("s2", "ui_get_current_view")], task, { turnId: "t2" }).stillDenied, false);
  // No intent journaled for the call: what the tool does is read off the tools offered this turn.
  const bare = event("tool/result", { callId: "w3", toolId: "payroll_add_employee_allowance", state: "succeeded", dispatched: true, result: {} });
  const offered = [{ id: "payroll_add_employee_allowance", version: "1", sideEffect: "idempotent" as const }];
  assert.equal(attemptEvidence([denied, bare], task, { turnId: "t2", availableTools: offered }).stillDenied, false);
  assert.equal(attemptEvidence([denied, bare], task, { turnId: "t2" }).stillDenied, true, "a call of unknown effect does not go past it");
});

test("a blocked answer the journal does not prove is tied to an earlier request's unread file only by the judge's sure reading", async () => {
  // "Read it again" answered at once with "I still cannot read the file" names nothing the journal can tie
  // to the task, and must stand; an unrelated blocker in the same place must still go back.
  const { earlierUnreadFiles, UNREADABLE_FILE_QUESTION } = await import("../src/index.js");
  const files = [{ id: "a1", name: "f.xlsx" }];
  const signal = new AbortController().signal;
  const asked: string[][] = [];
  const judgeWith = (file: number | "fail", end = ending("blocked", { blocked: 0.99, done: 0.01 })) => async (request: { readonly questions: Readonly<Record<string, unknown>>; readonly state: unknown }) => {
    asked.push(Object.keys(request.questions));
    if (!("unreadableFile" in request.questions)) return { modelId: "f", answers: { ending: end } };
    if (file === "fail") throw new Error("timeout");
    assert.deepEqual(request.state, { files: ["f.xlsx"], answer: "Em vẫn chưa đọc được tệp." }, "the answer and the files' names, nothing else");
    return { modelId: "f", answers: { unreadableFile: { type: "noul" as const, noul: file } } };
  };
  const input = (attempts: AttemptEvidence = none) => ({ request: "read it again", steps: [], answer: "Em vẫn chưa đọc được tệp.", evidence: [], attempts, unreadEarlierFiles: files });
  assert.deepEqual(await judgeEnding(input(), judgeWith(1), signal),
    { flags: [], choice: "blocked", confidence: 0.99, provenBlocker: true, unreadFiles: files }, "sure: proven, and by which files");
  assert.deepEqual((await judgeEnding(input(), judgeWith(0.9), signal)).flags, ["unprovenBlocker"], "a doubt proves nothing");
  assert.deepEqual((await judgeEnding(input(), judgeWith("fail"), signal)).flags, ["unprovenBlocker"], "a failed judgment: as before the question");
  asked.length = 0;
  assert.equal((await judgeEnding(input({ ...none, denied: true, stillDenied: true }), judgeWith(1), signal)).unreadFiles, undefined, "proven by the journal: not asked");
  assert.equal((await judgeEnding(input(), judgeWith(1, ending("done", { done: 0.99 })), signal)).provenBlocker, false, "not blocked: not asked");
  assert.deepEqual(asked, [["ending"], ["ending"]], "the question costs nothing outside its branch");
  assert.equal(UNREADABLE_FILE_QUESTION.type, "noul");
  // Which files: unread in the conversation and not the task's — the task's own are a fact already.
  const event = (type: string, turnId: string, payload: unknown) => ({ type, turnId, payload }) as unknown as SessionEvent;
  const events = [event("user/input", "t1", { content: "x", attachments: [{ id: "a1", name: "f.xlsx" }] }), event("user/input", "t2", { content: "y", attachments: [{ id: "a2", name: "g.xlsx" }] })];
  const unreadFiles = [{ id: "a1", name: "f.xlsx" }, { id: "a2", name: "g.xlsx" }];
  const base = { turnId: "t2", taskTurnIds: ["t2"], context: { events }, unavailable: { sources: [], withheldTools: [], unreadFiles } } as unknown as Parameters<typeof earlierUnreadFiles>[0];
  assert.deepEqual(earlierUnreadFiles(base), [{ id: "a1", name: "f.xlsx" }]);
  assert.deepEqual(earlierUnreadFiles({ ...base, unavailable: undefined }), []);
});

test("after a search that found nothing, a reading of continue or delegate is no hand-back; a blocker is read as before", () => {
  assert.deepEqual(readEnding(ending("continue", { continue: 0.9928, done: 0.0072 }), none, false, true), []);
  assert.deepEqual(readEnding(ending("delegate", { delegate: 0.99 }), none, false, true), []);
  assert.deepEqual(readEnding(ending("absent", { absent: 0.9999 }), none, false, true), []);
  assert.deepEqual(readEnding(ending("blocked", { blocked: 0.99 }), none, false, true), ["unprovenBlocker"], "a blocker is the journal's to prove, as before");
  assert.deepEqual(readEnding(ending("continue", { continue: 0.9928, done: 0.0072 }), none), ["handsBack"], "without the fact: a hand-back");
});
