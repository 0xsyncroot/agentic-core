import assert from "node:assert/strict";
import test from "node:test";
import type { JudgmentRequest, SkillSummary, SystemPromptProvider, TurnJudge } from "@0xsyncroot/contracts";
import { SkillFit, skippedSkills, suggestedSkills } from "../src/agent/skill-relevance.js";
import { JudgmentMemo } from "../src/agent/judgment-memo.js";

/** The competing rule of `skippedSkills`: a conditional procedure another skill outcompetes is left out; a supporting skill never is. */
const signal = new AbortController().signal;
const skill = (id: string, role?: SkillSummary["role"]): SkillSummary => ({ id, name: id, description: `about ${id}`, ...(role ? { role } : {}) });
const prompts = (conditional: readonly SkillSummary[], loadable: readonly SkillSummary[] = []): SystemPromptProvider[] => [{
  id: "p", render: async () => "", conditionalSkills: conditional, preloadedSkills: conditional, loadableSkills: loadable, skillLoader: { toolId: "skill_load", argument: "skill_id" },
}];

/** A judge whose topic answer is `topic` for every skill and whose skill-fit answer is `fit[skill]` (none for a skill not listed). */
function judge(fit: Record<string, number>, topic = 0.9, seen: { seam: string; request: JudgmentRequest }[] = []): TurnJudge {
  return async (seam, request) => {
    seen.push({ seam, request });
    if (seam === "skill-relevance") return { modelId: "fake", answers: { needed: { type: "noul", noul: topic } } };
    const named = /"([^"]+)" the one whose procedure/u.exec(String((request.questions.fits as { instructions?: string }).instructions))?.[1] ?? "";
    return named in fit ? { modelId: "fake", answers: { fits: { type: "noul", noul: fit[named]! } } } : undefined;
  };
}

test("competing fit: a procedure the judge rules out while another skill fits is left out; the topic answer alone kept it", async () => {
  const skills = prompts([skill("x.payroll"), skill("x.employee")], [skill("x.batch")]);
  const skipped = await skippedSkills(judge({ "x.payroll": 0.02, "x.employee": 0.3, "x.batch": 0.97 }), "on", skills, "create the payment batch", signal);
  assert.deepEqual([...skipped], ["x.payroll"], "x.employee is in doubt (0.3): kept");
  assert.equal((await skippedSkills(judge({ "x.payroll": 0.02, "x.batch": 0.6 }), "on", skills, "r", signal)).size, 0, "no other skill fits: kept");
  assert.equal((await skippedSkills(judge({ "x.batch": 0.97 }), "on", skills, "r", signal)).size, 0, "no answer on the skill itself: kept");
  assert.equal((await skippedSkills(judge({ "x.payroll": 0.02, "x.batch": 0.97 }), "shadow", skills, "r", signal)).size, 0, "shadow asks and leaves nothing out");
  const seen: { seam: string; request: JudgmentRequest }[] = [];
  assert.equal((await skippedSkills(judge({ "x.payroll": 0.02, "x.batch": 0.97 }, 0.9, seen), "off", skills, "r", signal)).size, 0);
  assert.equal(seen.length, 0, "off asks nothing");
});

test("competing fit: a supporting skill is never left out for losing the choice, only by its topic answer", async () => {
  const skills = prompts([skill("x.payroll"), skill("x.documents", "supporting")]);
  const outcompeted = { "x.payroll": 0.98, "x.documents": 0 };
  assert.equal((await skippedSkills(judge(outcompeted), "on", skills, "build the payroll from the attached file", signal)).size, 0);
  assert.deepEqual([...await skippedSkills(judge(outcompeted, 0.02), "on", skills, "what is a payroll", signal)].sort(), ["x.documents", "x.payroll"],
    "the topic rule still leaves out any conditional skill it is sure is not needed");
  const seen: { seam: string; request: JudgmentRequest }[] = [];
  await skippedSkills(judge(outcompeted, 0.9, seen), "on", prompts([skill("x.documents", "supporting")], [skill("x.recon")]), "r", signal);
  assert.deepEqual(seen.map(({ seam }) => seam), ["skill-relevance"], "no procedure among the candidates: no fit is asked");
  seen.length = 0;
  await skippedSkills(judge(outcompeted, 0.9, seen), "on", prompts([skill("x.payroll")]), "r", signal);
  assert.deepEqual(seen.map(({ seam }) => seam), ["skill-relevance"], "no other skill to compete with: no fit is asked");
});

test("competing fit: the suggestion reads the same answers, each skill asked once per request and kept for a resume", async () => {
  const skills = prompts([skill("x.payroll"), skill("x.documents", "supporting")], [skill("x.batch")]);
  const seen: { seam: string; request: JudgmentRequest }[] = [];
  const answers = judge({ "x.payroll": 0.02, "x.documents": 0.01, "x.batch": 0.97 }, 0.9, seen);
  const memo = { verdicts: new JudgmentMemo(), scope: "s" };
  const fit = new SkillFit(answers, skills, "create the payment batch", signal, memo);
  const [skipped, suggested] = await Promise.all([
    skippedSkills(answers, "on", skills, "create the payment batch", signal, memo, fit),
    suggestedSkills(answers, "on", skills, "create the payment batch", new Set(), signal, memo, undefined, fit),
  ]);
  assert.deepEqual([...skipped], ["x.payroll"]);
  assert.deepEqual(suggested, [{ id: "x.batch", name: "x.batch", by: "judge" }]);
  const fits = seen.filter(({ seam }) => seam === "skill-suggestion").map(({ request }) => /"([^"]+)" the one/u.exec(String((request.questions.fits as { instructions: string }).instructions))![1]);
  assert.deepEqual(fits.sort(), ["x.batch", "x.documents", "x.payroll"], "one fit question per skill, shared by both seams");
  seen.length = 0;
  const resumed = await skippedSkills(answers, "on", skills, "create the payment batch", signal, memo);
  assert.deepEqual([...resumed], ["x.payroll"], "the kept verdicts still apply");
  assert.deepEqual(seen, [], "a resume asks nothing");
});

test("competing fit: another skill the chat model named in the judge's place does not outcompete a procedure", async () => {
  const skills = prompts([skill("x.payroll")], [skill("x.batch")]);
  const memo = { verdicts: new JudgmentMemo(), scope: "s" };
  const answers = judge({ "x.payroll": 0.02 }, 0.9);
  const suggested = await suggestedSkills(answers, "on", skills, "create the payment batch", new Set(), signal, memo, async () => true);
  assert.deepEqual(suggested, [{ id: "x.batch", name: "x.batch", by: "fallback" }]);
  assert.equal((await skippedSkills(answers, "on", skills, "create the payment batch", signal, memo)).size, 0, "the rule rests on the judge's answers only");
});
