import { createInterface } from "node:readline";
import { readSnapshot } from "./snapshot.mjs";

// Match the protocol pinned by this repository's MCP adapter.
const PROTOCOL = "2026-07-28";
const tool = {
  name: "chain_snapshot",
  description: "Read the configured EVM chain's latest block and optionally an address's native balance at that exact block hash. All quantities are decimal strings; balanceWei uses native base units. This tool cannot sign or submit transactions.",
  inputSchema: { type: "object", properties: { address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

function respond(id, method, result) {
  const cache = ["server/discover", "tools/list"].includes(method) ? { ttlMs: 0, cacheScope: "private" } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { ...result, resultType: "complete", ...cache } }) + "\n");
}

const lines = createInterface({ input: process.stdin, terminal: false });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request?.id === undefined) continue;
  const { id, method, params } = request;
  if (method === "server/discover") respond(id, method, { supportedVersions: [PROTOCOL], capabilities: { tools: {} } });
  else if (method === "initialize") respond(id, method, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "web3-readonly", version: "0.1.0" } });
  else if (method === "tools/list") respond(id, method, { tools: [tool] });
  else if (method === "tools/call") {
    try {
      if (params?.name !== tool.name) throw new Error("Unknown tool");
      const snapshot = await readSnapshot(process.env.WEB3_RPC_URL, params.arguments);
      respond(id, method, { content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot });
    } catch {
      // Provider failures can contain credentials in URLs; expose no upstream error text.
      respond(id, method, { isError: true, content: [{ type: "text", text: "Chain snapshot failed. Check the address, RPC availability and EIP-1898 support on the server." }] });
    }
  } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }) + "\n");
}
