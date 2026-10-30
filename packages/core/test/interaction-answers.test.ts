import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, INTERACTION_SUGGESTION_LIMIT, INTERACTION_TTL_CAP_MS, TOOL_EXECUTION_RESPONSE_PROTOCOL, type HumanInteractionRequest, type JsonValue, type SessionEvent, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { createSystemPromptPlugin, createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";
import { HumanInteractionValidator } from "../src/agent/human-interaction-validator.js";
import { SpyStore, activeHost, answer, call, scriptedModel, security, toolPlugin } from "./turn-harness.js";

function payload(event: SessionEvent | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function form(properties: Record<string, JsonValue>): HumanInteractionRequest {
  return { kind: "form", message: "Answer these", requestedSchema: { type: "object", properties } };
}

test("an answered card is echoed by the titles the user saw, a free-typed suggestion is accepted, and the model reads the values", async () => {
  const question = {
    message: "A few details before I update the allowance",
    fields: [
      { id: "unit", label: "Unit", type: "select", required: true, choices: [
        { value: "u-01", label: "Head office", description: "Staff at the main building" }, { value: "u-02", label: "Branch" },
      ] },
      { id: "kinds", label: "Allowance kinds", type: "multiselect", choices: [
        { value: "meal", label: "Meal" }, { value: "travel", label: "Travel" }, "phone",
      ] },
      { id: "benefit", label: "Allowance name", type: "suggest", required: true, choices: ["Responsibility allowance", { value: "seniority", label: "Seniority allowance" }] },
      { id: "rate", label: "Rate (%)", type: "number" },
    ],
  };
  const { adapter, requests } = scriptedModel([call("ask-1", "request_user_input", question), answer("Updated.")]);
  const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), createUserInputToolsPlugin()]);
  const agent = new DefaultAgentLoop(router, new SpyStore());
  const paused = await agent.runTurn({ sessionId: "echo", content: "update the allowance", security: security() });
  assert.equal(paused.outcome, "awaiting_interaction");
  const schema = paused.interaction!.kind === "form" ? paused.interaction!.requestedSchema as Record<string, Record<string, JsonValue>> : {};
  assert.deepEqual(schema.properties!.benefit, {
    title: "Allowance name", type: "string", examples: ["Responsibility allowance", "Seniority allowance"], maxLength: 2_000,
  }, "a labelled suggestion offers the words the user reads");
  // None of the suggestions: the user typed their own answer, and a suggestion list never closes the field.
  const content = { unit: "u-01", kinds: ["travel", "phone"], benefit: "Hazard allowance", rate: 50 };
  const resumed = await agent.resumeInteraction({
    sessionId: "echo", interactionId: paused.interaction!.interactionId, action: "accept", content, security: security(), idempotencyKey: "echo-answer",
  });
  assert.deepEqual([resumed.outcome, resumed.content], ["completed", "Updated."]);
  const told = requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "ask-1")?.content ?? "";
  assert.deepEqual(JSON.parse(told), { action: "accept", values: content }, "the model reads the submitted values, with no note for an answer");
  const resolved = resumed.events.find((event) => event.type === "interaction/resolved");
  assert.equal(resolved?.classification, "confidential");
  assert.deepEqual(payload(resolved).echo, [
    { label: "Unit", value: "Head office" },
    { label: "Allowance kinds", value: "Travel, phone" },
    { label: "Allowance name", value: "Hazard allowance" },
    { label: "Rate (%)", value: "50" },
  ]);
  await host.shutdown();
});

test("the echo stays a short receipt: at most twelve answers, each at most 500 characters", () => {
  const validator = new HumanInteractionValidator();
  const properties = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`f${index}`, { type: "string", title: `Field ${index}` }]));
  const content = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`f${index}`, index === 0 ? "x".repeat(900) : `answer ${index}`]));
  const echo = validator.echo(form(properties), "accept", content)!;
  assert.equal(echo.length, 12);
  assert.equal(echo[0]!.value.length, 500);
  assert.equal(echo[0]!.value.endsWith("…"), true);
  assert.equal(validator.echo(form(properties), "decline", undefined), undefined, "a skipped question has nothing to echo");
});

test("the validator holds suggestions to 1-4 strings the field itself accepts", () => {
  const validator = new HumanInteractionValidator();
  const suggest = (examples: JsonValue, extra: Record<string, JsonValue> = {}) =>
    form({ name: { type: "string", title: "Name", maxLength: 20, examples, ...extra } });
  validator.validateRequest(suggest(Array.from({ length: INTERACTION_SUGGESTION_LIMIT }, (_, index) => `name ${index}`)));
  const refusals: readonly [string, HumanInteractionRequest][] = [
    ["too many", suggest(Array.from({ length: INTERACTION_SUGGESTION_LIMIT + 1 }, (_, index) => `name ${index}`))],
    ["none", suggest([])],
    ["longer than the field", suggest(["x".repeat(21)])],
    ["not text", suggest([7])],
    ["blank", suggest([" "])],
    ["on a number field", form({ amount: { type: "number", title: "Amount", examples: ["1"] } })],
  ];
  for (const [why, request] of refusals) {
    assert.throws(() => validator.validateRequest(request), (error: unknown) =>
      error instanceof AgenticError && error.code === "validation", `refused: ${why}`);
  }
});

test("the validator accepts titled choices on a field and on a multiselect's items, and only their values as answers", () => {
  const validator = new HumanInteractionValidator();
  const request = form({
    unit: { type: "string", title: "Unit", oneOf: [{ const: "u-01", title: "Head office", description: "Main building" }, { const: "u-02", title: "Branch" }] },
    kinds: { type: "array", title: "Kinds", items: { type: "string", oneOf: [{ const: "meal", title: "Meal" }, { const: "travel", title: "Travel" }] } },
  });
  validator.validateRequest(request);
  validator.validateResponse(request, "accept", { unit: "u-02", kinds: ["meal"] });
  assert.throws(() => validator.validateResponse(request, "accept", { unit: "Head office" }), /outside its choices/u, "a title is not a value");
  assert.throws(() => validator.validateResponse(request, "accept", { kinds: ["Meal"] }), /unsupported choice/u);
  assert.throws(() => validator.validateRequest(form({
    unit: { type: "string", title: "Unit", oneOf: [{ const: "u-01", title: "Head office", description: 7 }] },
  })), /Invalid choices/u);
});

test("an open choice list takes the person's own words as its value; a closed one refuses them", () => {
  const validator = new HumanInteractionValidator();
  const choices = [{ const: "stc", title: "Finance office" }, { const: "syt", title: "Health office" }];
  const open = form({ unit: { type: "string", title: "Unit", otherAnswer: true, oneOf: choices } });
  validator.validateRequest(open);
  validator.validateResponse(open, "accept", { unit: "A ward not on the list" });
  assert.deepEqual(validator.echo(open, "accept", { unit: "A ward not on the list" }), [{ label: "Unit", value: "A ward not on the list" }]);
  assert.throws(() => validator.validateResponse(open, "accept", { unit: " " }), /outside its choices/u, "blank words are no answer");
  const closed = form({ unit: { type: "string", title: "Unit", oneOf: choices } });
  assert.throws(() => validator.validateResponse(closed, "accept", { unit: "A ward not on the list" }), /outside its choices/u);
  assert.throws(() => validator.validateRequest(form({ note: { type: "string", title: "Note", otherAnswer: true } })), /choice field/u,
    "only a list can be opened");
});

test("a tool's own ttlMs sets how long its card stays answerable, capped; without one the deployment's TTL holds", async () => {
  const asking = (ttlMs?: number): ToolDefinition => ({
    id: "test_wait", version: "1.0.0", description: "waits on the person", asksUser: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000,
    execute: async (invocation) => invocation.interaction ? { answered: true } : {
      protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required",
      request: { ...form({ done: { type: "boolean", title: "Done" } }), ...(ttlMs === undefined ? {} : { ttlMs }) },
    },
  });
  const opened = async (ttlMs?: number): Promise<number> => {
    const { adapter } = scriptedModel([call("wait-1", "test_wait", {})]);
    const { host, router } = await activeHost(adapter, [createSystemPromptPlugin(), toolPlugin("wait", [asking(ttlMs)])]);
    const started = Date.now();
    const paused = await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: `ttl-${ttlMs}`, content: "wait", security: security() });
    await host.shutdown();
    assert.equal(paused.outcome, "awaiting_interaction");
    return Date.parse(paused.interaction!.expiresAt) - started;
  };
  const near = (actual: number, expected: number, why: string) => assert.ok(Math.abs(actual - expected) < 5_000, `${why}: ${actual} ms, expected ${expected}`);
  near(await opened(4 * 60 * 60_000), 4 * 60 * 60_000, "the tool's four hours");
  near(await opened(48 * 60 * 60_000), INTERACTION_TTL_CAP_MS, "cut to the cap");
  near(await opened(), 8 * 60 * 60_000, "the default TTL");
  const validator = new HumanInteractionValidator();
  for (const ttlMs of [0, 999, 1_500.5, Number.NaN]) {
    assert.throws(() => validator.validateRequest({ ...form({ done: { type: "boolean", title: "Done" } }), ttlMs }), /ttlMs/u, `ttlMs ${ttlMs}`);
  }
});

test("a readOnly field is the host's to fill: accepted as an answer, never part of the receipt", () => {
  const validator = new HumanInteractionValidator();
  const request = form({
    review: { type: "string", title: "Item", oneOf: [{ const: "saved", title: "Saved", readOnly: true }, { const: "done", title: "Done" }] },
    item: { type: "string", title: "Item id", maxLength: 128, readOnly: true },
  });
  validator.validateRequest(request);
  validator.validateResponse(request, "accept", { review: "saved", item: "a-1" });
  assert.deepEqual(validator.echo(request, "accept", { review: "saved", item: "a-1" }), [{ label: "Item", value: "Saved" }]);
});
