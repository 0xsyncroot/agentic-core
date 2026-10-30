import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfileDefinition, SecurityContext, SkillCatalog, SkillDefinition, SystemPromptProvider, SystemPromptTurn, ToolDefinition } from "@0xsyncroot/contracts";
import { SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createAgentProfilePlugin, createSkillToolsPlugin } from "../src/index.js";
import { skillsLeftOut } from "../src/plugins/skill-availability.js";

// A preloaded skill naming tools the turn does not offer makes the model call them. Such a skill is listed as loadable
// instead.
const skill = (id: string, requiredTools: string[]): SkillDefinition => ({ id, version: "1", name: id, description: id, requiredTools, instructions: "…" });
const catalog: SkillCatalog = {
  revision: "r", list: () => [skill("a.screen", []), skill("a.data", ["data_read", "data_write"])],
  get: (id) => [skill("a.screen", []), skill("a.data", ["data_read", "data_write"])].find((entry) => entry.id === id),
};

test("a preloaded skill whose required tools the turn does not offer is left out; the judge's skips are kept", () => {
  assert.deepEqual([...skillsLeftOut(catalog, ["a.screen", "a.data"], { offeredToolIds: new Set(["ui_click"]) })], ["a.data"]);
  assert.deepEqual([...skillsLeftOut(catalog, ["a.screen", "a.data"], { offeredToolIds: new Set(["ui_click", "data_read", "data_write"]) })], []);
  assert.deepEqual([...skillsLeftOut(catalog, ["a.screen", "a.data"], { skippedSkills: new Set(["a.screen"]), offeredToolIds: new Set(["data_read", "data_write"]) })], ["a.screen"]);
  assert.deepEqual([...skillsLeftOut(catalog, ["a.screen", "a.data"])], [], "without the turn's tools nothing is assumed missing");
});

// In a composition that never offers a skill's tools, listing that skill as loadable costs the model a step loading it.
// The composition hands the plugins the skills it can run (a view over the whole catalog); the whole catalog only checks
// the boot.
const closingSkill = (id: string, requiredTools: string[], closing?: string): SkillDefinition =>
  ({ ...skill(id, requiredTools), instructions: `${id.toUpperCase()} RULES`, ...(closing ? { closing } : {}) });
function catalogOf(skills: readonly SkillDefinition[]): SkillCatalog {
  return { revision: "full-r", list: () => skills.map(({ instructions: _i, ...rest }) => rest), get: (id) => skills.find((entry) => entry.id === id) };
}
const fullSkills = [closingSkill("a.screen", []), closingSkill("a.data", ["data_read"], "DATA LAST"),
  closingSkill("a.mail", ["mail_send"]), closingSkill("a.report", [], "REPORT LAST")];
const full = catalogOf(fullSkills);
const visible = catalogOf(fullSkills.filter((entry) => entry.id !== "a.data"));
const profile = { id: "p", version: "1.0.0", name: "P", description: "d", supportedDomains: [], instructions: "BODY", contentDigest: "sha256-x",
  preloadSkills: ["a.screen", "a.data", "a.mail"], conditionalSkills: ["a.screen", "a.data"] } as AgentProfileDefinition;
const security = {} as SecurityContext;

async function activated(descriptor: PluginDescriptor, capability?: SkillCatalog) {
  const prompts: SystemPromptProvider[] = [];
  const tools: ToolDefinition[] = [];
  await descriptor.plugin.activate({
    registrations: { provide: (token: unknown, value: unknown) => {
      if (token === SYSTEM_PROMPT_CAPABILITY) prompts.push(value as SystemPromptProvider);
      if (token === TOOL_CAPABILITY) tools.push(value as ToolDefinition);
    } },
    capabilities: { require: () => capability, optional: () => capability, all: () => [] },
  } as never);
  const execute = async (toolId: string, args: Record<string, unknown>) =>
    await tools.find((tool) => tool.id === toolId)!.execute({ arguments: args } as never, new AbortController().signal) as Record<string, unknown>;
  return { prompts, execute };
}
const listed = (text: string): string[] =>
  (JSON.parse(text.split("\n").find((line) => line.startsWith("Available skills (metadata only): "))!.slice(34)) as { id: string }[]).map((entry) => entry.id);
const ids = (entries: readonly { readonly id: string }[] | undefined) => (entries ?? []).map((entry) => entry.id);
const allOffered = { offeredToolIds: new Set(["data_read", "mail_send"]) };

test("a preload the composition cannot run is not in effect: no procedure, no closing, not listed, not loadable — and nothing throws", async () => {
  const [prompt] = (await activated(createAgentProfilePlugin(profile, full, visible))).prompts;
  for (const turn of [undefined, allOffered]) {
    const text = await prompt!.render(security, turn);
    assert.equal(text.includes("A.DATA RULES"), false);
    assert.match(text, /The following 2 skills are already loaded/u);
    assert.match(text, /A\.SCREEN RULES/u);
  }
  assert.deepEqual(ids(prompt!.preloadedSkills), ["a.screen", "a.mail"]);
  assert.deepEqual(ids(prompt!.conditionalSkills), ["a.screen"], "the judge is never asked about it");
  assert.deepEqual(ids(prompt!.loadableSkills), ["a.report"], "core never suggests it");
  assert.deepEqual(prompt!.skillClosings!({ ...allOffered, loadedSkills: new Set() }), []);
  // A `skill_load` of it answers `skill_unavailable`, a succeeded result, which core counts as a load (skill-closing.ts).
  assert.deepEqual(prompt!.skillClosings!({ ...allOffered, loadedSkills: new Set(["a.data"]) }), []);
  assert.deepEqual(prompt!.skillClosings!({ ...allOffered, loadedSkills: new Set(["a.data", "a.report"]) }), ["REPORT LAST"]);

  const tools = await activated(createSkillToolsPlugin(profile.preloadSkills, full), visible);
  const listing = await tools.prompts[0]!.render(security, allOffered);
  assert.deepEqual(listed(listing), ["a.screen", "a.mail", "a.report"]);
  assert.deepEqual(ids((await tools.execute("skill_list", {})).skills as { id: string }[]), ["a.screen", "a.mail", "a.report"]);
  assert.deepEqual(await tools.execute("skill_load", { skill_id: "a.data" }),
    { error: "skill_unavailable", skillId: "a.data", reason: "The skill's required tools are not offered in this deployment, so it cannot be followed here; do not load it again, and go on with the tools and skills listed in this session." });
  assert.deepEqual(await tools.execute("skill_load", { skill_id: "a.nothing" }), { error: "skill_not_found" });
  assert.equal((await tools.execute("skill_load", { skill_id: "a.report" })).instructions, "A.REPORT RULES");
});

test("left out for this turn only — the judge's skip, or a required tool absent this turn — stays listed and loadable", async () => {
  const [prompt] = (await activated(createAgentProfilePlugin(profile, full, visible))).prompts;
  const tools = await activated(createSkillToolsPlugin(profile.preloadSkills, full), visible);
  const listing = async (turn: SystemPromptTurn) => JSON.parse((await tools.prompts[0]!.render(security, turn)).split("\n")
    .find((line) => line.startsWith("Available skills (metadata only): "))!.slice(34)) as { id: string; alreadyLoaded?: true }[];
  const skipped = { ...allOffered, skippedSkills: new Set(["a.screen"]) };
  assert.equal((await prompt!.render(security, skipped)).includes("A.SCREEN RULES"), false);
  assert.equal((await listing(skipped)).find((entry) => entry.id === "a.screen")!.alreadyLoaded, undefined, "skipped: loadable");
  assert.match(await tools.prompts[0]!.render(security, skipped), /call skill_load/u);
  const noMail = { offeredToolIds: new Set(["data_read"]) };
  assert.equal((await prompt!.render(security, noMail)).includes("A.MAIL RULES"), false);
  assert.equal((await listing(noMail)).find((entry) => entry.id === "a.mail")!.alreadyLoaded, undefined, "absent this turn: loadable");
  assert.equal((await tools.execute("skill_load", { skill_id: "a.mail" })).instructions, "A.MAIL RULES");
});

test("the whole catalog checks the boot; the view the turns read is not read before a turn", async () => {
  assert.throws(() => createAgentProfilePlugin({ ...profile, preloadSkills: ["a.screen", "a.nothing"] }, full, visible), /preloads an unknown skill: a\.nothing/u);
  const unsealed: SkillCatalog = { revision: "full-r", list: () => { throw new Error("read before seal"); }, get: () => { throw new Error("read before seal"); } };
  const [prompt] = (await activated(createAgentProfilePlugin(profile, full, unsealed))).prompts;
  await activated(createSkillToolsPlugin(profile.preloadSkills, full), unsealed);
  assert.throws(() => prompt!.loadableSkills, /read before seal/u, "the lists are read from the view on first use");
  await assert.rejects(prompt!.render(security), /read before seal/u);
  const oversized = catalogOf([...fullSkills, { ...skill("a.huge", ["data_read"]), description: "x".repeat(33_000) }]);
  await assert.rejects(activated(createSkillToolsPlugin([], oversized), visible), /exceeds the 32000-character/u, "the size check reads the whole catalog");
});
