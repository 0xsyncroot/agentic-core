import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, hostHeaderValidation } from '@modelcontextprotocol/node';
import { FileApi } from './files.mjs';

// One JSON line per event on stderr. Never log arguments or file content.
const log = (event, fields = {}) => console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

// Runs in the separate service image or locally. The agent only knows its HTTP endpoint.
const token = process.env.EXECUTION_SERVICE_TOKEN ?? '';
if (Buffer.byteLength(token) < 32) throw new Error('EXECUTION_SERVICE_TOKEN must contain at least 32 bytes');
// A separate deployable, so it cannot share @0xsyncroot/env-settings; this is the same rule, inline: the
// service-prefixed name wins, the retired bare `PORT` still works with one warning, and both set to
// different values refuse to start (a bare PORT is also what every other process in a pod sees).
function setting(name, retired) {
  const current = process.env[name]?.trim();
  const old = process.env[retired]?.trim();
  if (current && old && current !== old) throw new Error(`${name} and its retired name ${retired} are both set, to different values; keep only ${name}`);
  if (!current && old) log('settings.retired', { setting: retired, renameTo: name });
  return current || old || undefined;
}
const port = Number(setting('EXECUTION_PORT', 'PORT') ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid EXECUTION_PORT');
const hosts = (process.env.EXECUTION_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,agent-execution').split(',').map(s => s.trim());
const validateHost = hostHeaderValidation(hosts);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'EXECUTION_FILES_DIR', 'PYTHONDONTWRITEBYTECODE', 'EXECUTION_READER_WORKERS'].includes(key)));
const files = new FileApi(process.env.EXECUTION_FILES_DIR ?? '/var/execution-files');
await files.init();
await files.prune();
const expiryTimer = setInterval(() => files.prune().catch(() => console.error('File expiry cleanup failed')), 30_000);
expiryTimer.unref();
const reader = new Client({ name: 'execution-http-bridge', version: '1.0.0' }, {
  versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false },
});
const stdio = new StdioClientTransport({
  command: process.env.EXECUTION_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
  args: [fileURLToPath(new URL('../broker.py', import.meta.url))],
  env: environment, stderr: 'inherit',
});
await reader.connect(stdio);
const tools = await reader.listTools();
const allowedTools = new Set(['read_document', 'read_table', 'read_cells']);
if (tools.tools.length !== allowedTools.size || tools.tools.some(tool => !allowedTools.has(tool.name))) {
  throw new Error('Only the reviewed document readers may be exposed by this service');
}
// Fail closed if the broker dies. Its in-memory grants cannot survive a restart.
stdio.onclose = () => { if (!stopping) { log('broker.closed'); process.exit(1); } };
let stopping = false;

// A slot is held until the broker answers, not until the caller gives up: Python cannot interrupt
// a parse, so a timed-out call still occupies the broker. Counting it keeps the limit truthful.
const MAX_OUTSTANDING = 8, CALL_TIMEOUT_MS = 75_000, HARD_LIMIT_MS = 180_000;
const outstanding = new Map();
let nextCall = 0;
const busy = () => ({ resultType: 'complete', isError: true,
  content: [{ type: 'text', text: 'The execution service is busy. Retry after the current operation finishes.' }] });
const timedOut = () => ({ resultType: 'complete', isError: true,
  content: [{ type: 'text', text: 'The document took too long to read. Try a smaller range or page.' }] });
// A call that outlives the hard limit means the broker is wedged: exit so the orchestrator restarts it.
setInterval(() => {
  const oldest = Math.min(Infinity, ...outstanding.values().map(call => call.startedAt));
  if (Date.now() - oldest > HARD_LIMIT_MS) { log('broker.wedged', { limitMs: HARD_LIMIT_MS }); process.exit(1); }
}, 5_000).unref();

async function brokered(label, start, signal) {
  if (outstanding.size >= MAX_OUTSTANDING) { log('call.rejected', { label, outstanding: outstanding.size }); return 'busy'; }
  const id = ++nextCall, startedAt = Date.now();
  outstanding.set(id, { label, startedAt });
  const call = start();
  const settle = outcome => { outstanding.delete(id); log('call.done', { id, label, outcome, ms: Date.now() - startedAt }); };
  call.then(() => settle('ok'), () => settle('error'));
  let timer;
  const gaveUp = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), CALL_TIMEOUT_MS);
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  try {
    const first = await Promise.race([call, gaveUp]);
    if (first === 'timeout' || first === 'aborted') { log('call.abandoned', { id, label, reason: first }); return first; }
    return first;
  } finally { clearTimeout(timer); }
}
// The SDK's own timeout must outlast ours, otherwise it cancels a call whose slot we still count.
const sdkOptions = { timeout: HARD_LIMIT_MS + 30_000 };

function createMcpServer() {
  const server = new Server({ name: 'agent-execution', version: '1.0.0' }, {
    capabilities: { tools: {}, resources: {} },
    instructions: 'Files arrive as binary over internal HTTP. The backend keeps originals in its own archive and restores the temporary cache when needed. Read files by the stable documentId supplied with the conversation. Only document reading is available. Do not claim to have run code or recalculated spreadsheet formulas.',
  });
  server.setRequestHandler('tools/list', async () => tools);
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const params = request.params;
    if (!allowedTools.has(params.name)) return { resultType: 'complete', isError: true,
      content: [{ type: 'text', text: 'This service only reads documents. Code execution is unavailable.' }] };
    const result = await brokered(params.name, () => reader.callTool(params, sdkOptions), ctx.mcpReq.signal);
    return result === 'busy' ? busy() : result === 'timeout' || result === 'aborted' ? timedOut() : result;
  });
  server.setRequestHandler('resources/list', async () => ({ resources: [] }));
  server.setRequestHandler('resources/read', async (request, ctx) => {
    const result = await brokered('resources/read', () => reader.readResource(request.params, sdkOptions), ctx.mcpReq.signal);
    if (typeof result === 'string') throw new Error(result === 'busy' ? 'The execution service is busy' : 'The resource took too long to read');
    return result;
  });
  return server;
}

const expected = Buffer.from(`Bearer ${token}`);
const http = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!validateHost(req, res)) return;
  if (req.url === '/healthz' && req.method === 'GET') {
    // Ready only while the broker answers: the broker answers tools/list (no ping in the 2026 era) from its reading thread even
    // when every worker is busy, so a failure here means it is wedged, not merely loaded.
    try { await reader.listTools({}, { timeout: 2_000 }); res.end('ok'); }
    catch (error) { log('health.failed', { error: String(error?.message ?? error).slice(0, 200) }); res.writeHead(503).end('broker unresponsive'); }
    return;
  }
  // Only backend-to-backend calls: browser origins are deliberately refused.
  if (req.headers.origin) { res.writeHead(403).end(); return; }
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return;
  }
  try { if (await files.handle(req, res)) return; }
  catch (error) {
    log('files.failed', { method: req.method, error: error?.code ?? error?.name }); if (!res.headersSent) res.writeHead(500).end('File transfer failed'); else res.destroy(); return; }
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  // Request/response service only. An unused GET event stream would retain an idle connection.
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 256 * 1024,
  });
  const server = createMcpServer();
  res.once('close', () => { void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    log('mcp.failed', { error: error?.code ?? error?.name });
    if (!res.headersSent) res.writeHead(500).end('MCP request failed');
    else res.end();
  }
});
http.requestTimeout = 90_000;
http.headersTimeout = 10_000;
const bindHost = process.env.EXECUTION_BIND_HOST || '0.0.0.0';
http.listen(port, bindHost, () => console.error(`agent-execution listening on http://${bindHost}:${port}`));
// Stop accepting, let in-flight requests finish (bounded), then close the broker.
async function stop() {
  stopping = true;
  log('shutdown.begin', { outstanding: outstanding.size });
  http.close();
  http.closeIdleConnections();
  const deadline = Date.now() + 25_000;
  while (outstanding.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  await reader.close().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
