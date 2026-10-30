import type { JudgmentQuestion } from "../judgment/judgment.js";
import type { SkillDefinition } from "./skill.js";

/** A skill as a request is weighed against it: what it is called, what it is for and its role (`SkillDefinition.role`). */
export interface SkillSummary { readonly id: string; readonly name: string; readonly description: string; readonly role?: SkillDefinition["role"] }

/** The state a skill-fit question reads: the request and every skill the agent has, by id, so the skills compete. */
export function skillFitState(request: string, skills: readonly SkillSummary[]): { readonly request: string; readonly skills: Readonly<Record<string, string>> } {
  return { request, skills: Object.fromEntries(skills.map((skill) => [skill.id, skill.description])) };
}

/**
 * Whether the request asks for the work one skill describes, among all the skills the agent has (`skillFitState`).
 *
 * Asked about one skill alone ("does the request need this skill?"), the judge answers whether the request touches the
 * skill's subject, not whether it needs the work. With the other skills in the state and the question about the task, as
 * the judge's routing guidance has it, it separates the two (measurement: docs/incidents/2026-10-11-shared-skill-fit-question.md).
 */
export function skillFitQuestion(skillId: string): JudgmentQuestion {
  return {
    type: "noul",
    instructions: `Of the skills in \`skills\`, is "${skillId}" the one whose procedure the request asks to carry out?`,
    criteria: {
      true: `The task the user wants done is the task "${skillId}" describes, and no other skill in \`skills\` describes it better.`,
      false: `The request asks for a different task — another skill in \`skills\` fits better, or the request only mentions things "${skillId}" works with.`,
    },
  };
}
