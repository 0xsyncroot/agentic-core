import assert from "node:assert/strict";
import test from "node:test";
import { AgenticError } from "@0xsyncroot/contracts";
import { publicApiError, publicMessage, publicStatus } from "../src/error-mapping.js";

test("publicMessage falls back to a generic English sentence with no businessMessages supplied", () => {
  assert.match(publicMessage(undefined, "validation"), /valid/i);
  assert.match(publicMessage(undefined, "some-unlisted-code"), /technical problem/i);
});

test("publicMessage prefers a product's byReason override over its byCode override and the built-in default", () => {
  const messages = { byCode: { conflict: "Product conflict sentence." }, byReason: { expired: "Product expired sentence." } };
  assert.equal(publicMessage(messages, "conflict", "expired"), "Product expired sentence.");
  assert.equal(publicMessage(messages, "conflict"), "Product conflict sentence.");
  assert.equal(publicMessage(messages, "conflict", "superseded"), "Product conflict sentence.");
});

test("publicMessage falls back to a product's own generic sentence, not the package's, when only generic is supplied", () => {
  assert.equal(publicMessage({ generic: "Product-wide fallback." }, "some-unlisted-code"), "Product-wide fallback.");
});

test("publicApiError never includes detail unless explicitly asked, and never leaks a stack", () => {
  const error = new AgenticError("validation", "content is required");
  const withoutDetail = publicApiError(undefined, error, false);
  assert.equal(withoutDetail.detail, undefined);
  assert.match(withoutDetail.message, /valid/i);

  const withDetail = publicApiError(undefined, error, true);
  assert.equal(withDetail.detail, "content is required");

  const plainError = new Error("unexpected failure with a stack");
  const mapped = publicApiError(undefined, plainError, true);
  assert.equal(mapped.code, "internal");
  assert.doesNotMatch(mapped.detail ?? "", /at Object|at Module/);
});

test("publicApiError carries the AgenticError reason through, mapped or not", () => {
  const error = new AgenticError("conflict", "stale", false, { reason: "stale-binding" });
  const mapped = publicApiError({ byReason: { "stale-binding": "Dữ liệu đã thay đổi." } }, error, false);
  assert.equal(mapped.reason, "stale-binding");
  assert.equal(mapped.message, "Dữ liệu đã thay đổi.");
});

test("publicStatus maps classified codes to their HTTP status and defaults everything else to 500/502", () => {
  assert.equal(publicStatus(new AgenticError("validation", "x")), 400);
  assert.equal(publicStatus(new AgenticError("denied", "x")), 403);
  assert.equal(publicStatus(new AgenticError("conflict", "x")), 409);
  assert.equal(publicStatus(new AgenticError("timeout", "x")), 504);
  assert.equal(publicStatus(new AgenticError("budget-exceeded", "x")), 502);
  assert.equal(publicStatus(new Error("plain")), 500);
});
