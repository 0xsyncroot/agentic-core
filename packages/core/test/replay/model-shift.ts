import { recordedSteps, STOP_CLASSES, stopClass } from "./replay-report.js";
import type { Fixture, RunFacts } from "./step-facts.js";
import type { Next, StepDecision, TurnEndModel } from "./turn-end-model.js";

/**
 * Where a changed turn-end model ends a recorded run, against a base model on the same facts: at the same step, earlier,
 * later, or at the same step under another name. Both models see every recorded step until either ends the run; the
 * first step they decide differently says which way the end moved. The ledger is the models' own accounting and is not
 * compared.
 */
export type Shift = "same" | "earlier" | "later" | "relabelled";

export interface RunShift {
  readonly run: number;
  readonly stopClass: string;
  readonly oracle: RunFacts["oracle"];
  readonly shift: Shift;
  /** The first step the two models decide differently, and what each decided there. */
  readonly k?: number;
  readonly base?: Omit<StepDecision, "step" | "ledger">;
  readonly changed?: Omit<StepDecision, "step" | "ledger">;
}

const ends = (next: Next): boolean => next.kind !== "continue" && next.kind !== "close";

/** How near the run is to its end after a decision: a final step, then a step that ends or closes the work. */
function nearness(decision: Pick<StepDecision, "mode" | "next">): readonly [number, number] {
  return [decision.mode === "final" ? 1 : 0, ends(decision.next) ? 2 : decision.next.kind === "close" ? 1 : 0];
}

function decided({ step: _step, ledger: _ledger, ...rest }: StepDecision): Omit<StepDecision, "step" | "ledger"> {
  return JSON.parse(JSON.stringify(rest)) as Omit<StepDecision, "step" | "ledger">;
}

export async function shiftOf(base: TurnEndModel, changed: TurnEndModel, run: RunFacts, fixture: Fixture): Promise<RunShift> {
  const facts = { run: run.run, stopClass: stopClass(run), oracle: run.oracle };
  const before = base.start(run, fixture.options);
  const after = changed.start(run, fixture.options);
  for (const step of recordedSteps(run).steps) {
    const a = decided(await before.step(step));
    const b = decided(await after.step(step));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const [modeA, endA] = nearness(a);
      const [modeB, endB] = nearness(b);
      const shift: Shift = modeB !== modeA ? (modeB > modeA ? "earlier" : "later") : endB !== endA ? (endB > endA ? "earlier" : "later") : "relabelled";
      return { ...facts, shift, k: step.i, base: a, changed: b };
    }
    if (ends(b.next)) break;
  }
  return { ...facts, shift: "same" };
}

export interface ShiftCounts { runs: number; same: number; earlier: number; later: number; relabelled: number }

/** Every run that ended, compared; the shifted ones listed, and counts per recorded stop class and per oracle label. */
export async function compareModels(base: TurnEndModel, changed: TurnEndModel, fixture: Fixture): Promise<{
  readonly byClass: Readonly<Record<string, ShiftCounts>>; readonly byOracle: Readonly<Record<string, ShiftCounts>>;
  readonly shifted: readonly RunShift[];
}> {
  const shifts: RunShift[] = [];
  for (const run of fixture.runs) if (run.end.kind !== "open") shifts.push(await shiftOf(base, changed, run, fixture));
  const tally = (key: (shift: RunShift) => string, seeded: readonly string[] = []) => {
    const counts: Record<string, ShiftCounts> = Object.fromEntries(seeded.map((name) => [name, { runs: 0, same: 0, earlier: 0, later: 0, relabelled: 0 }]));
    for (const shift of shifts) {
      const entry = counts[key(shift)] ??= { runs: 0, same: 0, earlier: 0, later: 0, relabelled: 0 };
      entry.runs += 1;
      entry[shift.shift] += 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  };
  return { byClass: tally((shift) => shift.stopClass, STOP_CLASSES), byOracle: tally((shift) => shift.oracle),
    shifted: shifts.filter((shift) => shift.shift !== "same") };
}

/** One line per stop class and oracle label, then every shifted run with its step and both decisions. */
export function formatShifts(title: string, comparison: Awaited<ReturnType<typeof compareModels>>): string {
  const row = (name: string, c: ShiftCounts) => `  ${name.padEnd(22)} runs ${String(c.runs).padStart(4)}  same ${String(c.same).padStart(4)}`
    + `  earlier ${String(c.earlier).padStart(3)}  later ${String(c.later).padStart(3)}  relabelled ${String(c.relabelled).padStart(3)}`;
  const brief = (d?: Omit<StepDecision, "step" | "ledger">) => d ? `${d.mode}${d.reason ? `(${d.reason})` : ""} -> ${JSON.stringify(d.next)}` : "-";
  return [title, "per recorded stop class:", ...Object.entries(comparison.byClass).map(([name, c]) => row(name, c)),
    "per oracle label:", ...Object.entries(comparison.byOracle).map(([name, c]) => row(name, c)),
    "shifted runs:", ...comparison.shifted.map((s) => `  run ${s.run} ${s.stopClass}/${s.oracle} ${s.shift} at step ${s.k}: ${brief(s.base)}  =>  ${brief(s.changed)}`),
  ].join("\n");
}
