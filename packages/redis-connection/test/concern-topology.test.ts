import assert from "node:assert/strict";
import { test } from "node:test";
import { redisConcernSettings, redisEndpoint, requiredRedisEndpoint, type RedisConcern } from "../src/index.js";

const stream: RedisConcern = { id: "stream", defaultKeyPrefix: "acme:stream:v1", legacyPrefix: "ACME" };
const admission: RedisConcern = { id: "admission", defaultKeyPrefix: "acme:admission:v1", legacyPrefix: "ACME" };

function recorder(): { readonly log: (message: string) => void; readonly lines: string[] } {
  const lines: string[] = [];
  return { log: (message) => { lines.push(message); }, lines };
}

test("one shared REDIS_URL serves every concern, each under its own key prefix", () => {
  const env = { REDIS_URL: "rediss://redis-1:6379/0" };
  assert.deepEqual(redisEndpoint(env, stream), { url: "rediss://redis-1:6379/0", keyPrefix: "acme:stream:v1", allowInsecureInternal: false });
  assert.equal(redisEndpoint(env, admission)?.keyPrefix, "acme:admission:v1");
  assert.equal(redisEndpoint({}, stream), undefined, "no Redis configured is not an error here");
});

test("a concern's own URL and prefix win over the shared ones", () => {
  const env = { REDIS_URL: "rediss://redis-1:6379/0", ADMISSION_REDIS_URL: "rediss://redis-2:6379/3", ADMISSION_REDIS_KEY_PREFIX: "q:v2" };
  assert.equal(redisEndpoint(env, stream)?.url, "rediss://redis-1:6379/0");
  assert.deepEqual(redisEndpoint(env, admission), { url: "rediss://redis-2:6379/3", keyPrefix: "q:v2", allowInsecureInternal: false });
  assert.throws(() => redisEndpoint({ ...env, STREAM_REDIS_KEY_PREFIX: "bad prefix" }, stream), /STREAM_REDIS_KEY_PREFIX is invalid/u);
  assert.deepEqual(redisConcernSettings(admission), { url: "ADMISSION_REDIS_URL", keyPrefix: "ADMISSION_REDIS_KEY_PREFIX" });
});

test("the product-prefixed names still work, with one warning per retired name", () => {
  const { log, lines } = recorder();
  const env = {
    ACME_REDIS_URL: "redis://127.0.0.1:56379/0", ACME_REDIS_ALLOW_INSECURE_INTERNAL: "true",
    ACME_ADMISSION_REDIS_URL: "redis://127.0.0.1:56379/1", ACME_ADMISSION_REDIS_KEY_PREFIX: "old:admission",
  };
  for (let read = 0; read < 2; read += 1) {
    assert.deepEqual(redisEndpoint(env, stream, { log }), { url: "redis://127.0.0.1:56379/0", keyPrefix: "acme:stream:v1", allowInsecureInternal: true });
    assert.deepEqual(redisEndpoint(env, admission, { log }), { url: "redis://127.0.0.1:56379/1", keyPrefix: "old:admission", allowInsecureInternal: true });
  }
  assert.deepEqual(lines.map((line) => /\] (\S+) is a retired/u.exec(line)?.[1]).sort(), [
    "ACME_ADMISSION_REDIS_KEY_PREFIX", "ACME_ADMISSION_REDIS_URL", "ACME_REDIS_ALLOW_INSECURE_INTERNAL", "ACME_REDIS_URL",
  ]);
  assert.ok(lines.every((line) => !line.includes("127.0.0.1")), "warnings name settings, never values");
});

test("a new name and its retired name with different values refuse to start", () => {
  assert.throws(() => redisEndpoint({ REDIS_URL: "rediss://a:6379", ACME_REDIS_URL: "rediss://b:6379" }, stream),
    /REDIS_URL and its retired name ACME_REDIS_URL are both set, to different values/u);
  assert.equal(redisEndpoint({ REDIS_URL: "rediss://a:6379", ACME_REDIS_URL: "rediss://a:6379" }, stream)?.url, "rediss://a:6379");
});

test("one plaintext switch; the retired per-concern switch still overrides the retired shared one", () => {
  const plain = { REDIS_URL: "redis://redis.internal:6379/0" };
  assert.equal(redisEndpoint({ ...plain, REDIS_ALLOW_INSECURE_INTERNAL: "true" }, stream)?.allowInsecureInternal, true);
  const retired = { ...plain, ACME_REDIS_ALLOW_INSECURE_INTERNAL: "false", ACME_STREAM_REDIS_ALLOW_INSECURE_INTERNAL: "true" };
  assert.equal(redisEndpoint(retired, stream, { log: () => undefined })?.allowInsecureInternal, true);
  assert.equal(redisEndpoint(retired, admission, { log: () => undefined })?.allowInsecureInternal, false);
  assert.throws(() => redisEndpoint({ ...plain, REDIS_ALLOW_INSECURE_INTERNAL: "yes" }, stream), /REDIS_ALLOW_INSECURE_INTERNAL must be true or false/u);
});

test("a required concern names both settings an operator can set", () => {
  assert.throws(() => requiredRedisEndpoint({}, stream, "Acme"), /^Error: Acme requires Redis for stream: set STREAM_REDIS_URL or REDIS_URL$/u);
  assert.equal(requiredRedisEndpoint({ STREAM_REDIS_URL: "rediss://s:6379" }, stream, "Acme").url, "rediss://s:6379");
});
