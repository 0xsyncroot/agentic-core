#!/usr/bin/env node
/**
 * Builds the redacted step-fact fixture the core turn-end replay runs on (packages/core/test/replay).
 *
 * Input: the session journal in MySQL (read-only), the LLM tap captures and the independent step labels. Output: per run (one
 * turn id: a turn, or a resumed turn) the facts the turn-end logic reads at each step, the recorded end, and an oracle label.
 * Only enums, numbers, booleans and per-run ordinals leave this script: no text, ids, amounts or dates. A call's side effect
 * leaves it only as the boolean `wrote`, never as the recorded string. A tool leaves it as an index into the tool-id dictionary
 * that is kept outside the repository (code identifiers of the offered tools, never anything a model or user typed); a plan step leaves it
 * as an ordinal and a status, never its description, goal or outcome.
 *
 * Oracle per run, from the labeller's turn verdicts (labels2): `correct` when the request was satisfied inside the captured
 * turn (satisfaction index >= 0), `stuck` when it never was and the labeller marked at least one step repeating, otherwise
 * `unlabelled`. A captured turn joins journal runs on the model's tool call ids; a labelled turn that joins no run is listed
 * under `notMeasurable`, never dropped.
 *
 *   node --env-file=.env scripts/replay/extract-step-facts.mjs --from <ISO> --to <ISO> --labels <dir> --captures <dir> --out <file>
 *
 * The optional `--tool-ids <file>` receives the ordinal-to-id dictionary for analysis; it is never committed.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Ordinals, token } from "./enums.mjs";
import { capturedCallIds, labelledTurns } from "./labels.mjs";
import { planChanges, planFacts, plansByTurn } from "./plans.mjs";
import { decodeSessionPayload } from "../../packages/persistence-mysql/dist/session-payload.js";

const root = resolve(import.meta.dirname, "../..");
const mysql = createRequire(resolve(root, "package.json"))("mysql2/promise");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs), []));
for (const name of ["from", "to", "labels", "captures", "out"]) if (!args[name]) throw new Error(`--${name} is required`);

/** The composition the replay assumes for every run: the product's step and tool-call budgets and its silence window. */
const OPTIONS = { maxSteps: "progressive", initialStepBudget: 4, stepBudgetExtension: 4, maxToolCalls: 64, turnTimeoutMs: 300_000 };
const PROFILE = "sample-app-payroll";
/** The work plan's tools: a whole-plan update and a step mark. Neither is work, and neither is attributed to a step. */
const PLAN_TOOLS = new Set(["plan_update", "plan_mark"]);
/** The commit the replay's legacy model copies; a run's `codeAge` counts the turn-end commits up to it made after the run started. */
const REPLICA_COMMIT = "583c295";
/** Sources whose change can change a turn-end decision: a run started before a commit to one of them ran older rules. */
const TURN_END_SOURCES = ["step-budget", "turn-step-loop", "tool-batch-executor", "step-disposition", "step-answer", "work-remains-gate",
  "turn-output-review", "tool-execution-coordinator", "turn-control-fallback", "step-failure-recovery", "tool-attempts"]
  .map((name) => `packages/core/src/agent/${name}.ts`);
const TYPES = ["turn/start", "turn/end", "turn/failed", "step/start", "step/end", "request/prepared", "tool/intent", "tool/result",
  "assistant/message", "turn/control-decision", "work/plan-updated"];
/** Reasons the core itself writes; any other accept reason is the policy's own and is kept only as `policy`. */
const CORE_ACCEPT_REASONS = new Set(["work-remains-final-step", "work-remains-unmoved", "closing-step-objection"]);
/** A registered tool id is a code identifier; anything else in a tool call's name is model text and never enters the dictionary. */
const TOOL_ID = /^[a-z][a-z0-9_-]{0,79}$/u;

async function journal() {
  const connection = await mysql.createConnection({ uri: process.env.DATABASE_URL, connectTimeout: 30_000 });
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.query("START TRANSACTION READ ONLY");
    const [rows] = await connection.query(
      `SELECT session_id, seq, turn_id, step_id, call_id, type, occurred_at, payload FROM agentic_session_event
       WHERE occurred_at >= ? AND occurred_at < ? AND type IN (?)`, [new Date(args.from), new Date(args.to), TYPES]);
    await connection.query("COMMIT");
    // Ordered here, not by the server: a sort over the payload column overflows its sort buffer.
    rows.sort((a, b) => a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : Number(a.seq) - Number(b.seq));
    return rows.map((row) => ({ ...row, at: new Date(row.occurred_at).getTime(), protected: Boolean(row.payload?._protected),
      p: row.payload?._protected ? {} : decodeSessionPayload(row.payload) ?? {} }));
  } finally {
    await connection.end();
  }
}

function commitTimes() {
  const out = execFileSync("git", ["log", REPLICA_COMMIT, "--format=%ct", "--", ...TURN_END_SOURCES], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((line) => Number(line) * 1000);
}

/** Tools offered on the steps that may only ask the user: what a final step's request held. */
function askTools(rows) {
  const directed = new Set(rows.filter((row) => row.type === "turn/control-decision" && row.p.phase === "before-model").map((row) => row.step_id));
  const ask = new Set();
  for (const row of rows) {
    if (row.type === "request/prepared" && ["auto", "none"].includes(row.p.toolChoice) && !directed.has(row.step_id)) {
      for (const id of row.p.toolIds ?? []) ask.add(id);
    }
  }
  return { ask, directed };
}

/** The side effect each call's intent declared, by call id: a resumed call's intent sits in the turn that paused. */
function sideEffects(sessionRows) {
  return new Map(sessionRows.filter((row) => row.type === "tool/intent" && row.call_id).map((row) => [row.call_id, row.p.sideEffect]));
}

function call(row, offered, context) {
  const { ask, effects, tools, planIds } = context;
  const attempt = row.p.attempt ?? {};
  const code = row.p.error?.code;
  const effect = effects.get(row.call_id);
  const workStep = PLAN_TOOLS.has(row.p.toolId) ? 0 : planIds.of(row.p.workStepId);
  return {
    plan: PLAN_TOOLS.has(row.p.toolId), asks: ask.has(row.p.toolId), offered, tool: tools.get(row.p.toolId) ?? 0, workStep,
    skipped: row.p.state === "not_started" && ["not-started", "approval-required", "interaction-required"].includes(code),
    state: token(row.p.state), dispatched: row.p.dispatched === true, halted: row.p.halt === "state-changed", gain: token(row.p.informationGain ?? "none"),
    failure: attempt.failure !== undefined, failures: Number(attempt.failures ?? 0),
    // A dispatched call that succeeded and declared a side effect: a write that happened.
    wrote: row.p.dispatched === true && row.p.state === "succeeded" && typeof effect === "string" && effect !== "none",
    // A dispatched call of the work plan's tool-free kind that succeeded under a plan step: the evidence the plan ledger credits.
    credited: !PLAN_TOOLS.has(row.p.toolId) && row.p.dispatched === true && row.p.state === "succeeded" && workStep > 0,
  };
}

function runFacts(rows, context) {
  const { directed, ages, tools, plans } = context;
  const planIds = new Ordinals();
  const callContext = { ...context, planIds };
  const planAtStart = plans.start ? planFacts(plans.start, planIds) : undefined;
  const planned = plans.updates.map((update) => ({ ...update, facts: planFacts(update.payload, planIds) }));
  const start = rows.find((row) => row.type === "turn/start");
  const origin = (start ?? rows[0]).at;
  const ms = (row) => Math.max(0, Math.round(row.at - origin));
  const answers = new Ordinals();
  const feedback = new Ordinals();
  const steps = [];
  const byStep = new Map();
  let end = { kind: "open" };
  let current;
  for (const row of rows) {
    if (row.type === "step/start") {
      current = { i: row.p.index, t: [ms(row)], mode: "none", reads: [], calls: [], answer: "none", suppressed: false, reviews: [], end: null,
        interjected: false, offered: null };
      steps.push(current);
      byStep.set(row.step_id, current);
      continue;
    }
    const step = byStep.get(row.step_id) ?? current;
    if (row.type === "turn/end") end = { kind: "end", status: token(row.p.status), reason: token(row.p.reason), decision: token(row.p.decision) };
    else if (row.type === "turn/failed") end = { kind: "failed", code: token(row.p.code) };
    if (!step) continue;
    if (row.type === "request/prepared" && step.offered === null) {
      step.offered = new Set(row.p.toolIds ?? []);
      const final = ["auto", "none"].includes(row.p.toolChoice) && !directed.has(row.step_id);
      step.mode = final ? "final" : "tools";
    } else if (row.type === "tool/result") {
      const policy = row.p.initiator === "policy";
      (policy ? step.reads : step.calls).push(call(row, policy || step.offered === null || step.offered.has(row.p.toolId), callContext));
    } else if (row.type === "assistant/message") {
      const content = typeof row.p.content === "string" && row.p.content.trim() !== "";
      if (row.p.finishReason !== "turn-control-fallback" && row.p.finishReason !== "step-failure") step.answer = content ? "text" : "silent";
      if (Array.isArray(row.p.suppressedToolCalls) && row.p.suppressedToolCalls.length > 0) step.suppressed = true;
    } else if (row.type === "turn/control-decision") {
      const p = row.p;
      const accept = p.decision === "accept";
      step.reviews.push({
        phase: token(p.phase), decision: token(p.decision), workRemains: p.workRemains === true, delivered: p.delivered === true,
        feedback: p.decision === "continue" || p.decision === "fallback" ? feedback.of(p.reason) : 0,
        answer: p.phase === "terminal" ? answers.of(p.candidateHash) : 0, text: p.decision === "continue" ? p.contentHash !== undefined : null,
        reason: accept ? (CORE_ACCEPT_REASONS.has(p.reason) ? p.reason : p.reason ? "policy" : null) : p.decision === "close" ? token(p.reason) : null,
        after: step.calls.length > 0, t: ms(row),
      });
    } else if (row.type === "step/end") {
      step.end = { status: token(row.p.status), reason: token(row.p.reason), code: token(row.p.code) };
      step.interjected = row.p.reason === "interjection";
      step.t[1] = ms(row);
    }
  }
  let offeredBefore = "";
  let planBefore = JSON.stringify(planAtStart ?? null);
  for (const step of steps) {
    if (step.offered !== null) {
      const ordinals = [...step.offered].map((id) => tools.get(id)).filter((ordinal) => ordinal !== undefined).sort((a, b) => a - b);
      // Only a change of the offered set is recorded; a step without the key offered what the step before it did.
      if (JSON.stringify(ordinals) !== offeredBefore) step.toolsOffered = ordinals;
      offeredBefore = JSON.stringify(ordinals);
    }
    delete step.offered;
    for (const review of step.reviews) if (review.text === null) delete review.text;
  }
  const last = steps[steps.length - 1];
  for (const update of planned) {
    const step = byStep.get(update.stepId) ?? last;
    if (step) step.planAfter = update.facts;
  }
  for (const step of steps) {
    if (step.planAfter === undefined) continue;
    const after = JSON.stringify(step.planAfter);
    if (after !== planBefore) step.plan = step.planAfter;
    planBefore = after;
    delete step.planAfter;
  }
  const pause = start?.p.continuation?.pauseKind;
  const resume = !pause ? "none" : steps[0]?.end?.reason === "runtime-question-continue" ? "question" : pause === "approval" ? "approval" : "interaction";
  return { start: steps[0]?.i ?? 1, resume, codeAge: ages.filter((time) => time > origin).length, end, ...(planAtStart ? { planAtStart } : {}), steps };
}

/** Values a reader assumes when a key is absent; leaving them out keeps the committed fixture small. */
const DEFAULTS = {
  call: { plan: false, asks: false, offered: true, skipped: false, dispatched: false, gain: "none", failure: false, failures: 0, wrote: false,
    tool: 0, workStep: 0, credited: false, halted: false },
  review: { workRemains: false, delivered: false, feedback: 0, answer: 0, reason: null, after: false },
  step: { answer: "none", suppressed: false, planChanged: false, interjected: false },
  stepEnd: { reason: null, code: null },
};
const withoutDefaults = (object, defaults) => Object.fromEntries(Object.entries(object).filter(([key, value]) =>
  !(key in defaults && defaults[key] === value) && !(Array.isArray(value) && value.length === 0)));
const compactStep = (step) => withoutDefaults({
  ...step, reads: step.reads.map((call) => withoutDefaults(call, DEFAULTS.call)), calls: step.calls.map((call) => withoutDefaults(call, DEFAULTS.call)),
  reviews: step.reviews.map((review) => withoutDefaults(review, DEFAULTS.review)), end: step.end && withoutDefaults(step.end, DEFAULTS.stepEnd),
}, DEFAULTS.step);

/** The turns of the replayed profile, per session, and the ids of the tools their requests offered (code identifiers, sorted). */
function includedTurns(sessions) {
  const excluded = { profile: 0, protected: 0, noStep: 0 };
  const included = [];
  const offered = new Set();
  for (const sessionRows of sessions.values()) {
    const turns = Map.groupBy(sessionRows.filter((row) => row.turn_id), (row) => row.turn_id);
    const pending = [];
    for (const turnRows of turns.values()) {
      const start = turnRows.find((row) => row.type === "turn/start");
      if (start?.p.runtimeBinding?.agentProfileId !== PROFILE) { excluded.profile += 1; continue; }
      if (turnRows.some((row) => row.protected)) { excluded.protected += 1; continue; }
      pending.push(turnRows);
      for (const row of turnRows) if (row.type === "request/prepared") for (const id of row.p.toolIds ?? []) offered.add(id);
    }
    included.push({ sessionRows, pending });
  }
  const bad = [...offered].filter((id) => !TOOL_ID.test(id));
  if (bad.length > 0) throw new Error(`offered tool ids that are not code identifiers: ${bad.length}`);
  return { included, excluded, toolIds: [...offered].sort() };
}

/** How many runs carry plan facts, and for those that do not, whether the model made work calls without a plan. */
function coverage(runs, toolIds) {
  const calls = (run) => run.steps.flatMap((step) => [...(step.reads ?? []), ...(step.calls ?? [])]);
  const planned = (run) => run.planAtStart !== undefined || run.steps.some((step) => step.plan !== undefined);
  const attributed = (run) => calls(run).some((item) => item.workStep !== undefined);
  const work = (run) => calls(run).some((item) => !item.plan);
  const count = (test) => runs.filter(test).length;
  return `plan facts: ${count(planned)} of ${runs.length} runs (plan carried in from an earlier turn ${count((run) => run.planAtStart !== undefined)});`
    + ` without a plan: ${count((run) => !planned(run) && work(run))} made work calls, ${count((run) => !planned(run) && !work(run))} made none;`
    + ` attributed calls: ${count(attributed)} runs, ${count((run) => planned(run) && !attributed(run) && work(run))} planned runs with work calls but none attributed;`
    + ` credited calls ${runs.reduce((sum, run) => sum + calls(run).filter((item) => item.credited).length, 0)};`
    + ` tool dictionary ${toolIds.length}`;
}

async function main() {
  const rows = await journal();
  const ages = commitTimes();
  const { ask, directed } = askTools(rows);
  const sessions = Map.groupBy(rows, (row) => row.session_id);
  const runs = [];
  const callsByRun = new Map();
  const { included, excluded, toolIds } = includedTurns(sessions);
  const tools = new Map(toolIds.map((id, index) => [id, index + 1]));
  for (const { sessionRows, pending } of included) {
    const stepsById = new Map();
    const effects = sideEffects(sessionRows);
    const plans = plansByTurn(sessionRows);
    const shells = pending.map((turnRows) => ({ turnRows,
      facts: runFacts(turnRows, { ask, directed, ages, effects, tools, plans: plans.get(turnRows[0].turn_id) }) }));
    for (const { turnRows, facts } of shells) {
      const starts = turnRows.filter((row) => row.type === "step/start");
      starts.forEach((row, index) => stepsById.set(row.step_id, facts.steps[index]));
    }
    const changed = planChanges(sessionRows, stepsById);
    for (const { turnRows, facts } of shells) {
      if (facts.steps.length === 0) { excluded.noStep += 1; continue; }
      for (const step of facts.steps) step.planChanged = changed.get(step) ?? false;
      runs.push(facts);
      callsByRun.set(facts, new Set(turnRows.filter((row) => row.type === "tool/result" && row.p.initiator !== "policy").map((row) => row.call_id)));
    }
  }
  const labels = labelledTurns(args.labels);
  const notMeasurable = [];
  let group = 0;
  for (const [turn, oracle] of labels) {
    if (oracle === "unlabelled") continue;
    group += 1;
    const ids = capturedCallIds(args.captures, turn);
    if (!ids) { notMeasurable.push({ group, oracle, reason: turn.startsWith("cap:") ? "no-capture" : "not-captured" }); continue; }
    const joined = runs.filter((run) => [...callsByRun.get(run)].some((id) => ids.has(id)));
    if (joined.length === 0) { notMeasurable.push({ group, oracle, reason: "no-journal-run" }); continue; }
    for (const run of joined) Object.assign(run, { oracle, group });
  }
  const ordered = runs.map((run, index) => ({ run: index + 1, group: run.group ?? 0, oracle: run.oracle ?? "unlabelled", ...run, steps: run.steps.map(compactStep) }));
  const header = { format: 1, window: { fromMs: new Date(args.from).getTime(), toMs: new Date(args.to).getTime() }, options: OPTIONS, notMeasurable };
  // One run per line, so a regenerated fixture diffs run by run.
  writeFileSync(args.out, `${JSON.stringify(header).slice(0, -1)},"runs":[\n${ordered.map((run) => JSON.stringify(run)).join(",\n")}\n]}\n`);
  if (args["tool-ids"]) writeFileSync(args["tool-ids"], `${JSON.stringify(toolIds, null, 1)}\n`);
  const count = (oracle) => ordered.filter((run) => run.oracle === oracle).length;
  console.log(`runs ${ordered.length} (correct ${count("correct")}, stuck ${count("stuck")}); excluded ${JSON.stringify(excluded)};`
    + ` labelled turns ${group}, not measurable ${notMeasurable.length}; ask tools ${ask.size}`);
  console.log(coverage(ordered, toolIds));
}

await main();
