import type { JsonValue, SkillCatalog, ToolDefinition } from "@0xsyncroot/contracts";
import { MAX_SKILL_RESULT_CHARS } from "../plugins/agent-profile-plugin.js";
import { objectArguments, stringArgument } from "./arguments.js";

export const SKILL_LOAD_TOOL = Object.freeze({ toolId: "skill_load", argument: "skill_id" });

/** A skill's closing is read last in the request (`SkillDefinition.closing`), not in the middle of the context with the procedure. */
function withoutClosing<T extends { readonly closing?: string }>({ closing: _closing, ...rest }: T): Omit<T, "closing"> {
  return rest;
}

/** What `skill_load` says of a skill the composition leaves out: it exists, nothing here can follow it, and what to do instead. */
const SKILL_UNAVAILABLE_REASON = "The skill's required tools are not offered in this deployment, so it cannot be followed here;"
  + " do not load it again, and go on with the tools and skills listed in this session.";

/**
 * `skills` is what the tools serve: the skills this composition can run. `fullSkills` (default `skills`) is the whole
 * catalog, so a load of a skill the composition leaves out says so instead of calling the id unknown.
 */
export function createSkillTools(skills: SkillCatalog, fullSkills: SkillCatalog = skills): readonly ToolDefinition[] {
  return [
    {
      id: "skill_list", version: "1.0.0", description: "List curated agent skills available in this offline runtime.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {},
      // Curated skill visibility is selected by the verified runtime/profile, not by end-user RBAC.
      requiredPermissions: [], sideEffect: "none", timeoutMs: 500,
      execute: async () => ({ skills: skills.list().map(withoutClosing) }) as unknown as JsonValue,
    },
    {
      id: "skill_load", version: "1.0.0",
      // When, not only what: a load-on-demand procedure reaches the model only if the model calls this (agent-skill guidance).
      // Pinned: a loaded procedure is never read short to save context.
      pinnedResult: true,
      description: "Load the trusted instructions for one skill returned by skill_list. Use it first, before planning, when a listed skill that is not marked "
        + "alreadyLoaded covers the request (its description matches what the user asks); its procedure then guides every step.",
      inputSchema: { type: "object", properties: { skill_id: { type: "string" } }, required: ["skill_id"], additionalProperties: false },
      outputSchema: {},
      // Loading instructions cannot elevate business permissions or bypass tool policy.
      requiredPermissions: [], sideEffect: "none", timeoutMs: 500,
      // A skill is instructions the runtime asked for, not data: it gets a budget of its own,
      // not the cap meant for tool payloads.
      maxResultChars: MAX_SKILL_RESULT_CHARS,
      execute: async (invocation) => {
        const skillId = stringArgument(objectArguments(invocation.arguments), "skill_id", 200);
        const skill = skills.get(skillId);
        if (skill) return withoutClosing(skill) as unknown as JsonValue;
        return fullSkills.get(skillId) ? { error: "skill_unavailable", skillId, reason: SKILL_UNAVAILABLE_REASON } : { error: "skill_not_found" };
      },
    },
  ];
}
