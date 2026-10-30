import { AgenticError, CAPABILITIES, type JsonValue, type JudgmentPort, type ToolDefinition, type ToolInvocation } from "@0xsyncroot/contracts";
import { TOOL_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";

export const RANK_CANDIDATES_TOOL_ID = "rank_candidates";

/** Above this a candidate fits; a clear choice is one candidate this sure with every other far below. */
const FITS = 0.9;
const CLEAR = 0.97;
const OTHERS_BELOW = 0.1;
const MAX_CANDIDATES = 30;
const CONCURRENCY = 4;

/**
 * A failure worth one more try: a dropped connection or a 5xx (retryable, `transient`), or the call's own deadline — System One
 * reports that as a non-retryable `timeout`, and one slow answer is the gateway's, not the question's. Never a refusal or
 * a bad answer: those come back the same.
 */
const transient = (error: unknown): boolean => error instanceof AgenticError && (error.retryable || error.code === "transient" || error.code === "timeout");

/**
 * Which of several candidates fits a criterion, judged by the fast classifier one candidate at a time.
 *
 * Choosing and classifying — which sheet of a file is the payroll, which record is the one asked for —
 * is what the classifier is good at, as long as each candidate is judged on its own: asked to pick one
 * of many sheets in a single question it follows their order, while one question per sheet gives the
 * same answer in every order (measurement: docs/incidents/2026-10-10-shared-rank-candidates.md). What
 * no classifier settles — whether two lists hold the same people — is code's to count; the agent
 * combines the two, and asks the user only when no candidate, or more than one, fits.
 */
export function createRankCandidatesTool(judgment: JudgmentPort): ToolDefinition {
  return {
    id: RANK_CANDIDATES_TOOL_ID, version: "1.0.0",
    description: "Judge, one candidate at a time, which candidates fit a criterion — to choose or classify (which sheet, file, table, record or option is the one meant). "
      + "Each candidate is judged on its own evidence by the fast classifier, so their order never matters. Give the criterion in plain words and, for each candidate, "
      + "the evidence that shows what it is (its name, title rows, header row, a few sample rows). Returns every candidate's probability, those that fit, and `clear` when exactly one does. "
      + "Use it before asking the user to choose; whether two lists hold the same people is counted by a comparison or calculation tool, not judged here.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["criterion", "candidates"],
      properties: {
        criterion: { type: "string", minLength: 3, maxLength: 600, description: "What the right candidate is, in plain words." },
        context: { type: "string", maxLength: 2_000, description: "What the choice is for (the request, the data it is compared with)." },
        candidates: { type: "array", minItems: 1, maxItems: MAX_CANDIDATES, items: {
          type: "object", additionalProperties: false, required: ["id", "evidence"],
          properties: { id: { type: "string", minLength: 1, maxLength: 200 }, evidence: { type: "string", minLength: 1, maxLength: 3_000 } },
        } },
      },
    },
    outputSchema: { type: "object", additionalProperties: true, required: ["ranked", "fits"] },
    requiredPermissions: [], sideEffect: "none", timeoutMs: 60_000,
    execute: async (invocation: ToolInvocation, signal: AbortSignal) => {
      const args = invocation.arguments as { criterion: string; context?: string; candidates: { id: string; evidence: string }[] };
      const question = { type: "noul" as const, instructions: `In the state, does the candidate fit this criterion: ${args.criterion}`,
        criteria: { true: "The candidate's evidence shows it is what the criterion describes.", false: "The evidence shows something else, or does not show it." } };
      const scores: number[] = new Array(args.candidates.length);
      let next = 0;
      const worker = async () => {
        while (next < args.candidates.length) {
          const index = next++;
          const candidate = args.candidates[index]!;
          const state = { ...(args.context ? { context: args.context } : {}), candidate: { id: candidate.id, evidence: candidate.evidence } } as JsonValue;
          // One retry: the gateway drops a connection now and then, and a ranking with a hole in it is no ranking.
          // Only a failure the provider calls transient is retried: a refused request or a malformed answer comes back the same.
          const ask = () => judgment.judge({ state, questions: { fits: question } }, signal);
          const answer = (await ask().catch((error: unknown) => { if (signal.aborted || !transient(error)) throw error; return ask(); })).answers.fits;
          if (answer?.type !== "noul") throw new AgenticError("permanent", "The classifier gave no answer for a candidate");
          scores[index] = answer.noul;
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, args.candidates.length) }, worker));
      const ranked = args.candidates.map((candidate, index) => ({ id: candidate.id, probability: Math.round(scores[index]! * 1_000) / 1_000 }))
        .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
      const fits = ranked.filter((entry) => entry.probability >= FITS).map((entry) => entry.id);
      const clear = ranked[0] && ranked[0].probability >= CLEAR && ranked.slice(1).every((entry) => entry.probability <= OTHERS_BELOW) ? ranked[0].id : undefined;
      return { ranked, fits, ...(clear ? { clear } : {}) } as JsonValue;
    },
  };
}

export function createRankCandidatesPlugin(judgment: JudgmentPort): PluginDescriptor {
  const id = "io.syncroot.base.rank-candidates";
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
      requires: {}, provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => { context.registrations.provide(TOOL_CAPABILITY, createRankCandidatesTool(judgment)); return { dispose: () => undefined }; },
      health: async () => ({ healthy: true }),
    },
  };
}
