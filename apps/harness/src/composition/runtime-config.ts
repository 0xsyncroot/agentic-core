import { readRuntimeProfile, type RuntimeProfile } from "@0xsyncroot/env-settings";
import { parseMcpServers } from "./mcp-server-config.js";
import { readStorageSettings, type PersistenceSelection, type PersistenceUrls, type SessionRedisSettings } from "./storage-settings.js";
import { readAgentBudgets } from "./agent-budgets.js";
import type { McpServerConfig } from "./mcp-server-types.js";

export type { RuntimeProfile };
export type LlmProvider = "echo" | "deepseek" | "openai";
export type { McpAuthMode } from "./mcp-server-types.js";
export type ContextCompactionMode = "off" | "auto";
export type { PersistenceProvider, PersistenceSelection, SessionRedisSettings } from "./storage-settings.js";

export interface ContextCompactionConfig {
  readonly mode: ContextCompactionMode;
  readonly thresholdRatio: number;
  readonly retainRatio: number;
  readonly estimatedCharsPerToken: number;
}

export type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig, McpTransport } from "./mcp-server-types.js";

export interface RuntimeConfig {
  readonly profile: RuntimeProfile;
  readonly llmProvider: LlmProvider;
  readonly persistence: PersistenceSelection;
  /** Prefix, plaintext switch and expiry of a Redis session store; set only when sessions live in Redis. */
  readonly sessionRedis?: SessionRedisSettings;
  readonly deepSeekBaseUrl?: string;
  readonly deepSeekModel?: string;
  readonly deepSeekThinking: boolean;
  readonly openAIBaseUrl?: string;
  readonly openAIModel?: string;
  readonly openAIOrganization?: string;
  readonly openAIProject?: string;
  readonly openAIAllowInsecureInternal?: boolean;
  /** Hard cap on model steps in one turn. See AGENTIC_AGENT_MAX_STEPS. */
  readonly agentMaxSteps: number;
  /** Hard cap on tool calls in one turn. See AGENTIC_AGENT_MAX_TOOL_CALLS. */
  readonly agentMaxToolCalls: number;
  /** How long a turn may go without a step or a tool call before the silence watch ends it. See AGENTIC_AGENT_TURN_TIMEOUT_MS. */
  readonly agentTurnTimeoutMs: number;
  /** Hard cap on one model call, start to final event. See AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS. */
  readonly agentLlmAttemptTimeoutMs: number;
  /** The longest silence before a model call is sent once more (the learned time is never above it); 0 = never. See AGENTIC_AGENT_LLM_HEDGE_AFTER_MS. */
  readonly agentLlmHedgeAfterMs: number;
  /** Rounds of policy reads before one model call. See AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS. */
  readonly agentMaxObservationRounds: number;
  /** Text one model attempt may stream before it is cut and generated again. See AGENTIC_AGENT_MAX_ANSWER_CHARS. */
  readonly agentMaxAnswerChars: number;
  /** How long a turn's open waits for the memory search. See AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS. */
  readonly agentMemoryContextTimeoutMs: number;
  /** How long a tool-originated question stays answerable. Forwarded to the core agent option of the same name. */
  readonly interactionTtlMs: number;
  /** MySQL connection pool size, forwarded to `createMySqlPersistence`. Unused by the other engines. */
  readonly mysqlPoolSize: number;
  readonly toolBrokerUrl?: string;
  readonly policyRevision: string;
  readonly memoryPolicyRevision: string;
  readonly enableDiagnosticTools: boolean;
  readonly knowledgeRoots: readonly string[];
  readonly skillRoots: readonly string[];
  readonly agentProfileFile?: string;
  readonly mcpServers: readonly McpServerConfig[];
  readonly contextCompaction: ContextCompactionConfig;
}

export interface RuntimeSecrets {
  readonly deepSeekApiKey?: string;
  readonly openAIApiKey?: string;
  readonly mcpBearerTokens: Readonly<Record<string, string>>;
  readonly persistenceUrls: PersistenceUrls;
  readonly toolBrokerSecret?: string;
  readonly dataEncryptionRootKey?: Uint8Array;
  readonly dataEncryptionKeyId: string;
}

export interface RuntimeSettings { readonly config: RuntimeConfig; readonly secrets: RuntimeSecrets }

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function booleanSetting(name: string, value: string | undefined, fallback: boolean): boolean {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function finiteSetting(name: string, value: string | undefined, fallback: number): number {
  const source = optional(value);
  if (source === undefined) return fallback;
  const parsed = Number(source);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function positiveIntegerSetting(name: string, value: string | undefined, fallback: number): number {
  const source = optional(value);
  if (source === undefined) return fallback;
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function llmProvider(env: NodeJS.ProcessEnv, deepSeekKey?: string, openAIKey?: string): LlmProvider {
  const configured = optional(env.AGENTIC_LLM_PROVIDER)?.toLowerCase();
  if (configured === "echo" || configured === "deepseek" || configured === "openai") return configured;
  if (configured) throw new Error(`Unsupported AGENTIC_LLM_PROVIDER: ${configured}`);
  const keyedProviders = ([["openai", openAIKey], ["deepseek", deepSeekKey]] as const).filter(([, key]) => key);
  if (keyedProviders.length > 1) throw new Error("AGENTIC_LLM_PROVIDER is required when multiple provider keys are configured");
  return keyedProviders[0]?.[0] ?? "echo";
}

/** This is the only place where process environment names are interpreted. */
const GENERATE_ROOT_KEY = "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"";

/**
 * Decodes the data-encryption root key, or says what is actually wrong with it.
 *
 * `Buffer.from(value, "base64url")` drops anything it does not recognise rather than failing,
 * so a passphrase decodes to *something* — 22 bytes for a 32-character one, which made the old
 * message read as a length problem when the real problem was the encoding. Hex is the other
 * trap: 64 hex characters are valid base64 and decode to 48 bytes.
 *
 * The dangerous case is the one that used to pass. A string nobody meant as base64 can still
 * decode to exactly 32 bytes, and it would then have been accepted as the key protecting every
 * durable payload — chosen by accident, and unreproducible by whoever typed it.
 */
function dataEncryptionRootKeyFrom(value: string): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) {
    throw new Error(`AGENTIC_DATA_ENCRYPTION_KEY must be base64url, not a passphrase: generate one with ${GENERATE_ROOT_KEY}`);
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) {
    // Hex is worth naming only when that is what was handed over; on any other value it reads
    // as a non sequitur and sends the reader looking for a problem they do not have.
    const hex = /^[0-9a-fA-F]+$/u.test(value) && value.length % 2 === 0 ? " Hex is not accepted; this looks like hex." : "";
    throw new Error(`AGENTIC_DATA_ENCRYPTION_KEY must decode to exactly 32 bytes; this value decodes to ${key.length}.`
      + `${hex} Generate one with ${GENERATE_ROOT_KEY}`);
  }
  return key;
}

export function readRuntimeSettings(env: NodeJS.ProcessEnv): RuntimeSettings {
  const profile = readRuntimeProfile(env);
  const deepSeekThinking = booleanSetting("DEEPSEEK_THINKING", env.DEEPSEEK_THINKING, false);
  const enableDiagnosticTools = booleanSetting(
    "AGENTIC_ENABLE_DIAGNOSTIC_TOOLS",
    env.AGENTIC_ENABLE_DIAGNOSTIC_TOOLS,
    profile === "development",
  );
  const storage = readStorageSettings(env);
  const deepSeekApiKey = optional(env.DEEPSEEK_API_KEY);
  const openAIApiKey = optional(env.OPENAI_API_KEY);
  const selectedLlm = llmProvider(env, deepSeekApiKey, openAIApiKey);
  const deepSeekBaseUrl = optional(env.DEEPSEEK_BASE_URL);
  const deepSeekModel = optional(env.DEEPSEEK_MODEL);
  const openAIBaseUrl = optional(env.OPENAI_BASE_URL);
  const openAIModel = optional(env.OPENAI_MODEL);
  const openAIOrganization = optional(env.OPENAI_ORGANIZATION);
  const openAIProject = optional(env.OPENAI_PROJECT);
  const openAIAllowInsecureInternal = booleanSetting("OPENAI_ALLOW_INSECURE_INTERNAL", env.OPENAI_ALLOW_INSECURE_INTERNAL, false);
  const { agentMaxSteps, agentMaxToolCalls, agentTurnTimeoutMs, agentLlmAttemptTimeoutMs, agentLlmHedgeAfterMs, agentMaxObservationRounds, agentMaxAnswerChars, agentMemoryContextTimeoutMs } = readAgentBudgets(env, finiteSetting);
  const interactionTtlMs = positiveIntegerSetting("AGENTIC_INTERACTION_TTL_MS", env.AGENTIC_INTERACTION_TTL_MS, 8 * 60 * 60_000);
  const mysqlPoolSize = positiveIntegerSetting("AGENTIC_MYSQL_POOL_SIZE", env.AGENTIC_MYSQL_POOL_SIZE, 10);
  const configuredMcpServers = parseMcpServers(env);
  const contextCompactionMode = (optional(env.AGENTIC_CONTEXT_COMPACTION) ?? "auto").toLowerCase();
  if (contextCompactionMode !== "off" && contextCompactionMode !== "auto") throw new Error("AGENTIC_CONTEXT_COMPACTION must be off or auto");
  const thresholdRatio = finiteSetting("AGENTIC_CONTEXT_COMPACTION_THRESHOLD_RATIO", env.AGENTIC_CONTEXT_COMPACTION_THRESHOLD_RATIO, 0.8);
  const retainRatio = finiteSetting("AGENTIC_CONTEXT_COMPACTION_RETAIN_RATIO", env.AGENTIC_CONTEXT_COMPACTION_RETAIN_RATIO, 0.16);
  const estimatedCharsPerToken = finiteSetting("AGENTIC_CONTEXT_ESTIMATED_CHARS_PER_TOKEN", env.AGENTIC_CONTEXT_ESTIMATED_CHARS_PER_TOKEN, 3);
  if (thresholdRatio <= 0 || thresholdRatio >= 1) throw new Error("AGENTIC_CONTEXT_COMPACTION_THRESHOLD_RATIO must be greater than 0 and less than 1");
  if (retainRatio <= 0 || retainRatio >= thresholdRatio) throw new Error("AGENTIC_CONTEXT_COMPACTION_RETAIN_RATIO must be greater than 0 and less than the threshold ratio");
  if (estimatedCharsPerToken <= 0) throw new Error("AGENTIC_CONTEXT_ESTIMATED_CHARS_PER_TOKEN must be positive");
  const contextCompaction: ContextCompactionConfig = Object.freeze({
    mode: contextCompactionMode,
    thresholdRatio,
    retainRatio,
    estimatedCharsPerToken,
  });
  const toolBrokerUrl = optional(env.AGENTIC_TOOL_BROKER_URL);
  const toolBrokerSecret = optional(env.AGENTIC_TOOL_BROKER_SECRET);
  const dataEncryptionKey = optional(env.AGENTIC_DATA_ENCRYPTION_KEY);
  const dataEncryptionRootKey = dataEncryptionKey ? dataEncryptionRootKeyFrom(dataEncryptionKey) : undefined;
  if ((toolBrokerUrl && !toolBrokerSecret) || (!toolBrokerUrl && toolBrokerSecret)) {
    throw new Error("AGENTIC_TOOL_BROKER_URL and AGENTIC_TOOL_BROKER_SECRET must be configured together");
  }
  if (profile === "production" && (storage.selection.sessions === "memory" || storage.selection.memory === "memory")) {
    throw new Error("Durable session and memory stores are required when AGENTIC_RUNTIME_PROFILE=production");
  }
  if (selectedLlm === "deepseek" && !deepSeekApiKey) throw new Error("DEEPSEEK_API_KEY is required for the DeepSeek provider");
  if (selectedLlm === "openai" && !openAIApiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI provider");
  if (profile === "production" && selectedLlm === "echo") {
    throw new Error("A network LLM provider is required when AGENTIC_RUNTIME_PROFILE=production");
  }
  const knowledgeRootSource = env.AGENTIC_KNOWLEDGE_ROOTS === undefined && profile === "development"
    ? "README.md,specs,docs"
    : env.AGENTIC_KNOWLEDGE_ROOTS ?? "";
  const skillRootSource = env.AGENTIC_SKILL_ROOTS === undefined ? "skills" : env.AGENTIC_SKILL_ROOTS;
  const agentProfileFile = optional(env.AGENTIC_AGENT_PROFILE_FILE);
  const mcpBearerTokens = Object.fromEntries(configuredMcpServers.flatMap((server) => {
    if (server.transport !== "http" || !server.tokenEnv) return [];
    const token = optional(env[server.tokenEnv]);
    if (!token) throw new Error(`${server.tokenEnv} is required by MCP server ${server.id}`);
    return [[server.id, token]];
  }));

  const config: RuntimeConfig = {
    profile,
    llmProvider: selectedLlm,
    persistence: storage.selection,
    ...(storage.sessionRedis ? { sessionRedis: storage.sessionRedis } : {}),
    ...(deepSeekBaseUrl ? { deepSeekBaseUrl } : {}),
    ...(deepSeekModel ? { deepSeekModel } : {}),
    ...(openAIBaseUrl ? { openAIBaseUrl } : {}),
    ...(openAIModel ? { openAIModel } : {}),
    ...(openAIOrganization ? { openAIOrganization } : {}),
    ...(openAIProject ? { openAIProject } : {}),
    ...(openAIAllowInsecureInternal ? { openAIAllowInsecureInternal } : {}),
    ...(toolBrokerUrl ? { toolBrokerUrl } : {}),
    deepSeekThinking,
    agentMaxSteps,
    agentMaxToolCalls,
    agentTurnTimeoutMs,
    agentLlmAttemptTimeoutMs,
    agentLlmHedgeAfterMs,
    agentMaxObservationRounds,
    agentMaxAnswerChars,
    agentMemoryContextTimeoutMs,
    interactionTtlMs,
    mysqlPoolSize,
    policyRevision: env.AGENTIC_POLICY_REVISION ?? "base-safety-v1",
    memoryPolicyRevision: env.AGENTIC_MEMORY_POLICY_REVISION ?? "base-tenant-actor-session-v1",
    enableDiagnosticTools,
    knowledgeRoots: knowledgeRootSource
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    skillRoots: skillRootSource.split(",").map((item) => item.trim()).filter(Boolean),
    ...(agentProfileFile ? { agentProfileFile } : {}),
    mcpServers: configuredMcpServers,
    contextCompaction,
  };
  const secrets: RuntimeSecrets = {
    ...(deepSeekApiKey ? { deepSeekApiKey } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    mcpBearerTokens: Object.freeze(mcpBearerTokens),
    persistenceUrls: storage.urls,
    ...(toolBrokerSecret ? { toolBrokerSecret } : {}),
    ...(dataEncryptionRootKey ? { dataEncryptionRootKey } : {}),
    dataEncryptionKeyId: optional(env.AGENTIC_DATA_ENCRYPTION_KEY_ID) ?? "local-v1",
  };
  return { config: Object.freeze(config), secrets: Object.freeze(secrets) };
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return readRuntimeSettings(env).config;
}
