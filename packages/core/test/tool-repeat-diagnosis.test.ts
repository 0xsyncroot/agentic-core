import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue, LlmAdapter, LlmStreamEvent, ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop, JsonSchemaToolInputValidator } from "@0xsyncroot/core";
import { toolCallFingerprint } from "../src/agent/tool-call-fingerprint.js";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { activeHost, security, toolPlugin } from "./turn-harness.js";

/**
 * Two things the model reads when it goes wrong: why a repeated call was stopped, and what was
 * wrong with arguments that were refused. Both used to name the failure without the evidence that
 * lets the model change course — the result it kept asking for, the near miss it typed.
 */

const LAST_RESULT = "Rows 1-50 of 50 read; nothing more to page";

function readTool(): ToolDefinition {
  return {
    id: "test_read", version: "1.0.0", description: "reads",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, sheetName: { type: "string" } }, additionalProperties: false },
    outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async () => ({ note: LAST_RESULT }) as never,
  };
}

function rawCall(id: string, argumentsText: string): LlmStreamEvent {
  return { type: "final", content: null, toolCalls: [{ id, name: "test_read", arguments: argumentsText }], finishReason: "tool_calls", status: "tool_calls" };
}

test("the same arguments in another key order and spacing are one call, and the block quotes the last result", async () => {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const replies = [rawCall("c1", '{"a":1,"b":2}'), rawCall("c2", '{ "b": 2,\n "a": 1 }'), rawCall("c3", '{"b":2,"a":1}'),
    { type: "final", content: "xong", toolCalls: [], finishReason: "stop", status: "completed" } as LlmStreamEvent];
  const model = { id: "scripted", model: "scripted", async *stream(request: (typeof requests)[number]) { requests.push(request); yield replies[requests.length - 1]!; } };
  const { router } = await activeHost(model, [toolPlugin("read", [readTool()])]);
  await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxRepeatedToolCalls: 2 }).runTurn({
    sessionId: "repeat-quote", content: "đọc", security: security(),
  });
  assert.equal(requests.length, 4, "the model is asked again after the block");

  const toolMessages = requests[3]!.messages.filter((message) => message.role === "tool").map((message) => message.content ?? "");
  assert.equal(toolMessages.length, 3);
  const blocked = (JSON.parse(toolMessages[2]!.split("\n")[0]!) as { message: string }).message; // runtime notes follow the result on later lines
  assert.match(blocked, /Repeated tool call blocked: test_read was already called 2 times with these exact arguments\./u);
  assert.ok(blocked.includes(`Its last result: «{"note":"${LAST_RESULT}"}»`), `the block should quote the last result: ${blocked}`);
  // No "or answer with what is known": one more "answer now" voice beside an audit saying "keep going".
  assert.match(blocked, /Change what that result names and call again\./u);

  // The quote is tool data: it reaches the model as a tool result and never inside a system instruction.
  for (const request of requests) {
    const instructions = request.messages.filter((message) => message.role === "system").map((message) => message.content ?? "");
    assert.ok(!instructions.some((text) => text.includes(LAST_RESULT)), "tool data must not enter a system instruction");
  }
});

test("a repeated call that failed validation quotes the validation error", async () => {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const bad = '{"sheet":"x"}';
  const replies = [rawCall("c1", bad), rawCall("c2", bad), rawCall("c3", bad),
    { type: "final", content: "xong", toolCalls: [], finishReason: "stop", status: "completed" } as LlmStreamEvent];
  const model = { id: "scripted", model: "scripted", async *stream(request: (typeof requests)[number]) { requests.push(request); yield replies[requests.length - 1]!; } };
  const { router } = await activeHost(model, [toolPlugin("read", [readTool()])]);
  await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxRepeatedToolCalls: 2 }).runTurn({ sessionId: "repeat-invalid", content: "đọc", security: security() });
  const blocked = (JSON.parse(requests[3]!.messages.filter((message) => message.role === "tool").map((message) => message.content ?? "")[2]!.split("\n")[0]!) as { message: string }).message;
  assert.match(blocked, /Its last result: «.*\$\.sheet is not allowed \(closest: /u);
});

test("text that is not JSON is its own fingerprint", () => {
  assert.equal(toolCallFingerprint("t", '{"a":1,"b":2}'), toolCallFingerprint("t", '{ "b":2, "a":1 }'));
  assert.notEqual(toolCallFingerprint("t", '{"a":1}'), toolCallFingerprint("u", '{"a":1}'));
  assert.notEqual(toolCallFingerprint("t", "{broken"), toolCallFingerprint("t", "{ broken"));
  assert.equal(toolCallFingerprint("t", "{broken"), toolCallFingerprint("t", "{broken"));
});

const SCHEMA = {
  type: "object",
  properties: {
    sheetName: { type: "string", pattern: "^[A-Z]+$" },
    area: { type: "string", enum: ["viewport", "rowHeader", "columnHeader"] },
    limit: { type: "integer" },
  },
  required: ["sheetName"],
  additionalProperties: false,
} as unknown as JsonValue;

function refusal(value: unknown): string {
  try { new JsonSchemaToolInputValidator().validate(SCHEMA, value as JsonValue); }
  catch (error) { assert.equal((error as { code?: string }).code, "validation"); return (error as Error).message; }
  return assert.fail("expected the value to be refused");
}

test("an unknown property names the closest allowed one before the allowed list", () => {
  const message = refusal({ sheet: "A" });
  assert.match(message, /^Invalid tool input: \$\.sheetName is required; \$\.sheet is not allowed \(closest: sheetName\); allowed: sheetName, area, limit/u);
});

test("an unknown property with nothing near it lists the allowed names without a guess", () => {
  const message = refusal({ sheetName: "A", zzzzzz: 1 });
  assert.equal(message, "Invalid tool input: $.zzzzzz is not allowed; allowed: sheetName, area, limit");
});

test("an unknown property name is echoed cut, so one refusal cannot grow with the input", () => {
  const long = "k".repeat(100_000);
  const single = refusal({ sheetName: "A", [long]: 1 });
  assert.equal(single, `Invalid tool input: $.${"k".repeat(60)}… is not allowed; allowed: sheetName, area, limit`);
  const many = refusal({ sheetName: "A", ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`${index}${"k".repeat(20_000)}`, 1])) });
  assert.equal(many.length < 1_000, true, `message was ${many.length} characters`);
  const split = refusal({ sheetName: "A", [`a${"\u{1F600}".repeat(40)}`]: 1 });
  assert.equal(split.includes(`$.a${"\u{1F600}".repeat(29)}… is not allowed`), true, "a cut never leaves half a surrogate pair");
});

test("an enum refusal names the closest value, whatever the case and spacing", () => {
  assert.match(refusal({ sheetName: "A", area: "Row Header" }), /\$\.area has an unsupported value \(closest: rowHeader\); allowed: viewport, rowHeader, columnHeader/u);
  assert.match(refusal({ sheetName: "A", area: "everything" }), /\$\.area has an unsupported value; allowed: viewport, rowHeader, columnHeader/u);
});

test("every failure is reported, not only the first", () => {
  const message = refusal({ sheet: "A", area: "viewprt", limit: 1.5 });
  assert.match(message, /\$\.sheetName is required/u);
  assert.match(message, /\$\.sheet is not allowed \(closest: sheetName\)/u);
  assert.match(message, /\$\.area has an unsupported value \(closest: viewport\)/u);
  assert.match(message, /\$\.limit must be an integer/u);
  assert.equal(message.startsWith("Invalid tool input: "), true);
});

test("a refusal names at most five failures", () => {
  const properties = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p${index}`, { type: "string" }]));
  const schema = { type: "object", properties, required: Object.keys(properties) } as unknown as JsonValue;
  try { new JsonSchemaToolInputValidator().validate(schema, {}); assert.fail("expected a refusal"); }
  catch (error) { assert.equal((error as Error).message.split(" is required").length - 1, 5); }
});

test("a long allowed list is cut at twenty names", () => {
  const names = Array.from({ length: 30 }, (_, index) => `field${String(index).padStart(2, "0")}`);
  const schema = { type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])), additionalProperties: false } as unknown as JsonValue;
  try { new JsonSchemaToolInputValidator().validate(schema, { other: "x" }); assert.fail("expected a refusal"); }
  catch (error) {
    const listed = (error as Error).message.split("allowed: ")[1]!;
    assert.equal(listed, `${names.slice(0, 20).join(", ")}, …`);
  }
});

test("a pattern refusal states the pattern", () => {
  assert.match(refusal({ sheetName: "abc" }), /\$\.sheetName does not match the required pattern \^\[A-Z\]\+\$/u);
});

test("a value one anyOf branch accepts still passes", () => {
  const schema = { anyOf: [{ type: "string" }, { type: "integer" }] } as unknown as JsonValue;
  const validator = new JsonSchemaToolInputValidator();
  assert.doesNotThrow(() => validator.validate(schema, "x"));
  assert.doesNotThrow(() => validator.validate(schema, 3));
  assert.throws(() => validator.validate(schema, true), /matches none of its allowed shapes/u);
});

test("a closest name ignores accents, case and spacing", () => {
  const schema = { type: "object", properties: { sheetName: { type: "string", enum: ["31- ĐBXH", "GVBC"] } }, additionalProperties: false } as unknown as JsonValue;
  assert.throws(() => new JsonSchemaToolInputValidator().validate(schema, { sheetName: "31-dbxh" }), /\(closest: 31- ĐBXH\)/u);
});

test("a repeat whose result changed is not a loop; a repeat with the same result still is", async () => {
  // Re-reading the screen after navigating returns a new observation each time: the guard must not refuse such reads, or
  // the agent acts on stale references.
  let screen = 0;
  const live: ToolDefinition = { ...readTool(), execute: async () => ({ screen: `revision-${screen += 1}` }) as never };
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const replies = [rawCall("c1", "{}"), rawCall("c2", "{}"), rawCall("c3", "{}"), rawCall("c4", "{}"),
    { type: "final", content: "xong", toolCalls: [], finishReason: "stop", status: "completed" } as LlmStreamEvent];
  const model = { id: "scripted", model: "scripted", async *stream(request: (typeof requests)[number]) { requests.push(request); yield replies[requests.length - 1]!; } };
  const { router } = await activeHost(model, [toolPlugin("read", [live])]);
  await new DefaultAgentLoop(router, new InMemorySessionStore(), { maxRepeatedToolCalls: 2 }).runTurn({ sessionId: "repeat-live", content: "đọc", security: security() });
  const toolMessages = requests[4]!.messages.filter((message) => message.role === "tool").map((message) => message.content ?? "");
  assert.equal(toolMessages.length, 4);
  assert.ok(toolMessages.every((message) => !message.includes("Repeated tool call blocked")), "each re-read returned something new");
  assert.match(toolMessages[3]!, /revision-4/u);
});
