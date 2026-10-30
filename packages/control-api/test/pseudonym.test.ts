import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ActorPseudonyms, pseudonymOf } from "../src/pseudonym.js";

const KEY = "k".repeat(32);

test("actor key is the HMAC-SHA256 of tenant, NUL and actor under the configured key, as 64 hex", () => {
  const keys = new ActorPseudonyms(KEY, "v1");
  const expected = createHmac("sha256", Buffer.from(KEY, "utf8")).update("tenant-a\u0000actor-1", "utf8").digest("hex");
  assert.equal(keys.actorKey("tenant-a", "actor-1"), expected);
  assert.match(keys.actorKey("tenant-a", "actor-1"), /^[0-9a-f]{64}$/u);
  assert.equal(keys.version, "v1");
});

test("the same actor in two tenants gets unrelated keys, and the separator keeps tenant and actor apart", () => {
  const keys = new ActorPseudonyms(KEY, "v1");
  assert.notEqual(keys.actorKey("tenant-a", "actor-1"), keys.actorKey("tenant-b", "actor-1"));
  assert.notEqual(keys.actorKey("ab", "c"), keys.actorKey("a", "bc"));
});

test("a different key gives a different actor key", () => {
  assert.notEqual(new ActorPseudonyms(KEY, "v1").actorKey("t", "a"), new ActorPseudonyms("x".repeat(32), "v2").actorKey("t", "a"));
});

test("the displayed pseudonym is the last 6 hex characters of the actor key", () => {
  const key = new ActorPseudonyms(KEY, "v1").actorKey("tenant-a", "actor-1");
  assert.equal(pseudonymOf(key), key.slice(-6));
  assert.throws(() => pseudonymOf("not-hex"), /actor key/u);
});

test("a short key, an empty version or a NUL inside an id is refused", () => {
  assert.throws(() => new ActorPseudonyms("short", "v1"), /32 bytes/u);
  assert.throws(() => new ActorPseudonyms(KEY, ""), /version/u);
  assert.throws(() => new ActorPseudonyms(KEY, "v1").actorKey("a\u0000b", "c"), /NUL/u);
  assert.throws(() => new ActorPseudonyms(KEY, "v1").actorKey("a", ""), /empty/u);
});

test("the key fingerprint names the key without holding it: equal for one key, different across keys, apart from the version", () => {
  const fingerprint = new ActorPseudonyms(KEY, "v1").keyFingerprint;
  assert.match(fingerprint, /^[0-9a-f]{16}$/u);
  assert.equal(new ActorPseudonyms(KEY, "v2").keyFingerprint, fingerprint);
  assert.notEqual(new ActorPseudonyms("x".repeat(32), "v1").keyFingerprint, fingerprint);
  assert.equal(fingerprint.includes(Buffer.from(KEY).toString("hex").slice(0, 8)), false);
});
