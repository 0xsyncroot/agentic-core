import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmEnvelopeProtector, DerivedTenantKeyProvider } from "../src/index.js";

const root = Buffer.alloc(32, 7);
const context = { tenantId: "tenant-a", recordId: "event-1", purpose: "session-event", classification: "confidential" as const };

test("AES-GCM envelope binds ciphertext to tenant and record context", async () => {
  const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(root, "local-v1"));
  const envelope = await protector.protect({ secret: "value" }, context);
  assert.equal(envelope.ciphertext.includes("value"), false);
  assert.deepEqual(await protector.unprotect(envelope, context), { secret: "value" });
  await assert.rejects(protector.unprotect(envelope, { ...context, tenantId: "tenant-b" }), /authentication failed/);
  await assert.rejects(protector.unprotect(envelope, { ...context, recordId: "event-2" }), /authentication failed/);
});

test("blind index is deterministic within a tenant and isolated across tenants", async () => {
  const protector = new AesGcmEnvelopeProtector(new DerivedTenantKeyProvider(root, "local-v1"));
  const first = await protector.encodeTerms("Hello agent hello", "tenant-a");
  const second = await protector.encodeTerms("agent hello", "tenant-a");
  const otherTenant = await protector.encodeTerms("agent hello", "tenant-b");
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, otherTenant);
  assert.ok(first.every((token) => !token.includes("hello")));
});
