import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticError } from "./diagnostic-error.js";

test("stream diagnostics retain exception and cause stacks while redacting credentials", () => {
  const cause = new Error("storage failed at mysql://user:password@localhost/db");
  const error = new TypeError("parser failed secret-token Bearer another-token https://host/file?signature=secret-signature", { cause });
  const report = diagnosticError(error, { sessionId: "s", requestId: "r" }, { DOCUMENT_READERS_TOKEN: "secret-token" });
  const text = JSON.stringify(report);
  assert.match(text, /diagnostic.failed|TypeError/);
  assert.match(text, /parser failed/);
  assert.match(text, /storage failed/);
  assert.match(text, /diagnostic-error.test.ts/);
  assert.doesNotMatch(text, /secret-token|another-token|password|secret-signature/);
  assert.deepEqual([report.sessionId, report.requestId], ["s", "r"]);
});

test("cyclic exceptions and very long error messages have bounded diagnostics", () => {
  const error = new Error("x".repeat(20_000));
  error.cause = error;
  assert.ok(JSON.stringify(diagnosticError(error, { sessionId: "s", requestId: "r" }, {})).length < 8000);
});

test("AggregateError exposes the original failure and the failed terminal write independently", () => {
  const original = Object.assign(new Error("Session event integrity check failed: event-1"), { code: "permanent" });
  const terminal = Object.assign(new Error("Turn lease lost or expired: turn-1"), { code: "conflict" });
  const report = diagnosticError(new AggregateError([original, terminal], "Turn failed and terminal event could not be persisted"), { sessionId: "mysql-session", requestId: "request" }, {});
  const group = report.error as { errors: { code: string; message: string; stack: string }[] };
  assert.equal(group.errors.length, 2);
  assert.deepEqual(group.errors.map(error => error.code), ["permanent", "conflict"]);
  assert.match(group.errors[0]!.message, /integrity check/);
  assert.match(group.errors[1]!.message, /lease lost/);
  assert.ok(group.errors.every(error => error.stack.includes("diagnostic-error.test.ts")));
});

test("nested aggregate failures are bounded and redact each child's credentials", () => {
  const leaf = () => new Error("mysql://user:password@host/db Bearer private-token");
  const many = () => new AggregateError(Array.from({ length: 20 }, leaf), "group");
  const error = new AggregateError(Array.from({ length: 20 }, many), "root");
  error.cause = error;
  const text = JSON.stringify(diagnosticError(error, { sessionId: "s", requestId: "r" }, {}));
  assert.doesNotMatch(text, /password|private-token/);
  assert.match(text, /omittedErrors/);
  assert.ok(text.length < 150_000);
});
