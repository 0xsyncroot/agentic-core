import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRedisUrl, isRedisUrl, parseRedisUrl } from "../src/index.js";

test("single node keeps its behaviour", () => {
  const plain = parseRedisUrl("redis://redis.internal:6380/2");
  assert.equal(plain.mode, "standalone");
  assert.equal(plain.tls, false);
  assert.equal(plain.url, "redis://redis.internal:6380/2");
  const secure = parseRedisUrl("rediss://user:p%40ss@redis.internal");
  assert.equal(secure.tls, true);
  assert.deepEqual(secure.nodes, [{ host: "redis.internal", port: 6379 }]);
});

test("cluster URL lists the root nodes and shares credentials", () => {
  const target = parseRedisUrl("redis+cluster://app:s%3Acret@r1:7000,r2,[::1]:7002");
  assert.equal(target.mode, "cluster");
  assert.equal(target.tls, false);
  assert.deepEqual(target.nodes, [{ host: "r1", port: 7000 }, { host: "r2", port: 6379 }, { host: "::1", port: 7002 }]);
  assert.equal(target.username, "app");
  assert.equal(target.password, "s:cret");
  assert.equal(parseRedisUrl("rediss+cluster://r1:6379,r2:6379/").tls, true);
});

test("password-only credentials keep the default user", () => {
  const target = parseRedisUrl("redis+cluster://:secret@r1:6379");
  assert.equal(target.username, undefined);
  assert.equal(target.password, "secret");
});

test("sentinel URL carries master name, database and sentinel credentials", () => {
  const target = parseRedisUrl("rediss+sentinel://data:pw@s1:26379,s2/my%20master?db=3&sentinelPassword=sp");
  assert.equal(target.mode, "sentinel");
  assert.equal(target.tls, true);
  assert.equal(target.masterName, "my master");
  assert.equal(target.database, 3);
  assert.deepEqual(target.nodes, [{ host: "s1", port: 26379 }, { host: "s2", port: 26379 }]);
  assert.equal(target.username, "data");
  assert.equal(target.password, "pw");
  assert.equal(target.sentinelUsername, undefined);
  assert.equal(target.sentinelPassword, "sp");
});

test("malformed input names the expected forms", () => {
  const bad = [
    "http://x:6379", "redis://", "redis+cluster://", "redis+cluster://h1:99999", "redis+cluster://h1:6379/0",
    "redis+sentinel://s1:26379", "redis+sentinel://s1:26379/", "redis+sentinel://s1/m?db=x", "redis+sentinel://s1/m?foo=1",
    "redis+cluster://h 1:6379", "redis+cluster://h1:6379#frag", "not a url",
  ];
  for (const value of bad) {
    assert.throws(() => parseRedisUrl(value), /Redis URL is invalid: .*Expected redis:\/\/host:6379, redis\+cluster:\/\/.*redis\+sentinel:\/\//u, value);
  }
});

test("scheme detection and the TLS rule", () => {
  assert.equal(isRedisUrl("redis+sentinel://s/m"), true);
  assert.equal(isRedisUrl("mysql://x"), false);
  for (const url of ["redis://r", "redis+cluster://r:1", "redis+sentinel://s/m"]) {
    assert.throws(() => checkRedisUrl(url, { purpose: "Test", allowInsecureInternal: false }), /^Error: Test Redis requires rediss:\/\/ unless allowInsecureInternal/u);
    assert.equal(checkRedisUrl(url, { purpose: "Test", allowInsecureInternal: true }).tls, false);
  }
  assert.equal(checkRedisUrl("rediss+cluster://r:1", { purpose: "Test", allowInsecureInternal: false }).mode, "cluster");
  assert.throws(() => checkRedisUrl("nope", { purpose: "Test", allowInsecureInternal: true }), /^Error: Test Redis URL is invalid/u);
});
