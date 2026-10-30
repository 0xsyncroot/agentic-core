import type { DecideTurnEndModel } from "./decide-turn-end-model.js";
import { recordedSteps, STOP_CLASSES, stopClass } from "./replay-report.js";
import type { Fixture, RunFacts } from "./step-facts.js";

/**
 * Where `decide()` asks the user whether to go on (the continue card), per recorded stop class, oracle label and recorded
 * status. Each run is replayed on its own facts until `decide()` ends it; a run it pauses or does not end asks nothing. The
 * card is no end of its own: the end comparisons (`compareModels`) leave it out, and this report pins it.
 */
export interface CardCounts {
  /** Runs that ended. */
  runs: number;
  /** Runs `decide()` ended on an answer or a fallback (not a failure), and of those the partial ones. */
  ended: number;
  partial: number;
  /** Partial ends that ask, by the sub-goal fact `decide()` read: work left undone, every sub-goal shown, or no plan. */
  cards: number;
  undone: number;
  shown: number;
  noPlan: number;
}

export interface CardReport {
  readonly byClass: Readonly<Record<string, CardCounts>>;
  readonly byOracle: Readonly<Record<string, CardCounts>>;
  readonly byStatus: Readonly<Record<string, CardCounts>>;
  /** Every run whose end asks, with its stop class and oracle label. */
  readonly asked: readonly { readonly run: number; readonly stopClass: string; readonly oracle: RunFacts["oracle"]; readonly status: string }[];
}

const empty = (): CardCounts => ({ runs: 0, ended: 0, partial: 0, cards: 0, undone: 0, shown: 0, noPlan: 0 });
const recordedStatus = (run: RunFacts): string => run.end.kind === "end" ? run.end.status : run.end.kind;

export async function cardReport(model: DecideTurnEndModel, fixture: Fixture): Promise<CardReport> {
  const byClass: Record<string, CardCounts> = Object.fromEntries(STOP_CLASSES.map((name) => [name, empty()]));
  const byOracle: Record<string, CardCounts> = {};
  const byStatus: Record<string, CardCounts> = {};
  const asked: CardReport["asked"][number][] = [];
  for (const run of fixture.runs) {
    if (run.end.kind === "open") continue;
    const session = model.start(run, fixture.options);
    for (const step of recordedSteps(run).steps) {
      const decided = await session.step(step);
      if (decided.next.kind !== "continue" && decided.next.kind !== "close") break;
    }
    const end = session.ended;
    const keys = { stopClass: stopClass(run), oracle: run.oracle, status: recordedStatus(run) };
    for (const counts of [byClass[keys.stopClass] ??= empty(), byOracle[keys.oracle] ??= empty(), byStatus[keys.status] ??= empty()]) {
      counts.runs += 1;
      if (!end) continue;
      counts.ended += 1;
      if (end.partial) counts.partial += 1;
      if (!end.asks) continue;
      counts.cards += 1;
      if (end.undone === "no-plan") counts.noPlan += 1;
      else if (end.undone) counts.undone += 1;
      else counts.shown += 1;
    }
    if (end?.asks) asked.push({ run: run.run, ...keys });
  }
  const sorted = (counts: Record<string, CardCounts>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return { byClass: sorted(byClass), byOracle: sorted(byOracle), byStatus: sorted(byStatus), asked };
}

/** One line per stop class, oracle label and recorded status, then the runs that ask. */
export function formatCards(report: CardReport): string {
  const row = (name: string, c: CardCounts) => `  ${name.padEnd(22)} runs ${String(c.runs).padStart(4)}  ended ${String(c.ended).padStart(4)}`
    + `  partial ${String(c.partial).padStart(3)}  cards ${String(c.cards).padStart(3)} (undone ${c.undone}, shown ${c.shown}, no plan ${c.noPlan})`;
  return ["continue cards decide() asks:", "per recorded stop class:", ...Object.entries(report.byClass).map(([name, c]) => row(name, c)),
    "per oracle label:", ...Object.entries(report.byOracle).map(([name, c]) => row(name, c)),
    "per recorded status:", ...Object.entries(report.byStatus).map(([name, c]) => row(name, c)),
    `runs asked: ${report.asked.map((entry) => `${entry.run} ${entry.stopClass}/${entry.oracle}`).join(", ") || "none"}`].join("\n");
}
