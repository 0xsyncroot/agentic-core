import type { JsonValue } from "../shared/json.js";

/**
 * A narrow typed question over some state: whether a condition holds (`noul`), which of a defined
 * set applies (`choice`), or where it sits on ordered levels (`score`). Question ids are the
 * caller's keys and carry no meaning for the provider.
 */
export type JudgmentQuestion =
  | { readonly type: "noul"; readonly instructions: JsonValue; readonly criteria?: { readonly true?: JsonValue; readonly false?: JsonValue } }
  | { readonly type: "choice"; readonly instructions: JsonValue; readonly criteria: Readonly<Record<string, JsonValue | null>> }
  | { readonly type: "score"; readonly instructions: JsonValue; readonly criteria: readonly JsonValue[] };

export type JudgmentAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
    readonly type: "choice"; readonly choice: string;
    readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number;
  }
  | {
    readonly type: "score"; readonly score: number; readonly legend: Readonly<Record<string, string>>;
    readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number;
  };

export interface JudgmentRequest {
  readonly state: JsonValue;
  readonly questions: Readonly<Record<string, JudgmentQuestion>>;
}

export interface JudgmentResult {
  readonly modelId: string;
  readonly answers: Readonly<Record<string, JudgmentAnswer>>;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/**
 * What the caller can say about one call. `timeoutMs` is how long this call is worth waiting for, in place of the
 * provider's configured default: the cost of losing the verdict differs by the point of the loop that asks (core's seam classes).
 */
export interface JudgmentCallOptions {
  readonly timeoutMs?: number;
}

/** Typed judgments with probabilities: data for code or an agent to weigh, never a verdict the platform acts on by itself. */
export interface JudgmentPort {
  readonly providerId: string;
  readonly model: string;
  judge(request: JudgmentRequest, signal: AbortSignal, options?: JudgmentCallOptions): Promise<JudgmentResult>;
}

/**
 * A judgment asked inside a turn. Core journals each one as `judgment/classified` under `seam` (the
 * point of the loop that asked, e.g. "completion-audit") and returns the journaled values, rounded,
 * so a decision rests on exactly what the journal shows. Undefined when no provider is mounted or the
 * provider failed: every caller keeps a path that does not depend on it.
 */
export type TurnJudge = (seam: string, request: JudgmentRequest, signal: AbortSignal, options?: TurnJudgeOptions) => Promise<JudgmentResult | undefined>;

/**
 * A seam's reading of its answer at its threshold, journaled on the judgment's own row: `label` is what the seam concluded,
 * `mode` whether the conclusion acted (`on`) or was only recorded (`shadow`), `sameHash` what the content hash said beside it.
 */
export type JudgmentVerdict = {
  readonly label: string;
  readonly threshold: number;
  readonly mode: "shadow" | "on";
  readonly sameHash: boolean;
  /** For a seam that asks one question per item it holds: the item this row judged, as the runtime held it (at most 300 characters). */
  readonly item?: string;
};

/**
 * What a seam adds to one turn judgment: `verdict` reads the journaled (rounded) answers, and its result goes on the same row.
 * A verdict that waits on the seam's other judgments resolves before the row is written, so the row holds the final verdict.
 */
export interface TurnJudgeOptions {
  readonly verdict?: (answers: Readonly<Record<string, JudgmentAnswer>>) => JudgmentVerdict | undefined | Promise<JudgmentVerdict | undefined>;
}

/** What core lends a turn-control policy for one call. Kept apart from the state, which is journal data. */
export interface TurnControlServices {
  readonly judge?: TurnJudge;
}
