import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { S3ObjectStore, normalizeKeyPrefix, s3Config } from "../src/index.js";

const config = s3Config(process.env, "TEST_S3");
if (!config) throw new Error("Set TEST_S3_ENDPOINT, TEST_S3_BUCKET, TEST_S3_ACCESS_KEY and TEST_S3_SECRET_KEY for an isolated S3 test service");
const store = new S3ObjectStore(config);
const prefix = `integration/${randomUUID()}/`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

before(async () => { await store.ensureBucket(); await store.ensureBucket(); });
after(async () => {
  const objects = await store.list(prefix);
  for (let offset = 0; offset < objects.length; offset += 25) {
    await Promise.all(objects.slice(offset, offset + 25).map(object => store.remove(object.key)));
  }
});

test("live S3 preserves binary bytes, Unicode keys, content type and attachment identity metadata", async () => {
  const key = `${prefix}documents/€-report.bin`;
  const body = Buffer.from([0, 255, 128, 13, 10, 1]);
  const metadata = { "X-Amz-Meta-Filename": encodeURIComponent("€ report.bin"), tenant: "tenant-a" };
  await store.put(key, body, { contentType: "application/octet-stream", metadata });
  assert.deepEqual(await store.get(key, body.length), body);
  assert.deepEqual(await store.stat(key), { size: body.length, contentType: "application/octet-stream", metadata: { filename: metadata["X-Amz-Meta-Filename"], tenant: "tenant-a" } });
});

test("live S3 supports unknown-length multipart streams without changing their contents", async () => {
  const body = Buffer.alloc(7 * 1024 * 1024 + 19);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const key = `${prefix}stream.bin`;
  const stream = Readable.from((async function* () {
    for (let offset = 0; offset < body.length; offset += 65537) yield body.subarray(offset, offset + 65537);
  })());
  await store.put(key, stream, { contentType: "application/octet-stream", metadata: { source: "stream" } });
  assert.equal(digest(await store.get(key)), digest(body));
  assert.equal((await store.stat(key))?.metadata.source, "stream");
});

test("live S3 traverses more than one page and keeps prefixes isolated", async () => {
  const pagePrefix = `${prefix}pages/`;
  const keys = Array.from({ length: 1003 }, (_, i) => `${pagePrefix}${String(i).padStart(4, "0")}`);
  for (let offset = 0; offset < keys.length; offset += 25) {
    await Promise.all(keys.slice(offset, offset + 25).map(key => store.put(key, Buffer.from("x"))));
  }
  await store.put(`${prefix}pages-sibling`, Buffer.from("not a child"));
  const found = await store.list(normalizeKeyPrefix(pagePrefix));
  assert.deepEqual(found.map(item => item.key), keys);
  assert.ok(found.every(item => item.size === 1 && item.etag && !item.etag.includes('"')));
});

test("live S3 enforces read bounds and remains usable after a rejected read", async () => {
  const key = `${prefix}bounded`;
  await store.put(key, Buffer.from("12345"));
  await assert.rejects(store.get(key, 4), /exceeds 4 bytes/u);
  assert.equal(await store.getText(key, 5), "12345");
});

test("live S3 distinguishes missing objects, denied credentials and missing buckets", async () => {
  assert.equal(await store.stat(`${prefix}missing`), undefined);
  await store.remove(`${prefix}missing`);
  const denied = new S3ObjectStore({ ...config!, secretKey: "deliberately-invalid-test-credential" });
  await assert.rejects(denied.stat(`${prefix}missing`));
  const missingBucket = new S3ObjectStore({ ...config!, bucket: `absent-${randomUUID()}` });
  await assert.rejects(missingBucket.put("key", Buffer.from("x")), error => (error as { name?: string }).name === "NoSuchBucket");
});

test("live S3 removes an existing object idempotently", async () => {
  const key = `${prefix}delete-me`;
  await store.put(key, Buffer.from("temporary"));
  await store.remove(key);
  await store.remove(key);
  assert.equal(await store.stat(key), undefined);
});
