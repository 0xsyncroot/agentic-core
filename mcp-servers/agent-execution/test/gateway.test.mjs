// Starts the real gateway + broker locally (no Docker, no S3). Proves liveness and shutdown behaviour
// that the image audit in integration.mjs does not cover.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const token = 'g'.repeat(40);
const port = 18000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}` };
const readers = fileURLToPath(new URL('../../document-readers', import.meta.url));
const local = fileURLToPath(new URL('../http/local.mjs', import.meta.url));
let child, logs = '';

const workbook = rows => execFileSync('python3', ['-c',
  `import sys; sys.path.insert(0,sys.argv[1]); import fixtures; sys.stdout.buffer.write(fixtures.build_xlsx({'S':[['Name','Amount']]+[['n%d'%i,i] for i in range(${rows})]}))`, readers], { maxBuffer: 1 << 28 });
const upload = async bytes => (await (await fetch(`${url}/files`, { method: 'POST', headers: { ...headers,
  'content-type': 'application/octet-stream', 'x-file-name': 'w.xlsx' }, body: bytes })).json()).documentId;
const withClient = async run => {
  const client = new Client({ name: 'gateway-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: { token: async () => token } }));
  try { return await run(client); } finally { await client.close(); }
};

before(async () => {
  child = spawn(process.execPath, [local], { env: { ...process.env, EXECUTION_SERVICE_TOKEN: token, EXECUTION_LOCAL_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`gateway did not start: ${logs}`);
});
after(() => child?.kill());

test('liveness answers while every broker worker is busy parsing', async () => {
  const id = await upload(workbook(60_000));
  const reads = [1, 2, 3].map(() => withClient(client => client.callTool({ name: 'read_document', arguments: { documentId: id } })));
  await new Promise(resolve => setTimeout(resolve, 150));
  const started = Date.now();
  const health = await fetch(`${url}/healthz`);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - started < 1_500, 'healthz must not queue behind reads');
  for (const result of await Promise.all(reads)) assert.notEqual(result.isError, true);
  const durations = [...logs.matchAll(/"event":"call.done".*"outcome":"ok","ms":(\d+)/g)].map(match => Number(match[1]));
  assert.equal(durations.length, 3);
  assert.ok(Math.max(...durations) > 400, 'reads must still have been running when healthz answered');
});

test('SIGTERM drains and exits 0', async () => {
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(logs, /"event":"shutdown.begin"/);
});
