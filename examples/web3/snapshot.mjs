const MAX_RESPONSE_BYTES = 1_048_576;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

function quantity(value) {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("Invalid RPC quantity");
  return BigInt(value).toString();
}

async function readJson(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("RPC HTTP request failed");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("RPC response exceeds the byte limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read chain facts only. The endpoint is trusted server configuration, never a tool argument. */
export async function readSnapshot(endpoint, args = {}, { fetcher = fetch, timeoutMs = 15_000 } = {}) {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("RPC endpoint requires HTTPS or loopback HTTP");
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "address")) throw new Error("Only an optional address is accepted");
  if (args.address !== undefined && (typeof args.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(args.address))) throw new Error("Invalid EVM address");
  const signal = AbortSignal.timeout(timeoutMs);
  let requestId = 0;
  async function rpc(method, params) {
    const id = ++requestId;
    const response = await fetcher(url, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await readJson(response);
    if (!body || body.jsonrpc !== "2.0" || body.id !== id || "error" in body || !("result" in body)) throw new Error("Invalid or unsuccessful RPC response");
    return body.result;
  }
  const chainId = quantity(await rpc("eth_chainId", []));
  const height = await rpc("eth_blockNumber", []);
  const blockNumber = quantity(height);
  const block = await rpc("eth_getBlockByNumber", [height, false]);
  if (!block || quantity(block.number) !== blockNumber || !HASH.test(block.hash)) throw new Error("Invalid RPC block");
  const timestamp = quantity(block.timestamp);
  const result = { chainId, blockNumber, blockHash: block.hash, timestamp, observedAt: new Date().toISOString() };
  if (args.address !== undefined) {
    // EIP-1898 binds the balance to this exact canonical block, including during reorgs.
    result.address = args.address;
    result.balanceWei = quantity(await rpc("eth_getBalance", [args.address, { blockHash: block.hash, requireCanonical: true }]));
  }
  return result;
}
