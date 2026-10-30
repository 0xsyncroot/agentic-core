#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
let tag = 'agent-execution-base:node22-python311-v1';
let platform;
let force = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === '--help') {
    console.log('node scripts/build-execution-base.mjs [--tag registry/team/image:version] [--platform linux/amd64] [--force]');
    process.exit(0);
  }
  if (option === '--force') { force = true; continue; }
  if (option !== '--tag' && option !== '--platform') throw new Error(`Unknown option: ${option}`);
  const value = args[++index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
  if (option === '--tag') tag = value;
  else platform = value;
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/.test(tag)) throw new Error('Invalid image tag');
if (platform && !/^linux\/(amd64|arm64)$/.test(platform)) throw new Error('Supported platforms: linux/amd64 or linux/arm64');
const directory = resolve(root, 'artifacts/docker-images');
await mkdir(directory, { recursive: true });
const archive = resolve(directory, `${tag.replaceAll('/', '_').replaceAll(':', '_')}.tar.gz`);
const exists = await access(archive).then(() => true, () => false);
if (exists && !force) throw new Error(`Archive already exists: ${archive}. Use a new tag or --force.`);
function finished(child) {
  return new Promise((success, failure) => {
    child.once('error', failure);
    child.once('close', (code, signal) => code === 0 ? success() : failure(new Error(`docker exited ${code ?? signal}`)));
  });
}
console.log(`Building ${tag}`);
const build = spawn('docker', ['build', '-f', 'mcp-servers/agent-execution/Dockerfile.base', '-t', tag,
  ...(platform ? ['--platform', platform] : []), '.'], { cwd: root, stdio: 'inherit' });
await finished(build);
const temporary = `${archive}.${randomBytes(4).toString('hex')}.partial`;
const save = spawn('docker', ['save', tag], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await Promise.all([finished(save), pipeline(save.stdout, createGzip(), createWriteStream(temporary, { flags: 'wx' }))]);
  await rename(temporary, archive);
} catch (error) {
  save.kill('SIGTERM');
  await rm(temporary, { force: true });
  throw error;
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
await writeFile(`${archive}.sha256`, `${hash.digest('hex')}  ${basename(archive)}\n`);
console.log(`Saved ${archive}\nChecksum: ${archive}.sha256\nLoad: docker load --input ${archive}`);
