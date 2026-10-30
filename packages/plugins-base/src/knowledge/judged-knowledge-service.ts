import type { JudgmentPort, JudgmentQuestion, KnowledgeHit, KnowledgeService, SecurityContext } from "@0xsyncroot/contracts";

const DEFAULT_SHORTLIST = 12;
const MAX_SHORTLIST = 30;
const DEFAULT_DEADLINE_MS = 1_200;
const MAX_DEADLINE_MS = 1_500;

export interface JudgedKnowledgeServiceOptions {
  /** Candidates taken from the inner service before reranking. Default 12, bounded 1..30. */
  readonly shortlist?: number;
  /** Own deadline for the judgment. Default 1200, clamped to at most 1500 so the search tool's own timeout never fires first. */
  readonly deadlineMs?: number;
  /** Carries `queryChars` only; the query text itself never reaches a callback. */
  readonly onJudged?: (info: {
    readonly queryChars: number; readonly candidates: number; readonly modelId: string;
    readonly elapsedMs: number; readonly reordered: boolean;
  }) => void;
  readonly onJudgmentFailure?: (info: {
    readonly queryChars: number; readonly candidates: number; readonly elapsedMs: number; readonly error: unknown;
  }) => void;
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function question(index: number): JudgmentQuestion {
  return {
    type: "noul",
    instructions: `Does \`candidates[${index}]\` contain information that helps answer \`query\`?`,
  };
}

/**
 * Reorders a knowledge service's lexical shortlist by a judgment provider's relevance
 * probabilities. One judgment request per search; the provider only supplies ordering data.
 * Any failure, deadline or missing answer returns the inner order unchanged.
 */
export class JudgedKnowledgeService implements KnowledgeService {
  readonly #shortlist: number;
  readonly #deadlineMs: number;

  constructor(
    private readonly inner: KnowledgeService,
    private readonly judge: JudgmentPort,
    private readonly options: JudgedKnowledgeServiceOptions = {},
  ) {
    this.#shortlist = clamp(options.shortlist, DEFAULT_SHORTLIST, 1, MAX_SHORTLIST);
    this.#deadlineMs = clamp(options.deadlineMs, DEFAULT_DEADLINE_MS, 1, MAX_DEADLINE_MS);
  }

  async search(query: string, limit: number, security: SecurityContext): Promise<readonly KnowledgeHit[]> {
    const shortlist = await this.inner.search(query, Math.max(limit, this.#shortlist), security);
    const fallback = shortlist.slice(0, limit);
    if (shortlist.length <= 1) return fallback;
    const started = Date.now();
    const queryChars = query.length;
    try {
      const { noul, modelId } = await this.#judge(query, shortlist);
      const ranked = shortlist
        .map((hit, index) => ({ hit, index, value: noul[index]! }))
        .sort((left, right) => right.value - left.value || left.index - right.index);
      this.options.onJudged?.({
        queryChars, candidates: shortlist.length, modelId, elapsedMs: Date.now() - started,
        reordered: ranked.some((entry, position) => entry.index !== position),
      });
      return ranked.slice(0, limit).map(({ hit, value }) => ({ ...hit, score: Math.round(value * 100) / 100 }));
    } catch (error) {
      this.options.onJudgmentFailure?.({ queryChars, candidates: shortlist.length, elapsedMs: Date.now() - started, error });
      return fallback;
    }
  }

  read(
    documentId: string,
    range: { readonly startLine: number; readonly endLine: number },
    security: SecurityContext,
  ): ReturnType<KnowledgeService["read"]> {
    return this.inner.read(documentId, range, security);
  }

  async #judge(query: string, shortlist: readonly KnowledgeHit[]): Promise<{ readonly noul: number[]; readonly modelId: string }> {
    const questions: Record<string, JudgmentQuestion> = {};
    shortlist.forEach((_hit, index) => { questions[`c${index}`] = question(index); });
    const controller = new AbortController();
    let expired!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => { controller.abort(); reject(new Error("judgment deadline exceeded")); }, this.#deadlineMs);
      expired = () => clearTimeout(timer);
    });
    try {
      const result = await Promise.race([
        this.judge.judge({
          state: { query, candidates: shortlist.map((hit) => ({ title: hit.title, excerpt: hit.excerpt })) },
          questions,
        }, controller.signal),
        deadline,
      ]);
      const noul = shortlist.map((_hit, index) => {
        const answer = result.answers[`c${index}`];
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul)) throw new Error(`judgment has no answer for candidate ${index}`);
        return Math.min(Math.max(answer.noul, 0), 1);
      });
      return { noul, modelId: result.modelId };
    } finally {
      expired();
    }
  }
}
