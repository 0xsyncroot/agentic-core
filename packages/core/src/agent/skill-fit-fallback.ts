import { randomUUID } from "node:crypto";
import { skillFitQuestion, type LlmAdapter, type SkillSummary, type skillFitState } from "@0xsyncroot/contracts";
import { JUDGMENT_ATTEMPT_TIMEOUT_MS } from "./judgment-latency.js";
import { journalJudgment } from "./turn-judge.js";
import type { TurnEventWriter } from "./turn-event-writer.js";

/** Seam under which the journal holds a skill-fit answer, whoever gave it. */
const SEAM = "skill-suggestion";
const MAX_REASON_CHARS = 300;

/**
 * Whether the chat model says the request asks for this skill's procedure, for a skill the judge gave no verdict on; undefined for
 * "no", a reply that is not a verdict, a timeout or a failure. Only a "yes" is a result: a "no" from here is not the judge's
 * "ruled out".
 */
export type SkillFitFallback = (skill: SkillSummary, state: ReturnType<typeof skillFitState>, signal: AbortSignal) => Promise<boolean | undefined>;

/** The question the judge is asked about one skill (`skillFitQuestion`), put to a chat model as it reads it: the judge's own wording. */
function instruction(skill: SkillSummary): string {
  const question = skillFitQuestion(skill.id);
  const criteria = question.type === "noul" ? question.criteria : undefined;
  return [
    "Answer one question about a user's request with a single word: yes or no. Reply with that word only.",
    `Question: ${String(question.instructions)}`,
    `Answer yes when: ${String(criteria?.true)}`,
    `Answer no when: ${String(criteria?.false)}`,
  ].join("\n");
}

/** The first word of the reply, as a verdict. */
function verdictOf(reply: string): boolean | undefined {
  const word = reply.trim().split(/\s+/u)[0]?.replace(/[^\p{L}]/gu, "").toLowerCase();
  return word === "yes" ? true : word === "no" ? false : undefined;
}

/**
 * The skill-suggestion seam's fallback when the judge gave no answer: one yes/no call to the turn's own chat model per skill,
 * in the form the judge is asked in — the other skills in the state, the question about this one. The model reads it with its
 * private reasoning off (`plainParameters`), which keeps a yes/no answer well inside the judgment attempt deadline
 * (docs/incidents/2026-10-16-core-skill-fit-fallback-latency.md). The call has that deadline and is not sent again.
 *
 * It is not a turn, but it decides what the first prompt carries, so each call is journaled as the judge's calls are
 * (`judgment/classified`, seam `skill-suggestion`) under the chat model's own id: a suggestion that came from here reads
 * differently in the journal from one that came from the judge.
 *
 * `model` is the platform's choice of a model for this question (`AGENTIC_JUDGMENT_FALLBACK_MODEL`); unset, the chat model's own id.
 * The same id goes in the request and in the journal row, so the row names the model that answered.
 */
export function createSkillFitFallback(llm: LlmAdapter, writer: TurnEventWriter, turnId: string, model: string = llm.model): SkillFitFallback {
  return async (skill, state, signal) => {
    const id = `skill-fit-${randomUUID()}`;
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    const base = { seam: SEAM, providerId: llm.providerId ?? llm.id, modelId: model };
    let reply = "";
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), JUDGMENT_ATTEMPT_TIMEOUT_MS);
    try {
      const combined = AbortSignal.any([signal, deadline.signal]);
      for await (const event of llm.stream({
        requestId: id, attemptId: id, turnId: id, stepId: id, runtimeSnapshotId: "skill-fit", model,
        messages: [
          { role: "system", content: instruction(skill), context: { trust: "instruction", retention: "required", provenance: "skill-fit" } },
          { role: "user", content: JSON.stringify(state), context: { trust: "untrusted", retention: "required", provenance: "skill-fit" } },
        ],
        tools: [], parameters: { ...(llm.plainParameters ?? {}) }, contentHash: id,
      }, combined)) {
        if (event.type === "text-delta") reply += event.delta;
        if (event.type === "final") reply = event.content ?? reply;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      await journalJudgment(writer, turnId, { ...base, outcome: "failed", elapsedMs: elapsed(),
        reason: (deadline.signal.aborted ? `skill-fit request exceeded ${JUDGMENT_ATTEMPT_TIMEOUT_MS} ms` : error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_CHARS) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
    const fits = verdictOf(reply);
    if (fits === undefined) {
      await journalJudgment(writer, turnId, { ...base, outcome: "failed", elapsedMs: elapsed(), reason: "the reply was neither yes nor no" });
      return undefined;
    }
    await journalJudgment(writer, turnId, { ...base, outcome: "answered", elapsedMs: elapsed(), answers: { fits: { type: "noul", value: fits ? 1 : 0 } } });
    return fits ? true : undefined;
  };
}
