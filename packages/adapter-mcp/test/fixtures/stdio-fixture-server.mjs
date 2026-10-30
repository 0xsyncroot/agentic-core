#!/usr/bin/env node
// A minimal, dependency-free MCP server over stdio, used only by
// packages/adapter-mcp/test/stdio-plugin.test.ts to exercise a real spawned process end to end.
// Wire format: newline-delimited JSON-RPC 2.0, per @modelcontextprotocol/client's stdio transport.
import { createInterface } from "node:readline";

// Protocol revision 2026-07-28 requires an explicit `resultType` on every result ("complete" here;
// the MRTR flow uses "input_required" instead), and these specific list/read-shaped methods are
// additionally "cacheable" and need `ttlMs`/`cacheScope` alongside it — a closed list the SDK
// enforces on decode, not something this fixture gets to opt out of for the methods it uses.
const CACHEABLE_RESULT_METHODS = new Set([
  "tools/list", "prompts/list", "resources/list", "resources/templates/list", "resources/read", "server/discover",
]);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, method, result) {
  const payload = { ...result, resultType: "complete" };
  if (CACHEABLE_RESULT_METHODS.has(method)) { payload.ttlMs = 0; payload.cacheScope = "private"; }
  write({ jsonrpc: "2.0", id, result: payload });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Returns the message it was given.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "env",
    description: "Reports whether a named environment variable is visible to this process.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "crash",
    description: "Exits the process immediately without responding, simulating a crash.",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args) {
  if (name === "echo") return { content: [{ type: "text", text: String(args?.message ?? "") }] };
  if (name === "env") {
    const value = Object.prototype.hasOwnProperty.call(process.env, args?.name) ? process.env[args.name] : null;
    return { content: [{ type: "text", text: JSON.stringify({ value }) }] };
  }
  if (name === "crash") { process.exit(1); }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === "server/discover") {
    respond(id, method, { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  } else if (method === "initialize") {
    respond(id, method, {
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} },
      serverInfo: { name: "adapter-mcp-stdio-fixture", version: "1.0.0" },
    });
  } else if (method === "notifications/initialized") {
    // Notification: no response.
  } else if (method === "tools/list") {
    respond(id, method, { tools: TOOLS });
  } else if (method === "tools/call") {
    respond(id, method, callTool(params?.name, params?.arguments));
  } else if (id !== undefined) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
});
