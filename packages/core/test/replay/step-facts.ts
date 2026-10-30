import { readFileSync } from "node:fs";

/**
 * The recorded facts the turn-end replay feeds a model, one run (a turn, or a resumed turn) at a time.
 *
 * Built by scripts/replay/extract-step-facts.mjs from the session journal. Only enums, numbers, booleans and per-run
 * ordinals are kept: the fixture is committed, so it may hold no text, ids, amounts or dates (`redactionViolations`
 * enforces that on every test run). A tool is its index in the sorted ids of the tools the recorded requests offered (the names are not committed); a plan step
 * is a per-run ordinal and a status, never its description, goal or outcome.
 */
export interface CallFacts {
  /** The work-plan tool: restating intent, never an observation. */
  readonly plan?: boolean;
  /** A tool that asks the user: offered on every final step and never counted against the tool-call ceiling. */
  readonly asks?: boolean;
  /** The step offered the tool; a call to one it lacked is refused without running. */
  readonly offered?: boolean;
  /** Not started behind an earlier failure or pause: invisible to the step's classification and to the ceiling. */
  readonly skipped?: boolean;
  readonly state: string;
  readonly dispatched?: boolean;
  /** `new`, `repeated`, or `none` when the result carried no verdict. */
  readonly gain?: string;
  /** The call's target failed, and how many times in a row it has. */
  readonly failure?: boolean;
  readonly failures?: number;
  /** Dispatched, succeeded, and its tool declared a side effect: a write that happened. The side effect itself is never stored. */
  readonly wrote?: boolean;
  /** 1-based index into the sorted offered tool ids; absent when the name is not a tool the run was offered. */
  readonly tool?: number;
  /** Ordinal of the plan step the call was attributed to; absent when none (and always absent on a plan call). */
  readonly workStep?: number;
  /** Dispatched, succeeded and attributed to a plan step: the evidence the plan ledger credits to that step. */
  readonly credited?: boolean;
  /** The call succeeded and changed the scope its step's later calls were chosen against (`tool/result.halt`). */
  readonly halted?: boolean;
}

export interface ReviewFacts {
  readonly phase: string;
  /** What the journal recorded: the policy's verdict after the runtime's gates (`accept`, `continue`, `close`, `fallback`, ...). */
  readonly decision: string;
  readonly workRemains?: boolean;
  /** The policy marked the answer delivered (`turn/control-decision.delivered`): the work-remains gate decides on it. */
  readonly delivered?: boolean;
  /** Ordinal of the objection text within the run; equal ordinals are the same objection. */
  readonly feedback?: number;
  /** Ordinal of the reviewed answer within the run; equal ordinals are the same answer. 0: no answer identity. */
  readonly answer?: number;
  /** The reviewed answer had text (recorded on objections only). */
  readonly text?: boolean;
  /** An accept or close reason the core writes, or `policy` for a reason of the policy's own. */
  readonly reason?: string | null;
  /** Reviewed after the step's tool batch ran (an answer sent beside a plan update). */
  readonly after?: boolean;
  /** Milliseconds from the run's start to the review. */
  readonly t?: number;
}

/** A plan step as the ledger sees it: an ordinal that is stable within the run, and its status. */
export interface PlanStepFacts {
  readonly id: number;
  readonly status: string;
}

/** The work plan after a plan write: its state, what wrote it (`proposal` by the model, `terminal` by the runtime) and its steps in order. */
export interface PlanFacts {
  readonly state: string;
  readonly cause?: string;
  readonly steps: readonly PlanStepFacts[];
}

export interface StepFacts {
  /** The step index the loop journaled. */
  readonly i: number;
  /** Milliseconds from the run's start: the step's start and, once it ended, its end. */
  readonly t: readonly number[];
  /** How the recorded request offered tools: every tool, only the ask tools (a final step), or no model request at all. */
  readonly mode: "tools" | "final" | "none";
  /** Calls the policy made before the model; they count against the tool-call ceiling. */
  readonly reads?: readonly CallFacts[];
  /** The model's calls as the batch ran them. */
  readonly calls?: readonly CallFacts[];
  /** The accepted output's text: present, empty, or no accepted output in this step. */
  readonly answer?: "text" | "silent" | "none";
  /** A final step whose model still called a tool the step did not offer. */
  readonly suppressed?: boolean;
  readonly reviews?: readonly ReviewFacts[];
  /** The step's plan calls left the plan's goal and steps different from before. */
  readonly planChanged?: boolean;
  /** Tool indexes the step's request offered, ascending; absent when the step before it offered the same set. */
  readonly toolsOffered?: readonly number[];
  /** The plan after this step's plan writes, when it differs from the plan before the step. */
  readonly plan?: PlanFacts;
  /** The user's interjection ended the step after the model ran (step end reason `interjection`). */
  readonly interjected?: boolean;
  readonly end: { readonly status: string | null; readonly reason?: string | null; readonly code?: string | null } | null;
}

export type RunEnd =
  | { readonly kind: "end"; readonly status: string; readonly reason?: string | null; readonly decision?: string | null }
  | { readonly kind: "failed"; readonly code: string | null }
  | { readonly kind: "open" };

export interface RunFacts {
  readonly run: number;
  /** Runs of one labelled captured turn share a group; 0: no label. */
  readonly group: number;
  readonly oracle: "correct" | "stuck" | "unlabelled";
  readonly start: number;
  /** A resumed run spends its first step on the resumed call, outside the loop's budget. */
  readonly resume: "none" | "approval" | "interaction" | "question";
  /** Commits to the turn-end sources, up to the replicated commit, made after the run started: 0 means it ran the replicated rules. */
  readonly codeAge: number;
  readonly end: RunEnd;
  /** The session's plan when the run began (written by an earlier turn); absent when there was none. */
  readonly planAtStart?: PlanFacts;
  readonly steps: readonly StepFacts[];
}

export interface ReplayOptions {
  readonly maxSteps: number | "progressive";
  readonly initialStepBudget: number;
  readonly stepBudgetExtension: number;
  readonly maxToolCalls: number;
  readonly turnTimeoutMs: number;
}

export interface Fixture {
  readonly format: number;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly options: ReplayOptions;
  readonly runs: readonly RunFacts[];
  /** Labelled captured turns no journal run joined: the oracle could not be applied to them. */
  readonly notMeasurable: readonly { readonly group: number; readonly oracle: string; readonly reason: string }[];
}

export function loadFixture(url: URL): Fixture {
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

/** Every key the fixture may hold, by the object it sits in. Anything else is a leak or an unreviewed fact. */
const ALLOWED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  fixture: new Set(["format", "window", "options", "runs", "notMeasurable"]),
  window: new Set(["fromMs", "toMs"]),
  options: new Set(["maxSteps", "initialStepBudget", "stepBudgetExtension", "maxToolCalls", "turnTimeoutMs"]),
  run: new Set(["run", "group", "oracle", "start", "resume", "codeAge", "end", "planAtStart", "steps"]),
  runEnd: new Set(["kind", "status", "reason", "decision", "code"]),
  step: new Set(["i", "t", "mode", "reads", "calls", "answer", "suppressed", "reviews", "planChanged", "interjected", "toolsOffered", "plan", "end"]),
  stepEnd: new Set(["status", "reason", "code"]),
  call: new Set(["plan", "asks", "offered", "skipped", "state", "dispatched", "gain", "failure", "failures", "wrote", "tool", "workStep", "credited", "halted"]),
  review: new Set(["phase", "decision", "workRemains", "delivered", "feedback", "answer", "text", "reason", "after", "t"]),
  notMeasurable: new Set(["group", "oracle", "reason"]),
  plan: new Set(["state", "cause", "steps"]),
  planStep: new Set(["id", "status"]),
};

/** A short lowercase token: no space, no `@`, no diacritic, no digit run that could be an id or an amount. */
const ENUM_VALUE = /^[a-z][a-z_:-]{0,39}$/u;

/**
 * Where the fixture breaks redaction: unknown keys, and values that are not enums, finite numbers, booleans or null.
 * Empty when the fixture is clean.
 */
export function redactionViolations(fixture: unknown): string[] {
  const found: string[] = [];
  const object = (value: unknown, kind: string, path: string, inner: (key: string, item: unknown, at: string) => void) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) { found.push(`${path}: not an object`); return; }
    for (const [key, item] of Object.entries(value)) {
      if (!ALLOWED_KEYS[kind]!.has(key)) found.push(`${path}.${key}: key not allowed in ${kind}`);
      else inner(key, item, `${path}.${key}`);
    }
  };
  const scalar = (item: unknown, at: string) => {
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) found.push(`${at}: not a finite number`); return; }
    if (typeof item === "string") { if (!ENUM_VALUE.test(item)) found.push(`${at}: string is not a short enum`); return; }
    found.push(`${at}: not a scalar`);
  };
  // A tool or plan step is a number: a name that is an enum-shaped string must not slip through as one.
  const ORDINAL_KEYS = new Set(["tool", "workStep", "id"]);
  const ordinal = (item: unknown, at: string) => {
    if (!Number.isInteger(item) || (item as number) < 0) found.push(`${at}: not an ordinal`);
  };
  const entry = (key: string, item: unknown, at: string) => ORDINAL_KEYS.has(key) ? ordinal(item, at) : scalar(item, at);
  const list = (item: unknown, at: string, each: (element: unknown, where: string) => void) => {
    if (!Array.isArray(item)) { found.push(`${at}: not an array`); return; }
    item.forEach((element, index) => each(element, `${at}[${index}]`));
  };
  const plan = (item: unknown, at: string) => object(item, "plan", at, (planKey, value, where) => {
    if (planKey === "steps") list(value, where, (item, w) => object(item, "planStep", w, (k, x, w2) => entry(k, x, w2)));
    else scalar(value, where);
  });
  object(fixture, "fixture", "$", (key, item, at) => {
    if (key === "window" || key === "options") object(item, key, at, (_k, value, where) => scalar(value, where));
    else if (key === "notMeasurable") list(item, at, (entry, where) => object(entry, "notMeasurable", where, (_k, value, w) => scalar(value, w)));
    else if (key === "runs") list(item, at, (run, where) => object(run, "run", where, (runKey, value, w) => {
      if (runKey === "end") object(value, "runEnd", w, (_k, v, w2) => scalar(v, w2));
      else if (runKey === "planAtStart") plan(value, w);
      else if (runKey === "steps") list(value, w, (step, w2) => object(step, "step", w2, (stepKey, v, w3) => {
        if (stepKey === "t") list(v, w3, (n, w4) => typeof n === "number" ? scalar(n, w4) : found.push(`${w4}: not a number`));
        else if (stepKey === "reads" || stepKey === "calls") list(v, w3, (c, w4) => object(c, "call", w4, (k, x, w5) => entry(k, x, w5)));
        else if (stepKey === "reviews") list(v, w3, (r, w4) => object(r, "review", w4, (_k, x, w5) => scalar(x, w5)));
        else if (stepKey === "toolsOffered") list(v, w3, ordinal);
        else if (stepKey === "plan") plan(v, w3);
        else if (stepKey === "end") { if (v !== null) object(v, "stepEnd", w3, (_k, x, w4) => scalar(x, w4)); }
        else scalar(v, w3);
      }));
      else scalar(value, w);
    }));
    else scalar(item, at);
  });
  return found;
}
