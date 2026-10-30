/** Public composition-root entry point. Implementation lives in composition/. */
export {
  createBlankRuntime,
  type BlankRuntime,
  type FirstPartyPluginBundle,
  type RuntimeCompositionDependencies,
} from "./composition/create-runtime.js";
export { measureRequiredPrompt, type RequiredPromptUsage } from "./composition/required-prompt-budget.js";
export { AuthenticatedSharedRuntimeProvider } from "./composition/authenticated-shared-runtime-provider.js";
// Catalog routing: a product supplies a generation builder; the harness builds, caches and routes the generations.
export {
  type CatalogCompositionDependencies,
  type GenerationBuildInput,
  type GenerationBuilder,
  type GenerationParts,
  type GenerationView,
} from "./composition/catalog/catalog-generations.js";
export {
  catalogDatabaseUrl,
  openCatalogReader,
  type CatalogReaderConnection,
  type CatalogReaderOptions,
} from "./composition/catalog/catalog-reader.js";
// The file loaders' own parsers over release text, so a generation's skills and profile match what the files would give.
export { markdownAgentProfile } from "@0xsyncroot/adapter-agent-profile-markdown";
export { markdownSkillCatalog } from "@0xsyncroot/adapter-skills-markdown";
// Platform adapters a product composition root needs but may not depend on directly: the
// architecture keeps products on contracts + harness, so the harness is where a shared
// implementation becomes available to one.
export {
  RedisTurnAdmissionController,
  createNodeRedisAdmissionBus,
  type RedisAdmissionBus,
  type RedisAdmissionEvent,
  type RedisTurnAdmissionOptions,
} from "@0xsyncroot/adapter-admission-redis";
export { createDiagnosticConsoleSink, teeTelemetry } from "./composition/console-telemetry.js";
export {
  ElkHttpTransport,
  ElkTelemetrySink,
  createElkTelemetrySink,
  loadElkConfig,
  parseElkConfig,
  type ElkConfig,
  type ElkTelemetryOptions,
  type ElkTransport,
} from "@0xsyncroot/adapter-telemetry-elk";
export {
  LangfuseClient,
  createLangfuseTracing,
  decorateWithLangfuse,
  loadLangfuseConfig,
  parseLangfuseConfig,
  traceLlmAdapter,
  type LangfuseConfig,
  type LangfuseIngestion,
  type LangfuseTracing,
} from "@0xsyncroot/adapter-tracing-langfuse";
export { readStorageSettings } from "./composition/storage-settings.js";
export {
  readRuntimeConfig,
  type PersistenceProvider,
  type PersistenceSelection,
  type RuntimeConfig,
  type RuntimeProfile,
} from "./composition/runtime-config.js";
// A product composition builds its own delegated-authorization resolver (see mcp-plugin-catalog.js)
// by supplying only a token exchange and its PrincipalCredentialScope: products depend on contracts
// and harness, never on adapters directly (docs/architecture/extension-guide.md §2).
// Object storage, for a product that keeps files of its own (EXAMPLE: chat attachments).
export { S3ObjectStore, S3_ENV_PREFIX, normalizeKeyPrefix, s3Config, type S3Config, type S3ObjectStat } from "@0xsyncroot/adapter-s3";
export {
  MAX_ATTACHMENT_BYTES, documentAttachmentId, documentAttachmentSettings, createDocumentAttachmentStore,
  type StoredAttachment, type DocumentObjectStore, type DocumentAttachmentSettings,
} from "./composition/document-attachments.js";
export {
  createDelegatedPrincipalAuthorizationResolver,
  type McpAccessToken,
  type McpTokenExchange,
  type McpTokenExchangeInput,
} from "@0xsyncroot/adapter-mcp";
// Speech transcoding and typed-judgment providers, for a product that speaks with its users or
// reranks its knowledge. Ports live in contracts; these are the shared implementations.
export {
  GeminiSpeechAdapter,
  loadGeminiSpeechConfig,
  type GeminiSpeechConfig,
  type GeminiSpeechSettings,
} from "@0xsyncroot/adapter-gemini-speech";
export {
  TypeSafeJudgmentAdapter,
  loadTypeSafeJudgmentConfig,
  type TypeSafeJudgmentConfig,
  type TypeSafeJudgmentSettings,
} from "@0xsyncroot/adapter-typesafe";
export { JudgedKnowledgeService, type JudgedKnowledgeServiceOptions, RetainedResultsToolPolicy } from "@0xsyncroot/plugins-base";
export {
  createJudgedAuditor, passesNeeded, firstRoundRequest, type JudgedAuditor, type PreAskedRound, type AuditJudge, type JudgedAuditRecord, type JudgedAuditorOptions, type JudgmentRound, type RoundVerdict,
  createLlmGoalAuditor, goalAuditFeedback, goalAuditInput, answerOnlyInput, parseGoalAuditVerdict,
  type GoalAuditInput, type GoalAuditor, type GoalAuditVerdict,
  withCompletionAudit, startTerminalWave, firstRoundSafeEarly, type TerminalWave, procedureApplicabilityRequests, type ProcedurePreAsked, procedureVerdict, procedureCriteria, splitCriterion, COMPLETION_QUESTIONS, COMPLETION_CROSS_QUESTIONS, COMPLETION_ROUNDS, COMPLETION_CLEAR, COMPLETION_AUDIT_INSTRUCTION,
  readCriteria, readCross, flaggedVerdict, deliveredDraft, arbitratedByModel, type CompletionAuditOptions, type CompletionFlag,
  withoutRuntimeFacts, ENDING_QUESTION, readEnding, judgeEnding, endingState, type EndingFlag, attemptEvidence, blockerProven, endingFeedback, BLOCKER_FAILURES, BLOCKER_CLAIMS, type AttemptEvidence,
  besideTheBlocker, blockerAccepted, BLOCKER_PROVEN_REASON, type EndingReading,
  withActionGate, ACTION_GATE_QUESTIONS, ACTION_GATE_THRESHOLDS, type ActionGateOptions,
  withToolPreconditions, WRITE_PRECONDITION_MARKER, type ToolPreconditionOptions,
} from "@0xsyncroot/plugins-base";
// The judgment provider a deployment selects (TypeSafe or none): a product
// reads it from the environment and uses it where a fast typed classification can replace a model call.
export { createJudgmentPort, judgmentProvider, judgmentShadow, type JudgmentProvider } from "./composition/judgment-provider.js";
export { CALCULATE_TOOL_ID, createCalculationTool } from "@0xsyncroot/adapter-calculation-quickjs";
export { InMemoryToolResultSpool } from "@0xsyncroot/core";
