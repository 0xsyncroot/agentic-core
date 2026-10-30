import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 25 * 1024 * 1024;
const TTL_MS = 15 * 60_000;
const validHandle = value => /^[0-9a-f]{32}$/.test(value);
export class FileApi {
  #uploads = 0;
  #restoring = new Set();
  constructor(directory) { this.directory = directory; }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async prune() {
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
      if (this.#restoring.has(name.slice(0, -5))) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        if (meta.expiresAt <= Date.now()) await this.remove(name.slice(0, -5));
      } catch { /* A concurrent delete is harmless; incomplete files have no public handle. */ }
    }
  }
  async remove(id) {
    await Promise.all([id, `${id}.json`].map(name => unlink(join(this.directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
  async handle(req, res) {
    const match = /^\/files\/([0-9a-f]{32})$/.exec(req.url);
    const restoreId = req.method === 'PUT' ? match?.[1] : undefined;
    if ((req.url === '/files' && req.method === 'POST') || restoreId) {
      if (this.#uploads >= 2) { res.writeHead(429).end('File transfer is busy'); return true; }
      if (restoreId && this.#restoring.has(restoreId)) { res.writeHead(429).end('File restore is busy'); return true; }
      if (restoreId) this.#restoring.add(restoreId);
      this.#uploads++;
      const id = restoreId ?? randomBytes(16).toString('hex');
      const temporary = join(this.directory, `.${randomBytes(16).toString('hex')}.upload`);
      const metadataTemporary = `${temporary}.json`;
      try {
        const entries = await readdir(this.directory);
        if (entries.length >= 512 && (!restoreId || !entries.includes(`${restoreId}.json`))) {
          res.writeHead(507).end('Execution file storage is full'); return true;
        }
        let name;
        try { name = decodeURIComponent(req.headers['x-file-name'] ?? 'input.bin'); }
        catch { res.writeHead(400).end('Invalid filename encoding'); return true; }
        if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) {
          res.writeHead(400).end('Invalid filename'); return true;
        }
        const mediaType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0];
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)) {
          res.writeHead(400).end('Invalid media type'); return true;
        }
        if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) { res.writeHead(413).end(); return true; }
        let sizeBytes = 0;
        const hash = createHash('sha256');
        const file = await open(temporary, 'wx', 0o600);
        try {
          for await (const chunk of req) {
            sizeBytes += chunk.length;
            hash.update(chunk);
            if (sizeBytes > MAX_BYTES) { res.writeHead(413).end('File exceeds 25 MiB'); return true; }
            await file.writeFile(chunk);
          }
        } finally { await file.close(); }
        if (!sizeBytes) { res.writeHead(400).end('Empty file'); return true; }
        const sha256 = hash.digest('hex');
        let previous;
        try { previous = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous && previous.sha256 !== sha256) { res.writeHead(409).end('A document handle cannot replace different file content'); return true; }
        const meta = { documentId: id, name, mediaType, sizeBytes, sha256, expiresAt: Date.now() + TTL_MS };
        const sidecar = await open(metadataTemporary, 'wx', 0o600);
        try { await sidecar.writeFile(JSON.stringify(meta)); } finally { await sidecar.close(); }
        await rename(temporary, join(this.directory, id));
        await rename(metadataTemporary, join(this.directory, `${id}.json`));
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(meta));
      } catch {
        if (!res.headersSent) res.writeHead(507).end('Execution file storage is full or unavailable');
      } finally {
        await Promise.all([temporary, metadataTemporary].map(path => unlink(path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        })));
        if (restoreId) this.#restoring.delete(restoreId);
        this.#uploads--;
      }
      return true;
    }
    if (!match || !validHandle(match[1])) return false;
    const id = match[1];
    if (req.method === 'DELETE') {
      if (this.#restoring.has(id)) { res.writeHead(409).end('File restore is in progress'); return true; }
      await this.remove(id); res.writeHead(204).end(); return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return true; }
    let meta;
    try { meta = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')); }
    catch { res.writeHead(404).end('Unknown file handle'); return true; }
    if (meta.expiresAt <= Date.now()) { await this.remove(id); res.writeHead(410).end('File handle expired'); return true; }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': meta.sizeBytes,
      'X-Content-Type-Options': 'nosniff',
      'X-File-Expires-At': String(meta.expiresAt),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    });
    if (req.method === 'HEAD') res.end();
    else await pipeline(createReadStream(join(this.directory, id)), res);
    return true;
  }
}
