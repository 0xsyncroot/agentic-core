// Starts the real HTTP MCP server locally (documents from a temp directory instead of S3) and talks
// to it with the official MCP client, the way the backend does. Run from the repository root: npm run mcp:documents:test
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { Agent, request, createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const token = 'h'.repeat(40);
const port = 18000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}` };
const dir = fileURLToPath(new URL('..', import.meta.url));
let child, logs = '';

const workbook = rows => execFileSync('python3', ['-c',
  `import sys; sys.path.insert(0,sys.argv[1]); import fixtures; sys.stdout.buffer.write(fixtures.build_xlsx({'Payroll':[['Employee','Amount']]+[['n%d'%i,i] for i in range(${rows})]}))`, dir], { maxBuffer: 1 << 28 });
const sources = new Map();
const store = (bytes, directory = sources.get(url)) => {
  const documentId = randomBytes(16).toString('hex');
  writeFileSync(join(directory, documentId), bytes);
  writeFileSync(join(directory, `${documentId}.meta.json`), JSON.stringify({ name: 'Bảng lương.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  return documentId;
};
const start = async (listenPort, extra = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'document-readers-'));
  sources.set(`http://127.0.0.1:${listenPort}`, directory);
  const process = spawn('python3', [join(dir, 'http_server.py'), '--local'], { stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...globalThis.process.env, DOCUMENT_READERS_TOKEN: token, DOCUMENT_READERS_PORT: String(listenPort),
      DOCUMENT_SOURCE_DIR: directory, PYTHONDONTWRITEBYTECODE: '1',
      // Isolated from the developer's .env (which may point at a local attachment folder).
      AGENTIC_ATTACHMENTS_DIR: '', ...extra } });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${listenPort}/healthz`).then(r => r.ok, () => false)) return process;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
};
const withClient = (run) => withBase(url, run);
const withBase = async (base, run) => {
  const client = new Client({ name: 'http-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => token } }));
  try { return await run(client); } finally { await client.close(); }
};

before(async () => {
  child = await start(port);
  child.stderr.on('data', chunk => { logs += chunk; });
});
after(() => child?.kill());

test('captured tool exceptions retain server traceback and chained causes', () => {
  execFileSync('python3', [join(dir, 'selftest_diagnostics.py')], { stdio: 'pipe' });
});

test('a refused request after a successful keep-alive request closes the unread body', async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const post = (body, extra = {}) => new Promise((resolve, reject) => {
    const req = request(`${url}/mcp`, { method: 'POST', agent, headers: {
      ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extra,
    } }, res => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, reused: req.reusedSocket }));
    });
    req.once('error', reject);
    req.end(body);
  });
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal((await post(body)).status, 200);
    const refusal = await post('x', { origin: 'https://untrusted.example' });
    assert.equal(refusal.reused, true, 'exercise the same handler instance');
    assert.equal(refusal.status, 403);
    assert.equal(refusal.connection, 'close', 'unread x must not become the prefix of the next POST');
    assert.equal((await post(body)).status, 200);
  } finally { agent.destroy(); }
});

test('read_table failures log the original error and page context, without exposing diagnostics on the wire', async () => {
  const documentId = store(workbook(3));
  const rpcId = 'read-table-diagnostic';
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'read_table',
      arguments: { documentId, sheet: 'Payroll', offset: 20, maxRows: 10, columns: 'invalid', privateData: 'DO_NOT_LOG_ARGS' } } }) });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.result.isError, true);
  assert.match(JSON.stringify(reply.result), /columns must be an object/);
  assert.doesNotMatch(JSON.stringify(reply.result), /traceback|diagnostic/);
  let diagnostic;
  for (let attempt = 0; attempt < 50 && !diagnostic; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    diagnostic = logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.rpcId === rpcId);
  }
  assert.ok(diagnostic, 'the handled error must be logged, not only an escaped exception');
  assert.equal(diagnostic.error.type, 'ToolInputError');
  assert.match(diagnostic.error.message, /columns must be an object/);
  assert.ok(diagnostic.error.traceback.some(frame => frame.file.endsWith('tools.py') && frame.line > 0));
  assert.deepEqual([diagnostic.documentId, diagnostic.sheet, diagnostic.offset, diagnostic.maxRows], [documentId, 'Payroll', 20, 10]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /DO_NOT_LOG_ARGS/);
});

test('auth, origin and host checks', async () => {
  assert.equal((await fetch(`${url}/files`, { method: 'POST', headers, body: 'x' })).status, 404, 'no upload API: files come from the archive');
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, origin: 'https://x.example' }, body: 'x' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/healthz`, { headers: { host: 'unreviewed.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(status, 403);
});

const eventsIn = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
// The log arrives on a pipe, so a line written before the reply can land after it: wait for the pipe, not the clock.
const waitForEvent = (text, matches) => new Promise((resolve, reject) => {
  const check = () => {
    const found = eventsIn(text()).find(matches);
    if (!found) return false;
    child.stderr.off('data', check);
    resolve(found);
    return true;
  };
  if (!check()) child.stderr.on('data', check);
  child.once('exit', () => reject(new Error('reader exited before the expected log event')));
});

test('every refusal outside the worker pool is logged once as call.refused', async () => {
  const post = (path, extra, body) => fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body });
  const tool = body => JSON.stringify({ jsonrpc: '2.0', id: 'unknown-tool-id', method: 'tools/call', params: { name: 'run_code', arguments: { code: 'DO_NOT_LOG_ARGS' } }, ...body });
  const unauthorized = () => eventsIn(logs).filter(entry => entry.event === 'call.refused' && entry.reason === 'unauthorized').length;
  const before = unauthorized();
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: 'x' })).status, 401);
  assert.equal((await fetch(`${url}/nowhere?access_token=DO_NOT_LOG_QUERY`, { method: 'POST', headers, body: 'x' })).status, 404);
  assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
  assert.equal((await post('/mcp', { origin: 'https://x.example' }, 'x')).status, 403);
  assert.equal((await post('/mcp', {}, 'not json')).status, 400);
  assert.equal((await post('/mcp', {}, tool())).status, 200);
  const framing = await new Promise((resolve, reject) => {
    const req = request(`${url}/mcp`, { method: 'PATCH', headers }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(framing, 501);
  const wanted = [['unauthorized', 401], ['not_found', 404], ['method_not_allowed', 405], ['origin_refused', 403], ['parse_error', 400], ['unknown_tool', 200], ['framing', 501]];
  for (const [reason, status] of wanted) {
    const line = await waitForEvent(() => logs, entry => entry.event === 'call.refused' && entry.reason === reason);
    assert.equal(line.status, status, reason);
    assert.equal(line.pid, child.pid);
    assert.ok(typeof line.method === 'string' && line.path, `${reason} names the method and path`);
  }
  const unknown = eventsIn(logs).find(entry => entry.reason === 'unknown_tool');
  assert.deepEqual([unknown.tool, unknown.rpcId, unknown.method], ['run_code', 'unknown-tool-id', 'tools/call']);
  assert.equal(unauthorized() - before, 1, 'one refusal, one line');
  assert.doesNotMatch(logs, /DO_NOT_LOG_(ARGS|QUERY)/);
});

test('a refusal that echoes cells reaches the model whole and the log as code and rows', async () => {
  const bytes = execFileSync('python3', ['-c',
    `import sys; sys.path.insert(0,sys.argv[1]); import fixtures; sys.stdout.buffer.write(fixtures.build_xlsx({'Payroll':[['STT','Nội dung'],['1','Nguyễn DO_NOT_LOG_CELL']]}))`, dir], { maxBuffer: 1 << 24 });
  const documentId = store(bytes);
  const result = await withClient(client => client.callTool({ name: 'read_table', arguments: { documentId, sheet: 'Payroll', headerRow: 2, columns: { amount: ['Số tiền'] } } }));
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /DO_NOT_LOG_CELL/, 'the model is told which cells the row holds');
  const line = await waitForEvent(() => logs, entry => entry.event === 'call.done' && entry.documentId === documentId && entry.error);
  assert.equal(line.error.code, 'header_not_matched');
  assert.equal(line.error.rows[0], 2);
  assert.doesNotMatch(logs, /DO_NOT_LOG_CELL/);
});

test('MCP over HTTP: discover, list, read_document/read_table/read_cells, refusals', async () => {
  const documentId = store(workbook(30));
  await withClient(async client => {
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['read_cells', 'read_document', 'read_table']);
    const doc = await client.callTool({ name: 'read_document', arguments: { documentId } });
    assert.notEqual(doc.isError, true);
    assert.match(JSON.stringify(doc.structuredContent), /Payroll/);
    const table = await client.callTool({ name: 'read_table', arguments: { documentId, sheet: 'Payroll' } });
    assert.equal(table.structuredContent.totalRows, 30);
    const cells = await client.callTool({ name: 'read_cells', arguments: { documentId, sheet: 'Payroll', range: 'A1:B2' } });
    assert.notEqual(cells.isError, true);
    const missing = await client.callTool({ name: 'read_document', arguments: { documentId: '0'.repeat(32) } });
    assert.equal(missing.isError, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(event =>
      event.event === 'call.done' && event.label === 'read_document' && event.outcome === 'error' && event.pid === child.pid),
    'a handled MCP isError response must be logged as error, even without a Python exception');
    const refused = await client.callTool({ name: 'run_code', arguments: {} }).catch(error => error);
    assert.ok(refused.isError === true || refused instanceof Error);
  });
});

test('liveness answers while every worker is busy parsing; reads are logged', async () => {
  const documentId = store(workbook(60_000));
  const reads = [1, 2, 3].map(() => withClient(client => client.callTool({ name: 'read_document', arguments: { documentId } })));
  await new Promise(resolve => setTimeout(resolve, 150));
  const started = Date.now();
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.ok(Date.now() - started < 1_500, 'healthz must not queue behind reads');
  for (const result of await Promise.all(reads)) assert.notEqual(result.isError, true);
  const durations = [...logs.matchAll(/"event": "call.done".*?"outcome": "ok", "ms": (\d+)/g)].map(match => Number(match[1]));
  assert.ok(durations.length >= 3 && Math.max(...durations) > 400, 'reads must still have been running when healthz answered');
});

test('overload: excess calls get a retryable "busy", readiness sheds, liveness stays up', async () => {
  const smallPort = port + 1, base = `http://127.0.0.1:${smallPort}`;
  const small = await start(smallPort, { DOCUMENT_READERS_WORKERS: '1', DOCUMENT_READERS_MAX_OUTSTANDING: '2' });
  let smallLogs = '';
  small.stderr.on('data', chunk => { smallLogs += chunk; });
  try {
    const documentId = store(workbook(40_000), sources.get(base));
    const one = () => withBase(base, client => client.callTool({ name: 'read_table', arguments: { documentId, sheet: 'Payroll' } }));
    const calls = [1, 2, 3, 4, 5].map(one);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503, 'saturated pod leaves the Service endpoints');
    const results = await Promise.all(calls);
    const busy = results.filter(result => result.isError && /busy/.test(JSON.stringify(result.content)));
    assert.ok(busy.length >= 1 && busy.length < 5, `some calls served, some shed (shed ${busy.length})`);
    const refusals = eventsIn(smallLogs).filter(entry => entry.event === 'call.refused' && entry.reason === 'busy');
    assert.equal(refusals.length, busy.length, 'each shed call is logged once');
    assert.deepEqual([refusals[0].tool, refusals[0].method, refusals[0].sheet], ['read_table', 'tools/call', 'Payroll']);
    assert.equal((await fetch(`${base}/readyz`)).status, 200, 'ready again once drained');
  } finally { small.kill(); }
});

test('reads the archive itself: signed S3 GET by documentId, one fetch per file, 404 is a tool error', async () => {
  const bytes = workbook(20), seen = [];
  const s3 = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization ?? '' });
    if (req.url === '/archive/attachments/' + 'a'.repeat(32)) {
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-amz-meta-filename': encodeURIComponent('Bảng lương.xlsx'), 'content-length': bytes.length }).end(bytes);
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => s3.listen(0, '127.0.0.1', resolve));
  const s3Port = s3.address().port, readerPort = port + 2, base = `http://127.0.0.1:${readerPort}`;
  const reader = await start(readerPort, { DOCUMENT_SOURCE_DIR: '', DOCUMENT_S3_ENV_PREFIX: 'ARCHIVE_S3', DOCUMENT_S3_PREFIX: 'attachments/',
    ARCHIVE_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, ARCHIVE_S3_BUCKET: 'archive', ARCHIVE_S3_ACCESS_KEY: 'access', ARCHIVE_S3_SECRET_KEY: 'secret' });
  try {
    await withBase(base, async client => {
      const id = 'a'.repeat(32);
      for (let i = 0; i < 2; i++) assert.notEqual((await client.callTool({ name: 'read_table', arguments: { documentId: id } })).isError, true);
      assert.equal(seen.filter(call => call.path.endsWith(id)).length, 1, 'cached after the first fetch');
      assert.match(seen[0].authorization, /^AWS4-HMAC-SHA256 Credential=access\//);
      const missing = await client.callTool({ name: 'read_table', arguments: { documentId: 'b'.repeat(32) } });
      assert.equal(missing.isError, true);
    });
  } finally { reader.kill(); s3.close(); }
});

test('any pod can serve a resource URI another pod minted (no session affinity needed)', async () => {
  const otherPort = port + 3, other = `http://127.0.0.1:${otherPort}`;
  // A second, independent reader process on the same archive (here: the same folder) and token.
  const second = await start(otherPort, { DOCUMENT_SOURCE_DIR: sources.get(url) });
  try {
    const documentId = store(workbook(5), sources.get(url));
    const uri = (await withClient(client => client.callTool({ name: 'read_table', arguments: { documentId } }))).structuredContent.resourceUri;
    const read = await withBase(other, client => client.readResource({ uri }));
    assert.equal(JSON.parse(read.contents[0].text).documentId, documentId);
  } finally { second.kill(); }
});

test('SIGTERM drains and exits 0', async () => {
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(logs, /"event": "shutdown.begin"/);
  const stopping = logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === 'shutdown.begin');
  assert.equal(stopping.length, 1);
  assert.equal(stopping[0].signal, 'SIGTERM');
  assert.equal(stopping[0].pid, child.pid);
});
