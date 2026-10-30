import type { ActorSettingStore, ContextualToolSource, JudgmentPort, KnowledgeService, LlmAdapter, MemoryService, SessionStore, SkillCatalog, SystemPromptProvider, ToolDefinition, WorkPlanningProvider } from "@0xsyncroot/contracts";
import { CAPABILITIES } from "@0xsyncroot/contracts";
import { capabilityToken } from "./capability.js";

export const LLM_CAPABILITY = capabilityToken<LlmAdapter>({ id: CAPABILITIES.llm, version: "1.0.0", cardinality: "single", protected: true });
export const SESSION_CAPABILITY = capabilityToken<SessionStore>({ id: CAPABILITIES.sessions, version: "1.0.0", cardinality: "single", protected: true });
export const MEMORY_CAPABILITY = capabilityToken<MemoryService>({ id: CAPABILITIES.memory, version: "1.0.0", cardinality: "single", protected: true });
export const KNOWLEDGE_CAPABILITY = capabilityToken<KnowledgeService>({ id: CAPABILITIES.knowledge, version: "1.0.0", cardinality: "single", protected: true });
export const SKILL_CAPABILITY = capabilityToken<SkillCatalog>({ id: CAPABILITIES.skills, version: "1.0.0", cardinality: "single", protected: true });
export const SYSTEM_PROMPT_CAPABILITY = capabilityToken<SystemPromptProvider>({ id: CAPABILITIES.systemPrompt, version: "1.0.0", cardinality: "multi", protected: false });
export const TOOL_CAPABILITY = capabilityToken<ToolDefinition>({ id: CAPABILITIES.tools, version: "1.0.0", cardinality: "multi", protected: false });
export const CONTEXTUAL_TOOL_SOURCE_CAPABILITY = capabilityToken<ContextualToolSource>({ id: CAPABILITIES.contextualTools, version: "1.0.0", cardinality: "multi", protected: false });
export const WORK_PLANNING_CAPABILITY = capabilityToken<WorkPlanningProvider>({ id: CAPABILITIES.workPlanning, version: "1.0.0", cardinality: "single", protected: true });
/** Per-person settings, from the same engine as the sessions (every persistence engine provides it). */
export const ACTOR_SETTING_CAPABILITY = capabilityToken<ActorSettingStore>({ id: CAPABILITIES.actorSettings, version: "1.0.0", cardinality: "single", protected: true });
export const JUDGMENT_CAPABILITY =capabilityToken<JudgmentPort>({ id: CAPABILITIES.judgment, version: "1.0.0", cardinality: "single", protected: true });
