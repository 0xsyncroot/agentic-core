import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { documentAttachmentSettings, createDocumentAttachmentStore, createBlankRuntime } from '@0xsyncroot/harness';
import { CONTEXTUAL_TOOL_SOURCE_CAPABILITY } from '@0xsyncroot/plugin-sdk';

const url = process.env.EXECUTION_TEST_URL;
const tokenPath = process.env.EXECUTION_TEST_TOKEN_FILE;
if (!url || !tokenPath) throw new Error('Set EXECUTION_TEST_URL and EXECUTION_TEST_TOKEN_FILE to audit a running image');
const raw = readFileSync(tokenPath, 'utf8').trim();
const token = raw.match(/^EXECUTION_SERVICE_TOKEN=(.+)$/m)?.[1] ?? raw;
const headers = { authorization: `Bearer ${token}` };
const archiveEnv = process.env.EXECUTION_TEST_S3_ENV_FILE
  ? parseEnv(readFileSync(process.env.EXECUTION_TEST_S3_ENV_FILE, 'utf8')) : undefined;
const fixtures = fileURLToPath(new URL('../../document-readers', import.meta.url));
const fixture = (kind) => execFileSync('python3', ['-c',
  `import sys; sys.path.insert(0,sys.argv[1]); import fixtures; sys.stdout.buffer.write(${kind === 'png' ? 'fixtures.build_png()' : kind === 'docx' ? "fixtures.build_docx(['Real Word content'],[[['Name','Amount'],['Hoa','42']]])" : "fixtures.build_xlsx({'Payroll':[['Employee','Amount'],['Hoa',42]]})"})`, fixtures]);

async function upload(bytes, name, mediaType = 'application/octet-stream') {
  const response = await fetch(`${url}/files`, { method: 'POST', headers: { ...headers,
    'content-type': mediaType, 'x-file-name': encodeURIComponent(name) }, body: bytes });
  assert.equal(response.status, 201);
  const meta = await response.json();
  assert.match(meta.documentId, /^[0-9a-f]{32}$/);
  assert.equal(meta.sizeBytes, bytes.length);
  assert.ok(meta.expiresAt > Date.now());
  return meta;
}
async function download(id) {
  const response = await fetch(`${url}/files/${id}`, { headers });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
async function withClient(run) {
  const client = new Client({ name: 'execution-image-audit', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: { token: async () => token } }));
  try { await run(client); } finally { await client.close(); }
}
test('internal API authenticates files/MCP, rejects browser origins and unreviewed hosts', async () => {
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/files`, { method: 'POST', body: 'x' })).status, 401);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
  assert.equal((await fetch(`${url}/files`, { method: 'POST', headers: { ...headers, origin: 'https://browser.example' }, body: 'x' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/healthz`, { headers: { host: 'unreviewed.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('binary upload/download is exact; empty and oversized files are refused', async () => {
  const bytes = Buffer.from('name,amount\nHoàng Thị Hoa,42\n');
  const meta = await upload(bytes, 'Bảng lương.csv', 'text/csv');
  assert.equal(meta.name, 'Bảng lương.csv');
  assert.deepEqual(await download(meta.documentId), bytes);
  assert.equal((await fetch(`${url}/files`, { method: 'POST', headers, body: '' })).status, 400);
  assert.equal((await fetch(`${url}/files`, { method: 'POST', headers, body: Buffer.alloc(25 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(`${url}/files/${'0'.repeat(32)}`, { headers })).status, 404);
  assert.equal((await fetch(`${url}/files/${meta.documentId}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(`${url}/files/${meta.documentId}`, { headers })).status, 404);
});

test('S3 preserves history handles; the actual runtime restores an evicted MCP cache after backend reopen',
  { skip: !archiveEnv }, async () => {
  const env = { ...archiveEnv, EXECUTION_SERVICE_TOKEN: token, AGENTIC_LLM_PROVIDER: 'echo', AGENTIC_RUNTIME_PROFILE: 'development',
    AGENTIC_KNOWLEDGE_ROOTS: '', AGENTIC_SKILL_ROOTS: '', AGENTIC_ENABLE_DIAGNOSTIC_TOOLS: 'false',
    AGENTIC_MCP_SERVERS: JSON.stringify([{ id: 'office-docs', transport: 'http', endpoint: `${url}/mcp`, filesEndpoint: `${url}/files`,
      attachmentStorage: { s3EnvPrefix: 'AUDIT_S3', keyPrefix: `archive-audit/${randomUUID()}/` }, allowInsecureInternal: true,
      authMode: 'service', tokenEnv: 'EXECUTION_SERVICE_TOKEN', failureMode: 'fail', riskOverrides: { read_document: 'none', read_table: 'none', read_cells: 'none' } }]) };
  const security = { tenantId: 'audit-tenant', actorId: 'audit-user', permissions: new Set(['mcp.office-docs.invoke']), correlationId: 'audit', purpose: 'audit' };
  const signal = AbortSignal.timeout(60_000);
  let runtime, settings, documentId;
  const bytes = fixture('xlsx');
  async function read(active, name, principal = security) {
    const source = active.host.capabilities.all(CONTEXTUAL_TOOL_SOURCE_CAPABILITY)[0];
    const catalog = await source.discover({ security: principal, runtime: active.host.snapshot, sessionId: 'reopened-history', turnId: 'read', agentProfileId: 'default' }, signal);
    const tool = catalog.tools.find(t => t.id === `mcp_office-docs_${name}`);
    return tool.execute({ arguments: { documentId }, security: principal, sessionId: 'reopened-history', turnId: 'read', stepId: 'step', callId: randomUUID(), idempotencyKey: randomUUID() }, signal);
  }
  try {
    runtime = await createBlankRuntime(env);
    settings = documentAttachmentSettings(env, 'production', runtime.config.mcpServers);
    const store = createDocumentAttachmentStore(settings, 'archive-test-only-stable-attachment-key');
    documentId = await store.store({ bytes, name: 'Bảng lương.xlsx', mediaType: 'application/octet-stream' }, security);
    assert.deepEqual(await settings.store.get(settings.prefix + documentId), bytes);
    assert.equal((await fetch(`${url}/files/${documentId}`, { method: 'HEAD', headers })).status, 404);
    const [a, b] = await Promise.all([read(runtime, 'read_table'), read(runtime, 'read_document')]);
    assert.match(JSON.stringify(a), /Hoa/); assert.match(JSON.stringify(b), /42/);
    assert.deepEqual(await download(documentId), bytes);
    await assert.rejects(read(runtime, 'read_document', { ...security, tenantId: 'another-tenant' }), { code: 'denied' });
    assert.equal((await fetch(`${url}/files/${documentId}`, { method: 'DELETE', headers })).status, 204);
    await runtime.close(); runtime = await createBlankRuntime(env);
    const restored = await read(runtime, 'read_table');
    assert.match(JSON.stringify(restored), /Hoa/);
    assert.deepEqual(await download(documentId), bytes);
    const again = createDocumentAttachmentStore(settings, 'archive-test-only-stable-attachment-key');
    assert.equal(await again.store({ bytes, name: 'another-name.xlsx', mediaType: 'application/octet-stream' }, security), documentId);
  } finally {
    await runtime?.close();
    if (settings?.store && documentId) {
      const { S3ObjectStore, s3Config } = await import('@0xsyncroot/adapter-s3');
      await new S3ObjectStore(s3Config(env, 'AUDIT_S3')).remove(settings.prefix + documentId);
    }
  }
});

test('stable cache handles accept identical restores and refuse replacing a different file', async () => {
  const id = randomUUID().replaceAll('-', '');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${url}/files/${id}`, { method: 'PUT', headers, body: 'original bytes' });
    assert.equal(response.status, 201); assert.equal((await response.json()).documentId, id);
  }
  assert.equal((await fetch(`${url}/files/${id}`, { method: 'PUT', headers, body: 'different bytes' })).status, 409);
  assert.deepEqual(await download(id), Buffer.from('original bytes'));
  assert.equal((await fetch(`${url}/files/${id}`, { method: 'DELETE', headers })).status, 204);
});

test('existing MCP client discovers actual readers; Excel, Word and original image all work without S3', async () => withClient(async client => {
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['read_cells', 'read_document', 'read_table']);
  const xlsx = await upload(fixture('xlsx'), 'payroll.xlsx');
  const table = await client.callTool({ name: 'read_table', arguments: { documentId: xlsx.documentId } });
  assert.ok(!table.isError);
  assert.match(JSON.stringify(table.structuredContent), /Hoa/);
  assert.match(JSON.stringify(table.structuredContent), /42/);
  const grant = table.structuredContent.resourceUri;
  assert.equal((await client.readResource({ uri: grant })).contents.length, 1);
  assert.deepEqual((await client.listResources()).resources, []);
  const docx = await upload(fixture('docx'), 'memo.docx');
  const word = await client.callTool({ name: 'read_document', arguments: { documentId: docx.documentId } });
  assert.match(JSON.stringify(word.structuredContent), /Real Word content/);
  const png = fixture('png');
  const image = await upload(png, 'image.png', 'image/png');
  const result = await client.callTool({ name: 'read_document', arguments: { documentId: image.documentId } });
  assert.deepEqual(Buffer.from(result.content.find(block => block.type === 'image').data, 'base64'), png);
}));

test('code execution is neither discoverable nor callable, including guessed tool names', async () => withClient(async client => {
  for (const name of ['run_code', 'execute', 'eval', 'shell']) {
    const result = await client.callTool({ name, arguments: { runtime: 'python',
      code: "open('/tmp/execution-must-not-run', 'w').write('forbidden')" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Code execution is unavailable/);
  }
}));

test('oversized Office ZIPs, XML entities and sparse sheet expansion fail without killing the service', async () => withClient(async client => {
  const malicious = (kind) => execFileSync('python3', ['-c', `import io, sys, zipfile
sys.path.insert(0,sys.argv[1]); import fixtures
b=io.BytesIO()
if sys.argv[2]=='zip':
 with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('word/document.xml',b'x'*(17*1024*1024))
elif sys.argv[2]=='entity':
 with zipfile.ZipFile(b,'w') as z: z.writestr('word/document.xml',b'<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>')
else:
 original=zipfile.ZipFile(io.BytesIO(fixtures.build_xlsx({'Bad':[['Name'],['42']]})))
 with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
  for n in original.namelist():
   content=original.read(n)
   if n=='xl/worksheets/sheet1.xml': content=b'<worksheet><sheetData>'+b'<row><c r="XFD1"><v>42</v></c></row>'*62+b'</sheetData></worksheet>'
   z.writestr(n,content)
sys.stdout.buffer.write(b.getvalue())`, fixtures, kind]);
  for (const kind of ['zip','entity','sparse']) {
    const file = await upload(malicious(kind), `bad.${kind==='sparse'?'xlsx':'docx'}`);
    const result = await client.callTool({ name:'read_document', arguments:{documentId:file.documentId} });
    assert.equal(result.isError,true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /size|declarations|limit/);
  }
  const good=await upload(fixture('xlsx'),'after.xlsx');
  const result=await client.callTool({name:'read_table',arguments:{documentId:good.documentId}});
  assert.ok(!result.isError);
  assert.match(JSON.stringify(result.structuredContent),/42/);
}));
