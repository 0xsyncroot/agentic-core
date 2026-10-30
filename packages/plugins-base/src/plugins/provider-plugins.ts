import { CAPABILITIES, type JsonValue, type JudgmentPort, type KnowledgeService, type MemoryService, type SkillCatalog } from "@0xsyncroot/contracts";
import { JUDGMENT_CAPABILITY, KNOWLEDGE_CAPABILITY, MEMORY_CAPABILITY, SKILL_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createBuiltinManifest, createBuiltinPlugin } from "./builtin-plugin.js";

function providerPlugin<T>(
  id: string,
  capabilityId: string,
  token: import("@0xsyncroot/plugin-sdk").CapabilityToken<T>,
  value: T,
  config?: Readonly<Record<string, JsonValue>>,
): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: createBuiltinManifest(id, { provides: { [capabilityId]: { version: "1.0.0", cardinality: "single" } } }),
    plugin: createBuiltinPlugin(async (context) => { context.registrations.provide(token, value); return { dispose: () => undefined }; }),
    ...(config ? { config } : {}),
  };
}

export function createMemoryPlugin(memory: MemoryService): PluginDescriptor {
  return providerPlugin("io.syncroot.base.memory", CAPABILITIES.memory, MEMORY_CAPABILITY, memory);
}
export function createKnowledgePlugin(knowledge: KnowledgeService): PluginDescriptor {
  return providerPlugin("io.syncroot.base.knowledge", CAPABILITIES.knowledge, KNOWLEDGE_CAPABILITY, knowledge);
}
export function createSkillCatalogPlugin(skills: SkillCatalog): PluginDescriptor {
  return providerPlugin("io.syncroot.base.skills", CAPABILITIES.skills, SKILL_CAPABILITY, skills, {
    catalogRevision: skills.revision,
  });
}
/** The fast typed-judgment provider core lends a turn's seams and policies (journaled by core per judgment). */
export function createJudgmentPlugin(judgment: JudgmentPort): PluginDescriptor {
  return providerPlugin("io.syncroot.base.judgment", CAPABILITIES.judgment, JUDGMENT_CAPABILITY, judgment, {
    providerId: judgment.providerId, model: judgment.model,
  });
}
