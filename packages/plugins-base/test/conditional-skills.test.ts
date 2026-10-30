import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentProfileDefinition, SecurityContext, SkillCatalog, SystemPromptProvider } from "@0xsyncroot/contracts";
import { SYSTEM_PROMPT_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createAgentProfilePlugin, createSkillToolsPlugin } from "../src/index.js";

const skills: SkillCatalog = (() => {
  const all = [
    { id: "x.ui", version: "1.0.0", name: "Screen", description: "screen work", instructions: "UI RULES" },
    { id: "x.payroll", version: "1.0.0", name: "Payroll", description: "payroll writes", instructions: "PAYROLL RULES" },
  ];
  return { revision: "r1", list: () => all.map(({ instructions: _i, ...rest }) => rest), get: (id: string) => all.find((skill) => skill.id === id) } as unknown as SkillCatalog;
})();
const profile = { id: "p", version: "1.0.0", name: "P", description: "d", supportedDomains: [], instructions: "BODY", contentDigest: "sha256-x",
  preloadSkills: ["x.ui", "x.payroll"], conditionalSkills: ["x.payroll"] } as AgentProfileDefinition;
const security = {} as SecurityContext;

async function provided(descriptor: ReturnType<typeof createAgentProfilePlugin>, capabilities: Record<string, unknown> = {}): Promise<SystemPromptProvider[]> {
  const prompts: SystemPromptProvider[] = [];
  await descriptor.plugin.activate({
    registrations: { provide: (token: unknown, value: unknown) => { if (token === SYSTEM_PROMPT_CAPABILITY) prompts.push(value as SystemPromptProvider); } },
    capabilities: { require: () => capabilities.skills, optional: () => capabilities.skills, all: () => [] },
  } as never);
  return prompts;
}

test("the profile offers its conditional skills to the judge and leaves a skipped one out of the turn's prompt", async () => {
  const [prompt] = await provided(createAgentProfilePlugin(profile, skills));
  assert.deepEqual(prompt!.conditionalSkills, [{ id: "x.payroll", name: "Payroll", description: "payroll writes" }]);
  const every = await prompt!.render(security);
  assert.match(every, /UI RULES/u); assert.match(every, /PAYROLL RULES/u);
  const without = await prompt!.render(security, { skippedSkills: new Set(["x.payroll"]) });
  assert.match(without, /UI RULES/u);
  assert.equal(without.includes("PAYROLL RULES"), false);
  assert.ok(without.length < every.length);
});

test("a skipped skill is listed as loadable, so the model can still load it", async () => {
  const [prompt] = await provided(createSkillToolsPlugin(["x.ui", "x.payroll"]) as never, { skills });
  const every = await prompt!.render(security);
  assert.equal(every.includes("call skill_load"), false, "everything preloaded: nothing to load");
  const without = await prompt!.render(security, { skippedSkills: new Set(["x.payroll"]) });
  assert.match(without, /call skill_load/u);
  assert.match(without, /"id":"x.payroll","version":"1.0.0","name":"Payroll","description":"payroll writes"\}/u, "no alreadyLoaded mark on the skipped skill");
  assert.match(without, /"id":"x.ui"[^}]*"alreadyLoaded":true/u);
});

test("a skill's closing is in effect while the skill is: preloaded in this turn's prompt, or loaded in the task — and never in its procedure or a tool result", async () => {
  const all = [
    { id: "x.ui", version: "1.0.0", name: "Screen", description: "screen work", instructions: "UI RULES", requiredTools: ["ui_click"], closing: "UI LAST" },
    { id: "x.payroll", version: "1.0.0", name: "Payroll", description: "payroll writes", instructions: "PAYROLL RULES", requiredTools: [], closing: "PAYROLL LAST" },
    { id: "x.recon", version: "1.0.0", name: "Recon", description: "reconcile", instructions: "RECON RULES", requiredTools: [], closing: "RECON LAST" },
    { id: "x.plain", version: "1.0.0", name: "Plain", description: "plain", instructions: "PLAIN RULES", requiredTools: [] },
  ];
  const catalog = { revision: "r2", list: () => all.map(({ instructions: _i, closing: _c, ...rest }) => rest), get: (id: string) => all.find((skill) => skill.id === id) } as unknown as SkillCatalog;
  const [prompt] = await provided(createAgentProfilePlugin(profile, catalog));
  const none = new Set<string>();
  assert.deepEqual(prompt!.skillClosings!({ loadedSkills: none }), ["UI LAST", "PAYROLL LAST"], "the preloaded ones, in the catalog's order");
  assert.deepEqual(prompt!.skillClosings!({ skippedSkills: new Set(["x.payroll"]), loadedSkills: none }), ["UI LAST"], "a skipped skill's line goes with it");
  assert.deepEqual(prompt!.skillClosings!({ skippedSkills: new Set(["x.payroll"]), loadedSkills: new Set(["x.payroll", "x.recon", "x.plain"]) }),
    ["UI LAST", "PAYROLL LAST", "RECON LAST"], "loaded in the task: in effect, skipped or loadable; a skill without one adds nothing");
  assert.deepEqual(prompt!.skillClosings!({ offeredToolIds: new Set(["other"]), loadedSkills: none }), ["PAYROLL LAST"], "a preload whose tools are not offered is not in the prompt");
  assert.equal((await prompt!.render(security)).includes("LAST"), false, "the procedure the prompt carries stops at the marker");
  const { createSkillTools } = await import("../src/tools/skill-tools.js");
  const [list, load] = createSkillTools(catalog);
  const loaded = await load!.execute({ arguments: { skill_id: "x.recon" } } as never) as Record<string, unknown>;
  assert.equal(loaded.instructions, "RECON RULES");
  assert.equal("closing" in loaded, false, "skill_load returns the procedure without its closing");
  assert.equal(JSON.stringify(await list!.execute({ arguments: {} } as never)).includes("LAST"), false);
  // A catalog where no skill has one: nothing for core to ask.
  const [plain] = await provided(createAgentProfilePlugin(profile, skills));
  assert.equal(plain!.skillClosings, undefined);
});

test("the tools the skills in effect require come from the profile's preloads and the skills the task loaded, so core keeps their groups on offer", async () => {
  const all = [
    { id: "x.ui", version: "1.0.0", name: "Screen", description: "screen work", instructions: "UI RULES", requiredTools: ["ui_click", "ui_read"] },
    { id: "x.payroll", version: "1.0.0", name: "Payroll", description: "payroll writes", instructions: "PAYROLL RULES", requiredTools: ["pay_write", "ui_read"] },
    { id: "x.recon", version: "1.0.0", name: "Recon", description: "reconcile", instructions: "RECON RULES", requiredTools: ["doc_read"] },
    { id: "x.plain", version: "1.0.0", name: "Plain", description: "plain", instructions: "PLAIN RULES", requiredTools: [] },
  ];
  const catalog = { revision: "r3", list: () => all.map(({ instructions: _i, ...rest }) => rest), get: (id: string) => all.find((skill) => skill.id === id) } as unknown as SkillCatalog;
  const [prompt] = await provided(createAgentProfilePlugin(profile, catalog));
  const none = new Set<string>();
  assert.deepEqual(prompt!.skillTools!({ loadedSkills: none }), ["ui_click", "ui_read", "pay_write"], "each preload's tools, once");
  assert.deepEqual(prompt!.skillTools!({ skippedSkills: new Set(["x.payroll"]), loadedSkills: none }), ["ui_click", "ui_read"], "a skipped preload requires nothing");
  assert.deepEqual(prompt!.skillTools!({ skippedSkills: new Set(["x.payroll"]), loadedSkills: new Set(["x.recon", "x.plain"]) }),
    ["ui_click", "ui_read", "doc_read"], "a skill loaded in the task adds its tools; one that requires none adds none");
  assert.deepEqual(prompt!.skillTools!({ offeredToolIds: new Set(["pay_write", "ui_read"]), loadedSkills: none }), ["pay_write", "ui_read"], "a preload with a required tool not offered is not in effect");
});
