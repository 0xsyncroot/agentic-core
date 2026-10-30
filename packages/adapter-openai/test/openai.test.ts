import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreparedLlmRequest } from "@0xsyncroot/contracts";
import { OpenAIAdapter, createOpenAIPlugin } from "@0xsyncroot/adapter-openai";
import "./images.test.js";

function stream(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
}

test("OpenAI Responses adapter streams text and preserves function-call continuation", async () => {
  const bodies: Record<string, unknown>[] = [];
  let count = 0;
  const adapter = new OpenAIAdapter({ apiKey: "sk-sensitive-value", model: "gpt-test", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    count += 1;
    return count === 1 ? stream([
      { type: "response.output_text.delta", delta: "checking" },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "call1", name: "lookup", arguments: "{\"q\":\"x\"}" } },
      { type: "response.completed", response: { id: "resp1", status: "completed", output: [{ type: "function_call", id: "fc1", call_id: "call1", name: "lookup", arguments: "{\"q\":\"x\"}" }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
    ]) : stream([{ type: "response.completed", response: { id: "resp2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] } }]);
  } });
  const base: Omit<PreparedLlmRequest, "messages" | "contentHash"> = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: adapter.model, tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }], parameters: adapter.defaultParameters,
  };
  const first = [];
  for await (const event of adapter.stream({ ...base, messages: [{ role: "user", content: "find" }], contentHash: "h1" }, new AbortController().signal)) first.push(event);
  const terminal = first.at(-1);
  assert.equal(terminal?.type, "final");
  if (terminal?.type !== "final") throw new Error("missing final");
  assert.equal(terminal.toolCalls[0]?.name, "lookup");
  for await (const _ of adapter.stream({ ...base, messages: [
    { role: "user", content: "find" },
    { role: "assistant", content: terminal.content, toolCalls: terminal.toolCalls, providerState: terminal.providerState },
    { role: "tool", content: "result", toolCallId: "call1" },
  ], contentHash: "h2" }, new AbortController().signal)) { /* consume */ }
  const input = bodies[1]?.input as Array<Record<string, unknown>>;
  assert.equal(input[1]?.type, "function_call");
  assert.equal(input[2]?.type, "function_call_output");
  assert.equal(JSON.stringify(bodies).includes("sk-sensitive-value"), false);
});

test("OpenAI maps provider-neutral tool choice and gives it precedence over legacy parameters", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return stream([{ type: "response.completed", response: { id: "choice", status: "completed", output: [] } }]);
  } });
  const choices = ["auto", "required", "none", { name: "lookup" }] as const;
  for (const [index, toolChoice] of choices.entries()) {
    const request: PreparedLlmRequest = {
      requestId: `r${index}`, attemptId: `a${index}`, turnId: "t", stepId: `s${index}`, runtimeSnapshotId: "rt",
      model: adapter.model, messages: [{ role: "user", content: "choose" }],
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      parameters: { ...adapter.defaultParameters, tool_choice: "legacy" }, toolChoice, contentHash: `h${index}`,
    };
    for await (const _event of adapter.stream(request, new AbortController().signal)) { /* consume */ }
  }
  assert.deepEqual(bodies.map((body) => body.tool_choice), [
    "auto", "required", "none", { type: "function", name: "lookup" },
  ]);
  assert.equal(adapter.features.toolChoice, true);
});

test("a 400 is the provider's last word: the adapter carries no gateway retry", async () => {
  // The OpenAI adapter is exactly the OpenAI contract. Re-sending without tool_choice is a
  // workaround for an OpenAI-compatible gateway and lives in the adapter for that gateway;
  // here it would hide a request the real API rejected and spend a second billed call.
  let calls = 0;
  const adapter = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Invalid value for 'tool_choice'", type: "invalid_request_error", code: null } }), { status: 400 });
  } });
  const request: PreparedLlmRequest = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: adapter.model, messages: [{ role: "user", content: "choose" }],
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
    parameters: {}, toolChoice: { name: "lookup" }, contentHash: "h",
  };
  await assert.rejects(
    (async () => { for await (const _event of adapter.stream(request, new AbortController().signal)) { /* consume */ } })(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "permanent" && /Invalid value for 'tool_choice'/u.test(error.message));
  assert.equal(calls, 1, "one request, no silent retry");
});

test("OpenAI sends the encrypted reasoning content its own stateless replay needs", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return stream([{ type: "response.completed", response: { id: "r", status: "completed", output: [] } }]);
  } });
  const base: Omit<PreparedLlmRequest, "parameters" | "contentHash"> = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: adapter.model, messages: [{ role: "user", content: "hi" }], tools: [],
  };
  for await (const _ of adapter.stream({ ...base, parameters: adapter.defaultParameters, contentHash: "h1" }, new AbortController().signal)) { /* consume */ }
  assert.equal(adapter.defaultParameters.store, false, "stateless by default, so the reasoning items are ours to carry");
  assert.deepEqual(bodies[0]?.include, ["reasoning.encrypted_content"]);

  // A caller that states its own include still owns it.
  for await (const _ of adapter.stream({ ...base, parameters: { include: [] }, contentHash: "h2" }, new AbortController().signal)) { /* consume */ }
  assert.deepEqual(bodies[1]?.include, []);
});

test("OpenAI surfaces the reason a stream or a response fails", async () => {
  const request: PreparedLlmRequest = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: "gpt-test", messages: [{ role: "user", content: "x" }], tools: [], parameters: {}, contentHash: "h",
  };
  const drain = async (adapter: OpenAIAdapter): Promise<void> => {
    for await (const _ of adapter.stream(request, new AbortController().signal)) { /* consume */ }
  };

  // The `error` event carries message and code at the top level of the event, not nested.
  const errored = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => stream([
    { type: "error", code: "rate_limit_exceeded", message: "Rate limit reached for gpt-test", param: null, sequence_number: 1 },
  ]) });
  await assert.rejects(drain(errored), /rate_limit_exceeded.*Rate limit reached for gpt-test/u);

  // `response.failed` keeps its reason in `response.error`, and the provider's own transient
  // codes must stay retryable rather than ending the turn.
  const failed = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => stream([
    { type: "response.failed", response: { id: "resp", status: "failed", error: { code: "server_error", message: "The model failed to generate a response" }, output: [] } },
  ]) });
  await assert.rejects(drain(failed), (error: unknown) =>
    error instanceof Error && "retryable" in error && error.retryable === true && /server_error.*failed to generate/u.test(error.message));

  const refused = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => stream([
    { type: "response.failed", response: { id: "resp", status: "failed", error: { code: "invalid_prompt", message: "Your prompt was flagged" }, output: [] } },
  ]) });
  await assert.rejects(drain(refused), (error: unknown) =>
    error instanceof Error && "retryable" in error && error.retryable === false && /invalid_prompt/u.test(error.message));
});

test("OpenAI separates a content filter from a spent output budget", async () => {
  const terminal = async (reason: string): Promise<{ status?: string; finishReason?: string }> => {
    const adapter = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => stream([
      { type: "response.output_text.delta", delta: "part" },
      { type: "response.incomplete", response: { id: "resp", status: "incomplete", incomplete_details: { reason }, output: [] } },
    ]) });
    const events = [];
    for await (const event of adapter.stream({
      requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
      model: adapter.model, messages: [{ role: "user", content: "x" }], tools: [], parameters: {}, contentHash: "h",
    }, new AbortController().signal)) events.push(event);
    const final = events.at(-1);
    if (final?.type !== "final") throw new Error("missing final");
    return { status: final.status, finishReason: final.finishReason };
  };
  assert.deepEqual(await terminal("max_output_tokens"), { status: "incomplete", finishReason: "max_output_tokens" });
  assert.deepEqual(await terminal("content_filter"), { status: "blocked", finishReason: "content_filter" });
});

test("OpenAI refuses a function call that carries no call_id", async () => {
  // `id` is the output item's own identifier; only `call_id` may be echoed back as the
  // `function_call_output.call_id` of the next turn, so it must never stand in for one.
  const adapter = new OpenAIAdapter({ apiKey: "secret", model: "gpt-test", fetch: async () => stream([
    { type: "response.completed", response: { id: "resp", status: "completed", output: [{ type: "function_call", id: "fc_1", name: "lookup", arguments: "{}" }] } },
  ]) });
  await assert.rejects((async () => {
    for await (const _ of adapter.stream({
      requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
      model: adapter.model, messages: [{ role: "user", content: "x" }],
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }], parameters: {}, contentHash: "h",
    }, new AbortController().signal)) { /* consume */ }
  })(), /incomplete function call/u);
});

test("OpenAI plugin exposes only non-secret snapshot config", () => {
  const plugin = createOpenAIPlugin({ apiKey: "secret", model: "gpt-test" });
  assert.equal(plugin.config?.model, "gpt-test");
  assert.equal(JSON.stringify(plugin.config).includes("secret"), false);
});

test("OpenAI adapter rejects credentials in URLs and insecure remote endpoints", () => {
  assert.throws(() => new OpenAIAdapter({ apiKey: "secret", baseUrl: "https://user:password@api.example/v1" }), /must not contain credentials/i);
  assert.throws(() => new OpenAIAdapter({ apiKey: "secret", baseUrl: "http://api.example/v1" }), /must use https/i);
  assert.doesNotThrow(() => new OpenAIAdapter({ apiKey: "secret", baseUrl: "http://127.0.0.1:8080/v1" }));
});

test("OpenAI resolves exact model metadata and leaves unlisted models explicit", async () => {
  const known = new OpenAIAdapter({ apiKey: "secret", model: "gpt-5" });
  const knownRoute = await known.resolveModel();
  assert.equal(knownRoute.contextWindowTokens, 400_000);
  assert.equal(knownRoute.maxOutputTokens, 128_000);
  assert.equal(knownRoute.metadataSource, "adapter-catalog");

  const unlisted = new OpenAIAdapter({ apiKey: "secret", model: "future-model" });
  const unlistedRoute = await unlisted.resolveModel();
  assert.equal(unlistedRoute.contextWindowTokens, undefined);
  assert.equal(unlistedRoute.metadataSource, "fallback");
});

test("OpenAI normalizes provider context overflow for bounded core recovery", async () => {
  const request: PreparedLlmRequest = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: "gpt-test", messages: [{ role: "user", content: "x" }], tools: [], parameters: {}, contentHash: "h",
  };
  const rejectsAsOverflow = async (body: unknown): Promise<void> => {
    const adapter = new OpenAIAdapter({ apiKey: "secret", fetch: async () => Response.json(body, { status: 400 }) });
    await assert.rejects(async () => {
      for await (const _ of adapter.stream(request, new AbortController().signal)) { /* consume */ }
    }, (error: unknown) => error instanceof Error && "code" in error && error.code === "context-overflow");
  };
  await rejectsAsOverflow({ error: { message: "maximum context length exceeded" } });
  // `code` is the documented machine-readable field, so a reworded message still routes to recovery.
  await rejectsAsOverflow({ error: { message: "yêu cầu quá dài", type: "invalid_request_error", code: "context_length_exceeded" } });
});
