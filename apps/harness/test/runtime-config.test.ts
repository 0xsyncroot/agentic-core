import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function getMessage(run: () => unknown): string {
  try { run(); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
import { test } from "node:test";
import { readRuntimeConfig } from "../src/composition/runtime-config.js";
// Kept in its own file for topic separation; imported here for its side effect (test
// registration) so the single `runtime-config.test.ts` entry in the npm test script runs it too.
import "./mcp-plugin-catalog.test.js";
import "./document-attachments.test.js";

const encryptionKey = Buffer.alloc(32, 3).toString("base64url");

test("execution file transfer requires reviewed same-origin service authentication", () => {
  const configured = (overrides: Record<string, unknown> = {}) => readRuntimeConfig({
    EXECUTION_SERVICE_TOKEN: "test-only-service-token-for-config",
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "execution", transport: "http", endpoint: "https://execution.example/mcp",
    filesEndpoint: "https://execution.example/files", authMode: "service", tokenEnv: "EXECUTION_SERVICE_TOKEN", ...overrides }]),
  });
  const server = configured().mcpServers[0];
  assert.ok(server?.transport === "http");
  assert.equal(server.filesEndpoint, "https://execution.example/files");
  assert.deepEqual(configured({ attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/" } }).mcpServers[0]?.transport, "http");
  assert.throws(() => configured({ attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "../private" } }), /attachmentStorage/);
  assert.throws(() => configured({ attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/", secret: "must-not-be-in-config" } }), /attachmentStorage/);
  assert.equal(configured({ filesEndpoint: undefined, attachmentStorage: { s3EnvPrefix: "DOCUMENTS_S3", keyPrefix: "attachments/" } }).mcpServers[0]?.transport, "http",
    "a reader that reads the archive itself declares its storage without a transfer endpoint");
  assert.throws(() => configured({ filesEndpoint: "https://other.example/files" }), /same origin/);
  assert.throws(() => configured({ filesEndpoint: "https://execution.example/files?secret=x" }), /same origin/);
  assert.throws(() => configured({ authMode: "anonymous", tokenEnv: undefined }), /requires service auth/);
  assert.throws(() => configured({ transport: "stdio", command: "/usr/bin/python3" }), /not valid for transport/);
});

test("runtime profile and booleans fail closed", () => {
  assert.throws(() => readRuntimeConfig({ AGENTIC_RUNTIME_PROFILE: "prod" }), /unsupported agentic_runtime_profile/i);
  assert.throws(() => readRuntimeConfig({ DEEPSEEK_THINKING: "yes" }), /deepseek_thinking must be true or false/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_ENABLE_DIAGNOSTIC_TOOLS: "yes" }), /must be true or false/i);
});

test("diagnostic tools default on only for development", () => {
  assert.equal(readRuntimeConfig({}).enableDiagnosticTools, true);
  assert.equal(readRuntimeConfig({}).llmProvider, "echo");
  assert.deepEqual(readRuntimeConfig({}).persistence, { sessions: "memory", memory: "memory" });
  assert.deepEqual(readRuntimeConfig({}).skillRoots, ["skills"]);
  assert.deepEqual(readRuntimeConfig({}).knowledgeRoots, ["README.md", "specs", "docs"]);
  assert.deepEqual(readRuntimeConfig({ AGENTIC_KNOWLEDGE_ROOTS: "" }).knowledgeRoots, []);
  assert.equal(readRuntimeConfig({
    AGENTIC_RUNTIME_PROFILE: "production",
    DATABASE_URL: "postgres://example",
    DEEPSEEK_API_KEY: "secret",
    AGENTIC_DATA_ENCRYPTION_KEY: encryptionKey,
  }).enableDiagnosticTools, false);
  assert.deepEqual(readRuntimeConfig({
    AGENTIC_RUNTIME_PROFILE: "production",
    DATABASE_URL: "postgres://example",
    DEEPSEEK_API_KEY: "secret",
    AGENTIC_DATA_ENCRYPTION_KEY: encryptionKey,
  }).knowledgeRoots, []);
});

test("runtime environment cannot supply request identity or conversation state", () => {
  const config = readRuntimeConfig({
    AGENTIC_TENANT_ID: "spoofed-tenant",
    AGENTIC_USER_ID: "spoofed-user",
    AGENTIC_SESSION_ID: "spoofed-session",
  });
  assert.equal("tenantId" in config, false);
  assert.equal("userId" in config, false);
  assert.equal("sessionId" in config, false);
  assert.equal(JSON.stringify(config).includes("spoofed"), false);
});

test("production may store payloads unencrypted, a key that is set must be valid, and public config never exposes secrets", () => {
  // Encryption at rest is the deployment's choice: without a key the journal is plain JSON an
  // operator can read while diagnosing a turn.
  assert.doesNotThrow(() => readRuntimeConfig({
    AGENTIC_RUNTIME_PROFILE: "production", DATABASE_URL: "postgres://example", DEEPSEEK_API_KEY: "secret",
  }));
  // Three shapes an operator actually types, and what each one needs to be told. base64url
  // decoding drops unrecognised characters instead of failing, so only the length check used to
  // fire — and it reported a length problem for what was really an encoding problem.
  assert.throws(() => readRuntimeConfig({ AGENTIC_DATA_ENCRYPTION_KEY: "too-short" }), /exactly 32 bytes/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_DATA_ENCRYPTION_KEY: "local-demo-only-encryption-key!!" }),
    /must be base64url, not a passphrase/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_DATA_ENCRYPTION_KEY: "a".repeat(64) }),
    /decodes to 48\..*looks like hex/is, "64 hex characters are valid base64; the length alone does not explain it");
  assert.doesNotMatch(getMessage(() => readRuntimeConfig({ AGENTIC_DATA_ENCRYPTION_KEY: "short" })), /hex/iu,
    "a value that is not hex must not be told about hex");
  // And the one that used to pass: 43 characters nobody chose as a key, decoding to 32 bytes.
  assert.doesNotThrow(() => readRuntimeConfig({
    AGENTIC_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  }));
  const config = readRuntimeConfig({ DEEPSEEK_API_KEY: "provider-secret", AGENTIC_TOOL_BROKER_URL: "https://broker.example", AGENTIC_TOOL_BROKER_SECRET: "broker-secret" });
  assert.equal("deepSeekApiKey" in config, false);
  assert.equal("toolBrokerSecret" in config, false);
  assert.equal("databaseUrl" in readRuntimeConfig({ DATABASE_URL: "postgres://user:database-secret@example/db" }), false);
});

test("DeepSeek thinking accepts strict boolean values", () => {
  assert.equal(readRuntimeConfig({}).deepSeekThinking, false);
  assert.equal(readRuntimeConfig({ DEEPSEEK_THINKING: "true" }).deepSeekThinking, true);
  assert.equal(readRuntimeConfig({ DEEPSEEK_THINKING: "FALSE" }).deepSeekThinking, false);
});

test("provider and persistence selection are explicit or inferred from trusted config", () => {
  assert.equal(readRuntimeConfig({ OPENAI_API_KEY: "secret" }).llmProvider, "openai");
  assert.deepEqual(readRuntimeConfig({ DATABASE_URL: "mysql://app:secret@localhost/database" }).persistence, { sessions: "mysql", memory: "mysql" });
  assert.deepEqual(readRuntimeConfig({ DATABASE_URL: "sqlserver://app:secret@localhost/database" }).persistence, { sessions: "sqlserver", memory: "sqlserver" });
  assert.deepEqual(readRuntimeConfig({ DATABASE_URL: "mssql://app:secret@localhost/database" }).persistence, { sessions: "sqlserver", memory: "sqlserver" });
  assert.throws(() => readRuntimeConfig({ AGENTIC_LLM_PROVIDER: "openai" }), /openai_api_key is required/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_PERSISTENCE_PROVIDER: "mysql" }), /database url is required/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_PERSISTENCE_PROVIDER: "sqlserver" }), /database url is required/i);
});

test("session and memory stores can be composed independently", () => {
  const config = readRuntimeConfig({
    AGENTIC_SESSION_STORE_PROVIDER: "postgres",
    SESSION_DATABASE_URL: "postgres://session:secret@example/sessions",
    AGENTIC_MEMORY_STORE_PROVIDER: "mysql",
    MEMORY_DATABASE_URL: "mysql://memory:secret@example/memory",
  });
  assert.deepEqual(config.persistence, { sessions: "postgres", memory: "mysql" });
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.throws(() => readRuntimeConfig({
    AGENTIC_SESSION_STORE_PROVIDER: "postgres",
    SESSION_DATABASE_URL: "postgres://session:secret@example/sessions",
    AGENTIC_MEMORY_STORE_PROVIDER: "mysql",
  }), /memory store database url is required/i);
});

test("MCP server config keeps bearer tokens outside public runtime config", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp", tokenEnv: "MCP_DOCS_TOKEN" }]),
    MCP_DOCS_TOKEN: "sensitive-token",
  });
  assert.equal(config.mcpServers[0]?.id, "docs");
  assert.equal(config.mcpServers[0]?.authMode, "service");
  assert.equal(JSON.stringify(config).includes("sensitive-token"), false);
  assert.throws(() => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp", tokenEnv: "MCP_DOCS_TOKEN" }]),
  }), /mcp_docs_token is required/i);
  assert.throws(() => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://one.example/mcp" }, { id: "docs", endpoint: "https://two.example/mcp" }]),
  }), /duplicate mcp server id/i);
  assert.throws(() => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp", authMode: "delegated" }]),
  }), /delegated auth requires authProfileRef/i);
  assert.throws(() => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp", authMode: "anonymous", tokenEnv: "MCP_DOCS_TOKEN" }]),
    MCP_DOCS_TOKEN: "secret",
  }), /tokenEnv is only valid for service auth/i);
  const delegated = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "crm", endpoint: "https://mcp.example/mcp", authMode: "delegated", authProfileRef: "corp-oauth",
      riskOverrides: { lookup: "none" },
    }]),
  });
  assert.equal(delegated.mcpServers[0]?.authProfileRef, "corp-oauth");
  assert.equal(delegated.mcpServers[0]?.riskOverrides?.lookup, "none");
});

test("MCP server config accepts the full per-connector limits and passes them through untouched", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "example", endpoint: "https://mcp.example/mcp", authMode: "delegated", authProfileRef: "corp-oauth",
      timeoutMs: 15_000, maxTools: 40, maxResultBytes: 262_144, idleTtlMs: 120_000, maxConnections: 25,
      failureMode: "fail",
      elicitation: { enabled: false, allowedUrlOrigins: ["https://accounts.example"] },
      resources: { enabled: false, allowedSchemes: ["document"] },
    }]),
  });
  const server = config.mcpServers[0]!;
  assert.equal(server.timeoutMs, 15_000);
  assert.equal(server.maxTools, 40);
  assert.equal(server.maxResultBytes, 262_144);
  assert.equal(server.idleTtlMs, 120_000);
  assert.equal(server.maxConnections, 25);
  assert.equal(server.failureMode, "fail");
  assert.deepEqual(server.elicitation, { enabled: false, allowedUrlOrigins: ["https://accounts.example"] });
  assert.deepEqual(server.resources, { enabled: false, allowedSchemes: ["document"] });
});

test("MCP server config validates the new per-connector fields and names the offending index/field", () => {
  const withServer = (overrides: Record<string, unknown>) => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "docs", endpoint: "https://mcp.example/mcp", ...overrides }]),
  });
  assert.throws(() => withServer({ timeoutMs: 0 }), /AGENTIC_MCP_SERVERS\[0\]\.timeoutMs must be a positive integer/);
  assert.throws(() => withServer({ maxTools: -1 }), /AGENTIC_MCP_SERVERS\[0\]\.maxTools must be a positive integer/);
  assert.throws(() => withServer({ maxResultBytes: 1.5 }), /AGENTIC_MCP_SERVERS\[0\]\.maxResultBytes must be a positive integer/);
  assert.throws(() => withServer({ idleTtlMs: "60000" }), /AGENTIC_MCP_SERVERS\[0\]\.idleTtlMs must be a positive integer/);
  assert.throws(() => withServer({ maxConnections: 0 }), /AGENTIC_MCP_SERVERS\[0\]\.maxConnections must be a positive integer/);
  assert.throws(() => withServer({ failureMode: "retry" }), /AGENTIC_MCP_SERVERS\[0\]\.failureMode must be "omit" or "fail"/);
  assert.throws(() => withServer({ elicitation: "on" }), /AGENTIC_MCP_SERVERS\[0\]\.elicitation must be an object/);
  assert.throws(() => withServer({ elicitation: { enabled: "yes" } }), /AGENTIC_MCP_SERVERS\[0\]\.elicitation\.enabled must be a boolean/);
  assert.throws(
    () => withServer({ elicitation: { allowedUrlOrigins: ["http://accounts.example"] } }),
    /AGENTIC_MCP_SERVERS\[0\]\.elicitation\.allowedUrlOrigins entries must use HTTPS/,
  );
  assert.throws(
    () => withServer({ elicitation: { allowedUrlOrigins: ["https://accounts.example/path"] } }),
    /AGENTIC_MCP_SERVERS\[0\]\.elicitation\.allowedUrlOrigins entries must be origins/,
  );
  assert.throws(() => withServer({ resources: [] }), /AGENTIC_MCP_SERVERS\[0\]\.resources must be an object/);
  assert.throws(() => withServer({ resources: { enabled: 1 } }), /AGENTIC_MCP_SERVERS\[0\]\.resources\.enabled must be a boolean/);
  assert.throws(
    () => withServer({ resources: { allowedSchemes: "document" } }),
    /AGENTIC_MCP_SERVERS\[0\]\.resources\.allowedSchemes must be an array of non-empty strings/,
  );
  assert.throws(
    () => withServer({ resources: { allowedSchemes: [""] } }),
    /AGENTIC_MCP_SERVERS\[0\]\.resources\.allowedSchemes must be an array of non-empty strings/,
  );
});

test("a stdio MCP server config accepts command/args/cwd/envPassthrough and rejects http-only fields", () => {
  const config = readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{
      id: "example-docs", transport: "stdio", command: "/usr/bin/python3",
      args: ["-m", "example_docs"], cwd: "/srv/example-docs", envPassthrough: ["PYTHONPATH", "LANG"],
      maxRestarts: 3, restartWindowMs: 30_000, riskOverrides: { read_document: "none" },
    }]),
  });
  const server = config.mcpServers[0]!;
  assert.equal(server.transport, "stdio");
  assert.equal("endpoint" in server, false);
  assert.equal("authMode" in server, false);
  if (server.transport === "stdio") {
    assert.equal(server.command, "/usr/bin/python3");
    assert.deepEqual(server.args, ["-m", "example_docs"]);
    assert.equal(server.cwd, "/srv/example-docs");
    assert.deepEqual(server.envPassthrough, ["PYTHONPATH", "LANG"]);
    assert.equal(server.maxRestarts, 3);
    assert.equal(server.restartWindowMs, 30_000);
  }

  const withStdioServer = (overrides: Record<string, unknown>) => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "example-docs", transport: "stdio", command: "/usr/bin/python3", ...overrides }]),
  });
  assert.throws(
    () => readRuntimeConfig({ AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "example-docs", transport: "stdio" }]) }),
    /AGENTIC_MCP_SERVERS\[0\] requires command for transport "stdio"/,
  );
  assert.throws(() => withStdioServer({ endpoint: "https://mcp.example/mcp" }), /AGENTIC_MCP_SERVERS\[0\]\.endpoint is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ authMode: "service" }), /AGENTIC_MCP_SERVERS\[0\]\.authMode is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ tokenEnv: "MCP_DOCS_TOKEN" }), /AGENTIC_MCP_SERVERS\[0\]\.tokenEnv is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ authProfileRef: "corp-oauth" }), /AGENTIC_MCP_SERVERS\[0\]\.authProfileRef is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ idleTtlMs: 1000 }), /AGENTIC_MCP_SERVERS\[0\]\.idleTtlMs is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ maxConnections: 5 }), /AGENTIC_MCP_SERVERS\[0\]\.maxConnections is not valid for transport "stdio"/);
  assert.throws(() => withStdioServer({ args: ["ok", 1] }), /AGENTIC_MCP_SERVERS\[0\]\.args must be an array of non-empty strings/);
  assert.throws(() => withStdioServer({ envPassthrough: ["lowercase"] }), /AGENTIC_MCP_SERVERS\[0\]\.envPassthrough must be an array of environment variable names/);
});

test("an http MCP server config rejects stdio-only fields", () => {
  const withHttpServer = (overrides: Record<string, unknown>) => readRuntimeConfig({
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "example", endpoint: "https://mcp.example/mcp", ...overrides }]),
  });
  assert.throws(() => withHttpServer({ transport: "http", command: "/usr/bin/node" }), /AGENTIC_MCP_SERVERS\[0\]\.command is not valid for transport "http"/);
  assert.throws(() => withHttpServer({ args: ["x"] }), /AGENTIC_MCP_SERVERS\[0\]\.args is not valid for transport "http"/);
  assert.throws(() => withHttpServer({ cwd: "/tmp" }), /AGENTIC_MCP_SERVERS\[0\]\.cwd is not valid for transport "http"/);
  assert.throws(() => withHttpServer({ envPassthrough: ["PATH"] }), /AGENTIC_MCP_SERVERS\[0\]\.envPassthrough is not valid for transport "http"/);
  assert.throws(() => withHttpServer({ maxRestarts: 2 }), /AGENTIC_MCP_SERVERS\[0\]\.maxRestarts is not valid for transport "http"/);
  assert.throws(() => withHttpServer({ restartWindowMs: 1000 }), /AGENTIC_MCP_SERVERS\[0\]\.restartWindowMs is not valid for transport "http"/);
  assert.throws(
    () => readRuntimeConfig({ AGENTIC_MCP_SERVERS: JSON.stringify([{ id: "x", transport: "grpc", endpoint: "https://mcp.example/mcp" }]) }),
    /AGENTIC_MCP_SERVERS\[0\]\.transport must be "http" or "stdio"/,
  );
});

test("remote tool broker configuration is paired and fail-closed", () => {
  assert.throws(() => readRuntimeConfig({ AGENTIC_TOOL_BROKER_URL: "https://broker.example" }), /configured together/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_TOOL_BROKER_SECRET: "secret" }), /configured together/i);
  const config = readRuntimeConfig({
    AGENTIC_TOOL_BROKER_URL: "https://broker.example", AGENTIC_TOOL_BROKER_SECRET: "x".repeat(32),
  });
  assert.equal(config.toolBrokerUrl, "https://broker.example");
});

test("interaction TTL and MySQL pool size default to the core/adapter values and reject non-positive input", () => {
  const defaults = readRuntimeConfig({});
  assert.equal(defaults.interactionTtlMs, 8 * 60 * 60_000);
  assert.equal(defaults.mysqlPoolSize, 10);
  assert.equal(readRuntimeConfig({ AGENTIC_INTERACTION_TTL_MS: "60000" }).interactionTtlMs, 60_000);
  assert.equal(readRuntimeConfig({ AGENTIC_MYSQL_POOL_SIZE: "25" }).mysqlPoolSize, 25);
  assert.throws(() => readRuntimeConfig({ AGENTIC_INTERACTION_TTL_MS: "0" }), /must be a positive integer/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_INTERACTION_TTL_MS: "-5" }), /must be a positive integer/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_INTERACTION_TTL_MS: "1.5" }), /must be a positive integer/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_MYSQL_POOL_SIZE: "0" }), /must be a positive integer/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_MYSQL_POOL_SIZE: "not-a-number" }), /must be a positive integer/i);
});

test("context compaction policy is runtime-wide while exact model capacity belongs to the adapter", () => {
  const defaults = readRuntimeConfig({}).contextCompaction;
  assert.equal(defaults.mode, "auto");
  assert.equal(defaults.thresholdRatio, 0.8);
  const config = readRuntimeConfig({
    AGENTIC_CONTEXT_COMPACTION: "off",
    AGENTIC_CONTEXT_COMPACTION_THRESHOLD_RATIO: "0.75",
    AGENTIC_CONTEXT_COMPACTION_RETAIN_RATIO: "0.2",
  });
  assert.equal(config.contextCompaction.mode, "off");
  assert.throws(() => readRuntimeConfig({ AGENTIC_CONTEXT_COMPACTION: "manual" }), /must be off or auto/i);
  assert.throws(() => readRuntimeConfig({ AGENTIC_CONTEXT_COMPACTION_RETAIN_RATIO: "0.9" }), /less than the threshold/i);
});

test("both agent budgets are configurable, and both are bounded", () => {
  // The step budget was readable from the environment and the tool-call budget was not, so a
  // deployment that raised one still hit the other — and on a turn that reads a large workbook the
  // tool budget is the one reached first. They move together now, or a raised step budget buys
  // nothing.
  const fallback = readRuntimeConfig({});
  assert.equal(fallback.agentMaxSteps, 20);
  assert.equal(fallback.agentMaxToolCalls, 96, "the default must stay what the agent loop itself defaults to");

  const raised = readRuntimeConfig({ AGENTIC_AGENT_MAX_STEPS: "40", AGENTIC_AGENT_MAX_TOOL_CALLS: "160" });
  assert.equal(raised.agentMaxSteps, 40);
  assert.equal(raised.agentMaxToolCalls, 160);
  // The step ceiling is always a number: no setting lifts it.
  assert.throws(() => readRuntimeConfig({ AGENTIC_AGENT_MAX_STEPS: "progressive" }), /AGENTIC_AGENT_MAX_STEPS must be a finite number/u);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_STEPS: "0" }).agentMaxSteps, 1);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_STEPS: "1000" }).agentMaxSteps, 256);

  // Bounded at both ends: a zero would stop every turn before its first call, and an unbounded
  // value would let one turn spend a session's worth of an upstream API on its own.
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_TOOL_CALLS: "0" }).agentMaxToolCalls, 1);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_TOOL_CALLS: "100000" }).agentMaxToolCalls, 2048);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_TOOL_CALLS: "1600" }).agentMaxToolCalls, 1600, "EXAMPLE's ceiling fits the bound");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_TOOL_CALLS: "12.6" }).agentMaxToolCalls, 13);
  assert.equal(fallback.agentMaxObservationRounds, 1, "one round is what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS: "8" }).agentMaxObservationRounds, 8);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS: "0" }).agentMaxObservationRounds, 1);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS: "100" }).agentMaxObservationRounds, 16);
});

test("the turn's wall-clock budget is configurable, like the other two", () => {
  // The third budget, and the one that actually decided every run: a turn is also cut by elapsed
  // time, and that limit alone had no way to be raised. A deployment that lifted the step and
  // tool-call budgets — both bounded generously — still had its turns stopped at five minutes,
  // which reads on screen as the agent choosing to stop rather than as a deadline it never knew
  // about. Reading a forty-six-sheet workbook and writing the danh mục does not fit in five
  // minutes, so the work could not finish however well anything else worked.
  assert.equal(readRuntimeConfig({}).agentTurnTimeoutMs, 300_000, "the default must stay what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_TURN_TIMEOUT_MS: "1800000" }).agentTurnTimeoutMs, 1_800_000);

  // Bounded at both ends for the same reasons as the others: too small stops a turn before its
  // first model call returns, unbounded lets one turn hold a lease indefinitely.
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_TURN_TIMEOUT_MS: "100" }).agentTurnTimeoutMs, 10_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_TURN_TIMEOUT_MS: "99999999" }).agentTurnTimeoutMs, 3_600_000);

  // The fourth, and the one with the tightest default: how long a single model call may take,
  // measured start to final event rather than as an idle timeout. Slow model calls on a long
  // dossier come close to it, and an attempt cut here is retried, which spends the turn's budget
  // producing nothing.
  assert.equal(readRuntimeConfig({}).agentLlmAttemptTimeoutMs, 45_000, "the default must stay what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS: "180000" }).agentLlmAttemptTimeoutMs, 180_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS: "1" }).agentLlmAttemptTimeoutMs, 5_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS: "99999999" }).agentLlmAttemptTimeoutMs, 600_000);
  // The second call to a silent model call (the hedge): on by default, 0 turns it off.
  assert.equal(readRuntimeConfig({}).agentLlmHedgeAfterMs, 20_000, "the default must stay what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_HEDGE_AFTER_MS: "0" }).agentLlmHedgeAfterMs, 0);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_HEDGE_AFTER_MS: "-5" }).agentLlmHedgeAfterMs, 0);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_LLM_HEDGE_AFTER_MS: "15000" }).agentLlmHedgeAfterMs, 15_000);
  // The text one model attempt may stream (the runaway-answer backstop): the core's default, bounded both ways.
  assert.equal(readRuntimeConfig({}).agentMaxAnswerChars, 100_000, "the default must stay what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_ANSWER_CHARS: "24000" }).agentMaxAnswerChars, 24_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_ANSWER_CHARS: "10" }).agentMaxAnswerChars, 4_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MAX_ANSWER_CHARS: "99999999" }).agentMaxAnswerChars, 1_000_000);
  // How long the turn open waits for the memory search: the core's default, bounded both ways.
  assert.equal(readRuntimeConfig({}).agentMemoryContextTimeoutMs, 5_000, "the default must stay what the agent loop itself defaults to");
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS: "12000" }).agentMemoryContextTimeoutMs, 12_000);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS: "10" }).agentMemoryContextTimeoutMs, 500);
  assert.equal(readRuntimeConfig({ AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS: "99999999" }).agentMemoryContextTimeoutMs, 60_000);
});

test("every agent budget the config parses is actually handed to the agent loop", () => {
  // A setting that parses, bounds-checks and is never read is indistinguishable from a working one
  // from the outside — the run just behaves as if the dial were not there. That is how the turn
  // deadline stayed at five minutes while two other budgets were being raised, and it is worth a
  // check that outlives this particular field: whatever `agent*` budgets the config grows, the
  // composition has to spend them.
  const source = readFileSync(new URL("../src/composition/create-runtime.ts", import.meta.url), "utf8");
  const options = /const agentOptions = \{[\s\S]*?\};/u.exec(source)?.[0];
  assert.ok(options, "create-runtime.ts no longer builds an agentOptions object — this check moved");

  const parsed = readRuntimeConfig({});
  const budgets = Object.keys(parsed).filter((key) => /^agent[A-Z]/u.test(key));
  assert.ok(budgets.length >= 3, `expected the agent budgets to be found, saw ${JSON.stringify(budgets)}`);
  for (const budget of budgets) {
    assert.ok(options.includes(`config.${budget}`), `${budget} is parsed by the config and never spent: ${options}`);
  }
});

function mcpFile(yaml: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "gateway-mcp-")), "mcp-servers.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

test("AGENTIC_MCP_CONFIG_FILE reads the same schema from YAML, every value written in the file", () => {
  const file = mcpFile([
    "servers:",
    "  - id: docs",
    "    endpoint: https://docs.example/mcp",
    "    authMode: service",
    "    tokenEnv: MCP_DOCS_TOKEN",
    "    riskOverrides: { search: none }",
    "  - id: parser",
    "    transport: stdio",
    "    command: /usr/bin/python3",
    "    args: [/opt/parser/server.py]",
    "    envPassthrough: [DOCUMENT_SOURCE_BASE_URL]",
  ].join("\n"));
  const config = readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: file, MCP_DOCS_TOKEN: "token" });
  assert.deepEqual(config.mcpServers.map((server) => server.id), ["docs", "parser"]);
  const [docs, parser] = config.mcpServers;
  assert.ok(docs?.transport === "http" && parser?.transport === "stdio");
  assert.equal(docs.endpoint, "https://docs.example/mcp");
  assert.deepEqual(docs.riskOverrides, { search: "none" });
  assert.deepEqual(parser.args, ["/opt/parser/server.py"]);
});

test("AGENTIC_MCP_CONFIG_FILE fails closed on everything a reviewed file must not hide", () => {
  const read = (yaml: string, env: NodeJS.ProcessEnv = {}) => () => readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile(yaml), ...env });
  assert.throws(() => readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: "/nonexistent/mcp-servers.yaml" }), /MCP server file not found: \/nonexistent/);
  assert.throws(() => readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile("servers: []"), AGENTIC_MCP_SERVERS: "[]" }), /both set/);
  assert.throws(read("{}"), /requires a servers list/);
  assert.throws(read("servers: []\nextra: 1"), /unknown top-level key extra/);
  // The file is the whole answer to "what does this connect to": a per-environment value is a per-environment file.
  assert.throws(read("servers:\n  - id: docs\n    endpoint: ${DOCS_MCP_ENDPOINT}", { DOCS_MCP_ENDPOINT: "https://x.example/mcp" }),
    /servers\[0\]\.endpoint cannot use \$\{\.\.\.\}; write the value itself/);
  assert.throws(read("servers:\n  - id: docs\n    endpoint: https://x.example/mcp\n    riskOverride: { search: none }"), /servers\[0\]\.riskOverride is not a known field/);
  assert.throws(read("servers:\n  - id: docs\n    endpoint: https://x.example/mcp\n    token: abc"), /servers\[0\]\.token must not appear in the file; name the secret with tokenEnv/);
  assert.throws(read("servers:\n  - id: docs\n    endpoint: https://x.example/mcp\n    sessionToken: { key: abc, audience: a }"), /sessionToken\.key must not appear in the file; name the environment variable holding it with keyEnv/);
  assert.throws(read("servers:\n  - id: p\n    transport: stdio\n    command: /usr/bin/python3\n    env: { lower: b }"), /env\.lower is not an environment variable name/);
  assert.throws(read("servers:\n  - id: docs\n    endpoint: https://x.example/mcp\n    env: { A: b }"), /env is not valid for transport "http"/);
  assert.throws(read("servers:\n  - id: docs\n    endpoint: https://x.example/mcp\n    timeoutMs: 0"), /mcp-servers\.yaml servers\[0\]\.timeoutMs must be a positive integer/);
  assert.deepEqual(readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile("servers:\n") }).mcpServers, []);
});

test("an http MCP endpoint outside loopback needs allowInsecureInternal written in the server entry", async () => {
  const { createMcpPlugins } = await import("../src/composition/providers/mcp-plugin-catalog.js");
  const secrets = { mcpBearerTokens: {}, persistenceUrls: {}, dataEncryptionKeyId: "local-v1" };
  const resolvers = { example: { authorize: async () => ({ token: "t" }) } } as never;
  const plugins = (entry: Record<string, unknown>) => () => createMcpPlugins(readRuntimeConfig({
    AGENTIC_MCP_CONFIG_FILE: mcpFile(`servers:\n  - ${Object.entries({ id: "example", authMode: "delegated", authProfileRef: "example", ...entry }).map(([k, v]) => `${k}: ${v}`).join("\n    ")}`),
  }), secrets, { authorizationResolvers: resolvers });
  assert.throws(plugins({ endpoint: "http://example-mcp:5182/mcp" }), /must use HTTPS unless allowInsecureInternal/);
  assert.equal(plugins({ endpoint: "http://example-mcp:5182/mcp", allowInsecureInternal: true })().length, 1);
  assert.throws(() => readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile("servers:\n  - id: p\n    transport: stdio\n    command: /usr/bin/python3\n    allowInsecureInternal: true") }),
    /allowInsecureInternal is not valid for transport "stdio"/);
});

test("a stdio entry's literal env reaches the child, and a session token is declared by the name of its key", async () => {
  const config = readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile([
    "servers:",
    "  - id: example",
    "    endpoint: https://example-mcp.example/mcp",
    "    authMode: delegated",
    "    authProfileRef: example",
    "    sessionToken: { keyEnv: EXAMPLE_MCP_TOKEN_SECRET, audience: mcp.example }",
    "  - id: docs",
    "    transport: stdio",
    "    command: /usr/bin/python3",
    "    env: { DOCUMENT_SOURCE_BASE_URL: \"http://example-host:5081\", RETRIES: 3 }",
  ].join("\n")) });
  const [example, docs] = config.mcpServers;
  assert.ok(example?.transport === "http" && docs?.transport === "stdio");
  assert.deepEqual(example.sessionToken, { keyEnv: "EXAMPLE_MCP_TOKEN_SECRET", audience: "mcp.example", claims: { tenant: "tenantId", user: "sub", session: "sid" } });
  assert.deepEqual(docs.env, { DOCUMENT_SOURCE_BASE_URL: "http://example-host:5081", RETRIES: "3" });
});

test("a session token must be checked against an issuer or an audience, and names only known claims", () => {
  const read = (block: string) => () => readRuntimeConfig({ AGENTIC_MCP_CONFIG_FILE: mcpFile(`servers:\n  - id: example\n    endpoint: https://x.example/mcp\n    sessionToken: ${block}`) });
  assert.throws(read("{ keyEnv: K }"), /needs issuer or audience/);
  assert.throws(read("{ keyEnv: K, issuer: AgenticJSC, claims: { org: OrgID } }"), /claims\.org is not a known field/);
  const config = read("{ keyEnv: K, issuer: AgenticJSC, claims: { tenant: TenantID } }")();
  const [example] = config.mcpServers;
  assert.ok(example?.transport === "http");
  assert.deepEqual(example.sessionToken, { keyEnv: "K", issuer: "AgenticJSC", claims: { tenant: "TenantID", user: "sub", session: "sid" } });
});
