import { fileURLToPath } from "node:url";
import { createBlankRuntime } from "../../apps/harness/dist/bootstrap.js";

if (!process.env.WEB3_RPC_URL) throw new Error("Set WEB3_RPC_URL in your local .env before running this example");
const server = {
  id: "web3-readonly", transport: "stdio", command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  envPassthrough: ["WEB3_RPC_URL"], failureMode: "fail", timeoutMs: 20_000,
  riskOverrides: { chain_snapshot: "none" }, requiredPermissions: ["chain.read"],
};
// Use the full composition root and explicitly authorize only this Node executable.
const runtime = await createBlankRuntime({ ...process.env, AGENTIC_MCP_CONFIG_FILE: "", AGENTIC_MCP_SERVERS: JSON.stringify([server]) }, { mcpStdioCommandAllowlist: [process.execPath] });
try {
  const security = {
    tenantId: "web3-demo", actorId: "local-user", permissions: new Set(["chain.read"]),
    correlationId: crypto.randomUUID(), purpose: "read-only-chain-demo",
    authentication: { issuer: "local-development", subject: "local-user", assurance: "development" },
    grantRevision: "demo-v1", authorizedAgentProfiles: [runtime.agentProfile?.id ?? "default"],
  };
  const result = await runtime.agent.runTurn({
    sessionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), security,
    content: process.argv.slice(2).join(" ") || "Use the chain snapshot tool to read the current chain ID and latest block. Explain the observed facts briefly.",
  });
  console.log(result.content);
  console.error(JSON.stringify({ provider: runtime.model.providerId, model: runtime.model.modelId, outcome: result.outcome, tools: result.events.filter(event => event.type === "tool/result").map(event => event.payload) }));
  if (result.outcome !== "completed") process.exitCode = 1;
} finally {
  await runtime.close();
}
