import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERACTION_SUGGESTION_LIMIT, type SecurityContext, type ToolDefinition } from "@0xsyncroot/contracts";
import { PluginHost } from "@0xsyncroot/core";
import { SYSTEM_PROMPT_CAPABILITY, TOOL_CAPABILITY } from "@0xsyncroot/plugin-sdk";
import { createSystemPromptPlugin, createUserInputTool, createUserInputToolsPlugin } from "@0xsyncroot/plugins-base";

const security: SecurityContext = {
  tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["*"]),
  correlationId: "user-input-test", purpose: "test",
};

async function execute(tool: ToolDefinition, args: Record<string, unknown>) {
  return tool.execute(
    {
      callId: crypto.randomUUID(), sessionId: "session-a", turnId: "turn-a", stepId: "step-a",
      arguments: args as never, security, idempotencyKey: crypto.randomUUID(),
    },
    new AbortController().signal,
  );
}

async function schemaOf(args: Record<string, unknown>): Promise<Record<string, Record<string, unknown>>> {
  const requested = await execute(createUserInputTool(), args) as Record<string, unknown>;
  assert.equal(requested.kind, "interaction-required");
  return ((requested.request as Record<string, unknown>).requestedSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
}

test("a 'suggest' field renders as examples, not a choice list, so a value outside the suggestions is still schema-valid", async () => {
  const properties = await schemaOf({
    message: "Which allowance should go up to 50%?",
    fields: [{
      id: "benefitName", label: "Allowance", type: "suggest",
      choices: ["Occupational allowance", "Responsibility allowance", { value: "position", label: "Position allowance", description: "ignored for suggestions" }],
    }],
  });
  assert.deepEqual(properties.benefitName, {
    title: "Allowance", type: "string",
    examples: ["Occupational allowance", "Responsibility allowance", "Position allowance"],
    maxLength: 2_000,
  }, "a labelled suggestion offers its label: the words the user reads and would type");
  assert.equal("enum" in properties.benefitName! || "oneOf" in properties.benefitName!, false,
    "suggestions must never become a closed set: a name none of them guessed is still a valid answer");
});

test("a 'suggest' field with no choices is a plain free-text field", async () => {
  const properties = await schemaOf({ message: "Add a note", fields: [{ id: "note", label: "Note", type: "suggest" }] });
  assert.deepEqual(properties.note, { title: "Note", type: "string", maxLength: 2_000 });
});

test("labelled choices become titled consts: a select's oneOf, a multiselect's items.oneOf", async () => {
  const properties = await schemaOf({
    message: "Pick the scope",
    fields: [
      { id: "unit", label: "Unit", type: "select", required: true, choices: [
        { value: "u-01", label: "Head office", description: "Staff at the main building" }, "u-02",
      ] },
      { id: "kinds", label: "Kinds", description: "Every kind that applies", type: "multiselect", choices: [
        { value: "meal", label: "Meal" }, { value: "travel" },
      ] },
    ],
  });
  assert.deepEqual(properties.unit, {
    title: "Unit", type: "string", maxLength: 2_000, otherAnswer: true,
    oneOf: [{ const: "u-01", title: "Head office", description: "Staff at the main building" }, { const: "u-02", title: "u-02" }],
  });
  assert.deepEqual(properties.kinds, {
    title: "Kinds", description: "Every kind that applies", type: "array", maxItems: 2,
    items: { type: "string", oneOf: [{ const: "meal", title: "Meal" }, { const: "travel", title: "travel" }] },
  });
});

test(`a 'suggest' field offers 1-${INTERACTION_SUGGESTION_LIMIT} suggestions, so it stays a real shortlist`, async () => {
  const tool = createUserInputTool();
  const suggest = (choices: readonly string[]) => ({ message: "Pick", fields: [{ id: "x", label: "X", type: "suggest", choices }] });
  await execute(tool, suggest(Array.from({ length: INTERACTION_SUGGESTION_LIMIT }, (_, index) => `s${index}`)));
  // An empty list is no list (an open question, below); too many is still refused.
  for (const choices of [Array.from({ length: INTERACTION_SUGGESTION_LIMIT + 1 }, (_, index) => `s${index}`)]) {
    await assert.rejects(execute(tool, suggest(choices)), new RegExp(`requires 1-${INTERACTION_SUGGESTION_LIMIT} suggestions`, "u"));
    assert.throws(() => tool.validateArguments!(suggest(choices) as never, { security }), /suggestions/u, "refused before any card is raised");
  }
});

test("every field is titled and every choice well formed, or the request goes back to the model before a card is raised", () => {
  const tool = createUserInputTool();
  const refusals: readonly [Record<string, unknown>, RegExp][] = [
    [{ message: "Tell me more" }, /requires 1-20 fields; ask a single free question in chat/u],
    [{ message: "Pick", fields: [{ id: "x", label: " ", type: "text" }] }, /needs an id and a label/u],
    [{ message: "Pick", fields: [{ id: "x", label: "X", type: "select", choices: [{ label: "no value" }] }] }, /choice value/u],
    [{ message: "Pick", fields: [{ id: "x", label: "X", type: "select", choices: ["a", { value: "a", label: "A again" }] }] }, /repeats a choice value/u],
    [{ message: "Pick", fields: [{ id: "x", label: "X", type: "text" }, { id: "x", label: "Y", type: "text" }] }, /ids must be unique/u],
  ];
  for (const [args, reason] of refusals) assert.throws(() => tool.validateArguments!(args as never, { security }), reason);
});

test("the tool and the system prompt carry the same way to ask, with the shared suggestion limit", async () => {
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createUserInputToolsPlugin()], { security, verifyArtifact: async () => true });
  const prompt = (await Promise.all(host.capabilities.all(SYSTEM_PROMPT_CAPABILITY).map((item) => item.render(security)))).join("\n");
  const description = host.capabilities.all(TOOL_CAPABILITY).find((tool) => tool.id === "request_user_input")!.description;
  for (const text of [prompt, description]) {
    for (const row of [/one free fact you cannot guess.*plain chat text/iu, /yes or no, or a choice among a few known options.*select/iu, new RegExp(`1-${INTERACTION_SUGGESTION_LIMIT} likely values.*suggest`, "iu"), /several questions.*one .*call/iu]) {
      assert.match(text, row);
    }
    assert.doesNotMatch(text, /several typed fields or batch data/u, "the old rule that contradicted single-question cards is gone");
  }
  await host.shutdown();
});

// A select sent with no choices and a question longer than a title are the common malformed cards. Each refusal costs a
// step in which the model rewrites the answer the card follows, so the user reads it again.
test("a choice field with no choices is asked as an open question, and a long question keeps its whole text", async () => {
  const question = "Anh/chị xác nhận giúp em: ba người có phụ cấp chức vụ trên phần mềm nhưng tệp ghi 0 — phần mềm đúng hay tệp đúng, và từ tháng nào?";
  const properties = await schemaOf({ message: "Confirm", fields: [
    { id: "side", label: question, type: "select" },
    { id: "kinds", label: "Kinds", type: "multiselect", choices: [] },
    { id: "note", label: "Note", type: "suggest", choices: [] },
  ] });
  assert.equal(properties.side!.type, "string");
  assert.equal(properties.side!.oneOf, undefined, "no closed list was offered, so none is shown");
  assert.ok(String(properties.side!.title).length <= 120 && String(properties.side!.title).endsWith("…"));
  assert.ok(String(properties.side!.description).startsWith(question), "the whole question is kept for the user to read");
  assert.equal(properties.kinds!.type, "string");
  assert.equal(properties.note!.examples, undefined);
});


// A blank form comes back as {"action":"accept","values":{}}, which a model reads as "no adjustment needed". The result
// states which asked fields hold no answer, so a blank accept cannot read as "no".
const FORM = {
  message: "Anything to change?",
  fields: [
    { id: "change", label: "Change", type: "select", choices: ["No change", "Change needed"] },
    { id: "details", label: "Details", type: "multiline" },
    { id: "months", label: "Months", type: "multiselect", choices: ["9", "10"] },
    { id: "ok", label: "Confirmed", type: "boolean" },
  ],
};

function resume(tool: ToolDefinition, args: unknown, interaction: { action: "accept" | "decline" | "cancel"; content?: unknown }) {
  return tool.execute({
    callId: "call-1", sessionId: "session-a", turnId: "turn-a", stepId: "step-a",
    arguments: args as never, security, idempotencyKey: "key-1",
    interaction: { interactionId: "i-1", ...interaction } as never,
  }, new AbortController().signal);
}

test("a resumed accept names every asked field the content leaves unanswered", async () => {
  const tool = createUserInputTool();
  assert.deepEqual(await resume(tool, FORM, { action: "accept", content: {} }), {
    action: "accept", values: {}, unanswered: ["change", "details", "months", "ok"],
  });
  assert.deepEqual(await resume(tool, FORM, { action: "accept", content: { change: "No change", details: "  ", months: [] } }), {
    action: "accept", values: { change: "No change", details: "  ", months: [] }, unanswered: ["details", "months", "ok"],
  });
  assert.deepEqual(await resume(tool, FORM, { action: "accept" }), {
    action: "accept", values: {}, unanswered: ["change", "details", "months", "ok"],
  });
  const full = { change: "Change needed", details: "x", months: ["10"], ok: false };
  assert.deepEqual(await resume(tool, FORM, { action: "accept", content: full }), { action: "accept", values: full });
});

test("a decline carries no unanswered list, and arguments that cannot be read never fail the resume", async () => {
  const tool = createUserInputTool();
  assert.deepEqual(await resume(tool, FORM, { action: "decline" }), { action: "decline", values: {} });
  for (const args of [{}, { message: "x" }, "not an object", null, { message: "x", fields: [{ id: "1bad", label: "L", type: "text" }] }]) {
    assert.deepEqual(await resume(tool, args, { action: "accept", content: { a: "1" } }), { action: "accept", values: { a: "1" } });
  }
});

test("the description says an unanswered question is not an answer, and the output schema allows unanswered", () => {
  const tool = createUserInputTool();
  assert.match(tool.description, /A question the user skipped or left unanswered is not an answer: never state or act on an answer the user did not give\./u);
  assert.doesNotMatch(tool.description, /continue with what you have/u);
  const properties = (tool.outputSchema as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(properties.unanswered, { type: "array", items: { type: "string" } });
});
