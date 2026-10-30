import type { Fixture, RunFacts, StepFacts } from "./step-facts.js";
import type { Next, ReviewVerdict, StepDecision, TurnEndModel } from "./turn-end-model.js";

/** Reasons only the core writes; a policy's own accept reason is compared as `policy`. */
const CORE_REASONS = new Set(["work-remains-final-step", "work-remains-unmoved", "closing-step-objection"]);

/** Every stop class the report prints, with or without runs: a class with none says so instead of disappearing. */
export const STOP_CLASSES = ["answer", "failed", "limit", "partial-answer", "pause", "progress-stalled", "step-failure", "turn-control-fallback",
  "work-remains-unmoved"] as const;

/** What the journal shows one step became, in the same terms a model decides them. */
export interface RecordedStep {
  readonly mode: StepFacts["mode"];
  readonly review?: ReviewVerdict;
  readonly next: Next;
}

export type RunOutcome = "reproduced" | "explained" | "unexplained" | "not-measurable";

export interface RunVerdict {
  readonly run: number;
  readonly stopClass: string;
  readonly oracle: RunFacts["oracle"];
  readonly codeAge: number;
  readonly outcome: RunOutcome;
  /** The first step whose decision differs, and what differs there. */
  readonly k?: number;
  readonly differs?: readonly string[];
  readonly recorded?: RecordedStep;
  readonly decided?: Omit<StepDecision, "step">;
  /** Named cause: a fact the journal does not hold, or why the run cannot be compared. */
  readonly cause?: string;
  /** An explained run that still diverges further on, where the cause stops covering it: the step and what differs there. */
  readonly later?: { readonly k: number; readonly differs: readonly string[] };
}

/** The recorded stop class a run belongs to, from how the journal says it ended. */
export function stopClass(run: RunFacts): string {
  const end = run.end;
  if (end.kind === "open") return "open";
  if (end.kind === "failed") return "failed";
  if (end.status.startsWith("awaiting_")) return "pause";
  const reason = end.reason ?? "";
  if (reason.startsWith("step-failure")) return "step-failure";
  if (["tool-call-limit", "step-limit", "time-limit"].includes(reason)) return "limit";
  if (reason === "progress-stalled" || reason === "work-remains-unmoved" || reason === "turn-control-fallback") return reason;
  return end.status === "partial" ? "partial-answer" : "answer";
}

/** A step the runtime adds after a failed retry to end the turn on the product's sentence: no model request, no decision. */
const fallbackCarrier = (step: StepFacts): boolean => step.mode === "none" && (step.calls ?? []).length === 0
  && (step.end?.reason ?? "").startsWith("step-failure:");

/** The steps a model decides, and what the journal recorded for each. */
export function recordedSteps(run: RunFacts): { readonly steps: readonly StepFacts[]; readonly recorded: readonly RecordedStep[] } {
  const steps = run.steps.filter((step, index) => !(index === run.steps.length - 1 && index > 0 && fallbackCarrier(step)));
  const recorded = steps.map((step, index): RecordedStep => {
    const review = [...(step.reviews ?? [])].reverse().find((item) => item.phase !== "before-model" || item.decision === "stop");
    const last = index === steps.length - 1;
    const next: Next = step.end?.status?.startsWith("awaiting_") ? { kind: "pause" }
      : step.end?.reason === "work-remains-closing" ? { kind: "close", reason: "work-remains-unmoved" }
        : last ? endOf(run) : { kind: "continue" };
    return { mode: step.mode, ...(review ? { review: { decision: review.decision as ReviewVerdict["decision"], ...(review.reason ? { reason: review.reason } : {}) } } : {}), next };
  });
  return { steps, recorded };
}

function endOf(run: RunFacts): Next {
  const end = run.end;
  if (end.kind === "end") return { kind: "end", status: end.status, ...(end.reason ? { reason: end.reason } : {}), ...(end.decision ? { decision: end.decision } : {}) };
  return { kind: "failed", code: end.kind === "failed" ? end.code ?? "unknown" : "open" };
}

/** A recorded enum and a decided one in the same spelling: a parenthesised detail is written after a colon in the fixture. */
const token = (value: string | undefined): string | undefined => value?.replace(/ \(([^)]+)\)$/u, ":$1");

function differences(recorded: RecordedStep, decided: StepDecision): string[] {
  const found: string[] = [];
  if (recorded.mode !== "none" && decided.mode !== "none" && recorded.mode !== decided.mode) found.push("mode");
  const reasonOf = (verdict?: ReviewVerdict) => verdict?.reason && CORE_REASONS.has(verdict.reason) ? verdict.reason : undefined;
  if (recorded.review && recorded.review.decision !== "stop"
    && (recorded.review.decision !== decided.review?.decision || reasonOf(recorded.review) !== reasonOf(decided.review))) found.push("review");
  const a = recorded.next;
  const b = decided.next;
  const same = a.kind === b.kind && (a.kind !== "end" || b.kind !== "end"
    || (a.status === b.status && token(a.reason) === token(b.reason) && a.decision === b.decision))
    && (a.kind !== "failed" || b.kind !== "failed" || a.code === b.code)
    && (a.kind !== "close" || b.kind !== "close" || a.reason === b.reason);
  if (!same) found.push("next");
  return found;
}

export async function replayRun(model: TurnEndModel, run: RunFacts, fixture: Fixture): Promise<RunVerdict> {
  const base = { run: run.run, stopClass: stopClass(run), oracle: run.oracle, codeAge: run.codeAge };
  if (run.end.kind === "open") return { ...base, outcome: "not-measurable", cause: "run-never-ended" };
  const { steps, recorded } = recordedSteps(run);
  const session = model.start(run, fixture.options);
  for (const [index, step] of steps.entries()) {
    const decided = await session.step(step);
    const differs = differences(recorded[index]!, decided);
    if (differs.length === 0) continue;
    const { step: _decidedStep, ...rest } = decided;
    return { ...base, outcome: "unexplained", k: step.i, differs, recorded: recorded[index]!, decided: rest };
  }
  return { ...base, outcome: "reproduced" };
}

export interface ClassCounts { runs: number; reproduced: number; explained: number; unexplained: number; notMeasurable: number }

export interface ReplayReport {
  readonly model: string;
  readonly byClass: Readonly<Record<string, ClassCounts>>;
  readonly byOracle: Readonly<Record<string, ClassCounts>>;
  /** Labelled captured turns no journal run joined. */
  readonly labelledNotJoined: number;
  /** Every run that was not reproduced, with where and why. */
  readonly divergences: readonly RunVerdict[];
}

/** A named cause for a divergence, and where the run diverges again past it; undefined when the cause does not apply. */
export interface Explanation {
  readonly cause: string;
  readonly later?: { readonly k: number; readonly differs: readonly string[] };
}

/** A named cause for a divergence, or undefined when it does not apply (explanations.ts). */
export type Explain = (run: RunFacts, verdict: RunVerdict, fixture: Fixture) => Promise<Explanation | undefined>;

/** Replays every run; a divergence is explained by the first cause that applies, else it stays unexplained from step k. */
export async function replayFixture(model: TurnEndModel, fixture: Fixture, explanations: readonly Explain[] = []): Promise<ReplayReport> {
  const verdicts: RunVerdict[] = [];
  for (const run of fixture.runs) {
    const verdict = await replayRun(model, run, fixture);
    let explained: Explanation | undefined;
    for (const explain of verdict.outcome === "unexplained" ? explanations : []) if ((explained = await explain(run, verdict, fixture))) break;
    verdicts.push(explained ? { ...verdict, outcome: "explained", ...explained } : verdict);
  }
  const tally = (key: (verdict: RunVerdict) => string, seeded: readonly string[] = []) => {
    const counts: Record<string, ClassCounts> = Object.fromEntries(seeded.map((name) => [name, { runs: 0, reproduced: 0, explained: 0, unexplained: 0, notMeasurable: 0 }]));
    for (const verdict of verdicts) {
      const entry = counts[key(verdict)] ??= { runs: 0, reproduced: 0, explained: 0, unexplained: 0, notMeasurable: 0 };
      entry.runs += 1;
      entry[verdict.outcome === "not-measurable" ? "notMeasurable" : verdict.outcome] += 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  };
  return { model: model.name, byClass: tally((verdict) => verdict.stopClass, STOP_CLASSES), byOracle: tally((verdict) => verdict.oracle),
    labelledNotJoined: fixture.notMeasurable.length, divergences: verdicts.filter((verdict) => verdict.outcome !== "reproduced") };
}

/**
 * One line per stop class and per oracle label, then the divergences grouped by what differed, then every explained run
 * that diverges again further on.
 */
export function formatReport(report: ReplayReport): string {
  const row = (name: string, c: ClassCounts) => c.runs === 0 ? `  ${name.padEnd(22)} runs    0  (no runs in the window: not measured)`
    : `  ${name.padEnd(22)} runs ${String(c.runs).padStart(4)}  reproduced ${String(c.reproduced).padStart(4)}  explained ${String(c.explained).padStart(3)}`
    + `  unexplained-from-k ${String(c.unexplained).padStart(3)}  not measurable ${String(c.notMeasurable).padStart(3)}`;
  const groups = new Map<string, number>();
  for (const verdict of report.divergences) {
    const key = `${verdict.stopClass} ${verdict.outcome}${verdict.cause ? ` (${verdict.cause})` : ""} on ${verdict.differs?.join("+") ?? "-"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [`turn-end replay: ${report.model}`, "per recorded stop class:", ...Object.entries(report.byClass).map(([name, c]) => row(name, c)),
    "per oracle label:", ...Object.entries(report.byOracle).map(([name, c]) => row(name, c)),
    `  labelled turns not joined to a journal run: ${report.labelledNotJoined}`,
    "divergences:", ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `  ${String(count).padStart(4)}  ${key}`),
    "explained to step k, diverging again at step k':",
    ...report.divergences.filter((verdict) => verdict.later).map((verdict) =>
      `  run ${verdict.run} ${verdict.stopClass} (${verdict.cause}) k ${verdict.k} -> k' ${verdict.later!.k} on ${verdict.later!.differs.join("+")}`)].join("\n");
}
