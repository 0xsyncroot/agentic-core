import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readSnapshot } from "./snapshot.mjs";
import { createStdioClientFactory } from "../../packages/adapter-mcp/dist/stdio-client.js";

const address = "0x" + "0".repeat(40);
const blockHash = "0x" + "a".repeat(64);
const results = { eth_chainId: "0x1", eth_blockNumber: "0x10", eth_getBlockByNumber: { number: "0x10", hash: blockHash, timestamp: "0x20" }, eth_getBalance: "0x20000000000001" };
function fixture(overrides = {}) {
  const calls = [];
  return { calls, fetcher: async (_url, options) => {
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    calls.push(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: results[request.method], ...overrides });
  } };
}

test("snapshot uses only read methods and binds large balances to the exact canonical block hash", async () => {
  const rpc = fixture();
  const result = await readSnapshot("https://rpc.example.test", { address }, rpc);
  assert.deepEqual(rpc.calls.map(call => call.method), Object.keys(results));
  assert.deepEqual(rpc.calls[3].params, [address, { blockHash, requireCanonical: true }]);
  assert.equal(result.chainId, "1");
  assert.equal(result.blockNumber, "16");
  assert.equal(result.balanceWei, "9007199254740993");
});

test("omitting an address does not request a balance", async () => {
  const rpc = fixture();
  const result = await readSnapshot("https://rpc.example.test", {}, rpc);
  assert.equal(rpc.calls.length, 3);
  assert.equal(result.balanceWei, undefined);
});

test("reject invalid addresses, extra arguments and insecure nonlocal endpoints before RPC", async () => {
  const rpc = fixture();
  await assert.rejects(readSnapshot("https://rpc.example.test", { address: "bad" }, rpc), /address/);
  await assert.rejects(readSnapshot("https://rpc.example.test", { method: "eth_sendTransaction" }, rpc), /optional address/);
  await assert.rejects(readSnapshot("http://rpc.example.test", {}, rpc), /HTTPS/);
  assert.equal(rpc.calls.length, 0);
});

test("reject provider errors, mismatched IDs, malformed quantities and oversized responses", async () => {
  for (const overrides of [{ error: { code: -1 } }, { id: 99 }, { result: "0xZZ" }]) {
    await assert.rejects(readSnapshot("https://rpc.example.test", {}, fixture(overrides)));
  }
  await assert.rejects(readSnapshot("https://rpc.example.test", {}, { fetcher: async () => new Response("x".repeat(1_048_577)) }), /byte limit/);
  await assert.rejects(readSnapshot("https://rpc.example.test", {}, { fetcher: async () => new Response("not JSON") }), SyntaxError);
});

test("the entire snapshot shares one deadline", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(readSnapshot("https://rpc.example.test", {}, {
      timeoutMs: 5,
      fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    }), { name: "TimeoutError" });
  } finally { clearTimeout(keepAlive); }
});

test("the existing MCP adapter discovers and invokes the real stdio server", async () => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks));
    assert.ok(Object.hasOwn(results, call.method));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: results[call.method] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let client;
  try {
    const create = createStdioClientFactory({ command: process.execPath, args: [fileURLToPath(new URL("./server.mjs", import.meta.url))], cwd: process.cwd(), env: { WEB3_RPC_URL: `http://127.0.0.1:${server.address().port}` } }, false, () => {}, () => {});
    client = await create();
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ["chain_snapshot"]);
    const answer = await client.callTool("chain_snapshot", { address }, new AbortController().signal);
    assert.equal(answer.kind, "completed");
    assert.equal(answer.result.structuredContent.balanceWei, "9007199254740993");
    await assert.rejects(client.callTool("sign_transaction", {}, new AbortController().signal));
  } finally {
    await client?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
