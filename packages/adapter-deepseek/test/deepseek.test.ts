import assert from "node:assert/strict";
import { test } from "node:test";
import { AgenticError, type PreparedLlmRequest } from "@0xsyncroot/contracts";
import { createDeepSeekPlugin, DeepSeekAdapter } from "@0xsyncroot/adapter-deepseek";

function streamResponse(chunks: readonly unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("DeepSeek adapter maps the recorded request to the official chat endpoint", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponse([
      { id: "provider-request-1", choices: [{ finish_reason: null, delta: { content: "o" } }] },
      { id: "provider-request-1", choices: [{ finish_reason: "stop", delta: { content: "k" } }] },
      { id: "provider-request-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
  };
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", fetch: mockFetch });
  const request: PreparedLlmRequest = {
    requestId: "r1",
    attemptId: "a1",
    turnId: "t1",
    stepId: "s1",
    runtimeSnapshotId: "runtime-1",
    model: adapter.model,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    parameters: { ...adapter.defaultParameters, max_tokens: 100 },
    contentHash: "hash",
  };
  const events = [];
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(capturedBody.model, "deepseek-v4-flash");
  assert.deepEqual(capturedBody.thinking, { type: "disabled" });
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.delta), ["o", "k"]);
  const final = events.at(-1);
  assert.equal(final?.type, "final");
  assert.equal(final?.type === "final" ? final.content : undefined, "ok");
});

test("DeepSeek maps provider-neutral tool choice to Chat Completions wire format", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", fetch: async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "ok" } }] }]);
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
    "auto", "required", "none", { type: "function", function: { name: "lookup" } },
  ]);
  assert.equal(adapter.features.toolChoice, true);
});

test("DeepSeek thinking mode declares no hard tool choice and never sends one", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", thinking: "enabled", fetch: async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "ok" } }] }]);
  } });
  // The provider answers a named or required tool_choice in thinking mode with a 400, so the
  // adapter must not claim to enforce one; the loop then puts the choice in words.
  assert.equal(adapter.features.toolChoice, false);
  const choices = ["auto", "required", { name: "lookup" }] as const;
  for (const [index, toolChoice] of choices.entries()) {
    const request: PreparedLlmRequest = {
      requestId: `r${index}`, attemptId: `a${index}`, turnId: "t", stepId: `s${index}`, runtimeSnapshotId: "rt",
      model: adapter.model, messages: [{ role: "user", content: "choose" }],
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
      parameters: { ...adapter.defaultParameters }, toolChoice, contentHash: `h${index}`,
    };
    for await (const _event of adapter.stream(request, new AbortController().signal)) { /* consume */ }
  }
  assert.deepEqual(bodies.map((body) => body.tool_choice), ["auto", undefined, undefined]);
});

test("DeepSeek thinking tool continuation replays private reasoning state", async () => {
  const bodies: Record<string, unknown>[] = [];
  let responseIndex = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    responseIndex += 1;
    return responseIndex === 1
      ? streamResponse([
          { choices: [{ finish_reason: null, delta: { reasoning_content: "private-chain-state" } }] },
          { choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{}" } }] } }] },
        ])
      : streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "done" } }] }]);
  };
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", thinking: "enabled", fetch: mockFetch });
  const base: Omit<PreparedLlmRequest, "messages" | "contentHash"> = {
    requestId: "r1", attemptId: "a1", turnId: "t1", stepId: "s1", runtimeSnapshotId: "runtime-1",
    model: adapter.model, tools: [], parameters: adapter.defaultParameters ?? {},
  };
  const firstEvents = [];
  for await (const event of adapter.stream({ ...base, messages: [{ role: "user", content: "use tool" }], contentHash: "h1" }, new AbortController().signal)) firstEvents.push(event);
  const first = firstEvents.at(-1);
  assert.equal(first?.type, "final");
  if (first?.type !== "final") throw new Error("missing final event");
  assert.equal((first.providerState?.payload as { reasoningContent?: string }).reasoningContent, "private-chain-state");
  assert.equal(first.content, null);

  const assistant = { role: "assistant" as const, content: first.content, toolCalls: first.toolCalls, providerState: first.providerState };
  for await (const _event of adapter.stream({
    ...base,
    attemptId: "a2",
    messages: [
      { role: "user", content: "use tool" },
      assistant,
      { role: "tool", content: "result", toolCallId: "call-1" },
    ],
    contentHash: "h2",
  }, new AbortController().signal)) { /* consume */ }

  const sentMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(sentMessages[1]?.reasoning_content, "private-chain-state");
  assert.equal(JSON.stringify(sentMessages).includes("providerState"), false);
});

test("DeepSeek adapter normalizes a native DSML text fallback into tool calls", async () => {
  const content = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="lookup">\n<｜｜DSML｜｜parameter name="limit" string="false">10</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="query" string="true">architecture</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    fetch: async () => streamResponse([{ choices: [{ finish_reason: "stop", delta: { content } }] }]),
  });
  const request: PreparedLlmRequest = {
    requestId: "dsml-request", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "runtime",
    model: adapter.model, messages: [{ role: "user", content: "lookup" }], tools: [],
    parameters: adapter.defaultParameters ?? {}, contentHash: "h",
  };
  const events = [];
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  const final = events.at(-1);
  assert.equal(final?.type, "final");
  if (final?.type !== "final") throw new Error("missing final event");
  assert.equal(final.content, null);
  assert.deepEqual(final.toolCalls, [{
    id: "dsml-request:dsml:0", name: "lookup", arguments: '{"limit":10,"query":"architecture"}',
  }]);
});

test("a call envelope the parser cannot read is dropped, never shown as the answer", async () => {
  // A model may call a tool by writing the envelope out, spell the opening tag differently
  // ("<｜｜DSML｜｜ calls>"), and run out of output mid-way. The fragment cannot be parsed into
  // calls, and it must not reach the person as literal opening tags. Markup is not an answer;
  // a step with nothing to say is something the loop already handles.
  const content = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="tool_search"> <｜｜DSML｜｜ parameter name="query" string="true">danh mục đơn vị</';
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    fetch: async () => streamResponse([{ choices: [{ finish_reason: "stop", delta: { content } }] }]),
  });
  const request: PreparedLlmRequest = {
    requestId: "dsml-broken", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "runtime",
    model: adapter.model, messages: [{ role: "user", content: "lookup" }], tools: [],
    parameters: adapter.defaultParameters ?? {}, contentHash: "h",
  };
  const events = [];
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  const final = events.at(-1);
  assert.equal(final?.type, "final");
  if (final?.type !== "final") throw new Error("missing final event");
  assert.equal(final.content, null, "provider markup must not be published as the assistant's reply");
  assert.deepEqual(final.toolCalls, [], "and it is not a call either, because it could not be read as one");
});

test("ordinary text that merely mentions the provider's name is left alone", async () => {
  // The guard keys on the envelope's delimiters, not on the word: an answer discussing DSML is
  // still an answer, and dropping it would be a worse failure than the one being prevented.
  const content = "Định dạng DSML của nhà cung cấp không liên quan tới nghiệp vụ này.";
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    fetch: async () => streamResponse([{ choices: [{ finish_reason: "stop", delta: { content } }] }]),
  });
  const request: PreparedLlmRequest = {
    requestId: "dsml-mention", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "runtime",
    model: adapter.model, messages: [{ role: "user", content: "hỏi" }], tools: [],
    parameters: adapter.defaultParameters ?? {}, contentHash: "h",
  };
  const events = [];
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  const final = events.at(-1);
  if (final?.type !== "final") throw new Error("missing final event");
  assert.equal(final.content, content);
});

/** Synthetic localized content and tool-call deltas preserve fragmented provider markers. */
const K11_FINAL_STEP_DELTAS = ["Đ", "ã", " th", "êm", " NV", "000", " Nh", "â", "n", " Viên", " Mẫu", " ", "123", ".", "000", ".\n\n",
  "<", "｜｜DSML｜｜", " calls", ">\n", "<", "｜｜DSML｜｜", " invoke", " name", "=\"", "sample", "-", "app", "_", "ui", "_n", "avigate", "\">\n",
  "<", "｜｜DSML｜｜", " parameter", " name", "=\"", "expected", "Context", "Revision", "\"", " string", "=\"", "true", "\">", "ui", ".", "30", ".", "4", "sp", "y", "1", "z", "</", "｜｜DSML｜｜", " parameter", ">\n",
  "<", "｜｜DSML｜｜", " parameter", " name", "=\"", "inter", "action", "\"", " string", "=\"", "true", "\">", "click", "</", "｜｜DSML｜｜", " parameter", ">\n",
  "<", "｜｜DSML｜｜", " parameter", " name", "=\"", "label", "\"", " string", "=\"", "true", "\">", "Cu", "ộ", "n", " v", "ùng", " b", "ảng", " ", "1", " xu", "ống", "</", "｜｜DSML｜｜", " parameter", ">\n",
  "<", "｜｜DSML｜｜", " parameter", " name", "=\"", "ref", "\"", " string", "=\"", "true", "\">", "e", "1", "</", "｜｜DSML｜｜", " parameter", ">\n",
  "</", "｜｜DSML｜｜", " invoke", ">\n", "</", "｜｜DSML｜｜", " calls", ">"];

async function streamed(deltas: readonly string[], requestId: string) {
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key", thinking: "enabled",
    fetch: async () => streamResponse([
      ...deltas.map((content) => ({ choices: [{ finish_reason: null, delta: { content } }] })),
      { choices: [{ finish_reason: "stop", delta: {} }] },
    ]),
  });
  const request: PreparedLlmRequest = {
    requestId, attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "runtime",
    model: adapter.model, messages: [{ role: "user", content: "liệt kê" }], tools: [], toolChoice: "none",
    parameters: adapter.defaultParameters ?? {}, contentHash: "h",
  };
  const events = [];
  for await (const event of adapter.stream(request, new AbortController().signal)) events.push(event);
  const final = events.at(-1);
  if (final?.type !== "final") throw new Error("missing final event");
  return { shown: events.flatMap((event) => event.type === "text-delta" ? [event.delta] : []), final };
}

test("a call written out as text never streams to the person, and its real spelling is read as a call", async () => {
  // A reply that left a chat empty: a sentence, then the envelope spelled
  // `<｜｜DSML｜｜ calls>`, token by token. Every token used to reach the chat as it arrived.
  const { shown, final } = await streamed(K11_FINAL_STEP_DELTAS, "k11");
  assert.equal(shown.join(""), "Đã thêm NV000 Nhân Viên Mẫu 123.000.\n\n");
  assert.equal(shown.some((delta) => delta.includes("DSML") || delta.includes("<")), false);
  assert.deepEqual(final.toolCalls, [{
    id: "k11:dsml:0", name: "sample-app_ui_navigate",
    arguments: JSON.stringify({ expectedContextRevision: "ui.30.4spy1z", interaction: "click", label: "Cuộn vùng bảng 1 xuống", ref: "e1" }),
  }]);
  assert.equal(final.status, "tool_calls");
  // Kept as the text beside the call, exactly as with a native call: the loop decides what it is.
  assert.equal(final.content, "Đã thêm NV000 Nhân Viên Mẫu 123.000.");
});

test("a truncated envelope after a sentence is withheld whole: neither the markup nor the sentence is an answer", async () => {
  const deltas = K11_FINAL_STEP_DELTAS.slice(0, 40);
  const { shown, final } = await streamed(deltas, "k11-cut");
  assert.equal(shown.some((delta) => delta.includes("DSML") || delta.includes("<")), false);
  assert.deepEqual(final.toolCalls, []);
  assert.equal(final.content, null);
});

test("text held back as a possible tag start is released when it turns out to be text", async () => {
  const { shown, final } = await streamed(["Mức 700.000 ", "<", " 745.000 nên ", "<", "｜｜", "chọn."], "lt");
  assert.equal(shown.join(""), "Mức 700.000 < 745.000 nên <｜｜chọn.");
  assert.equal(final.content, "Mức 700.000 < 745.000 nên <｜｜chọn.");
});

test("DeepSeek ignores foreign provider state and rejects oversized reasoning", async () => {
  let capturedBody: Record<string, unknown> = {};
  const foreignFetch: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "ok" } }] }]);
  };
  const adapter = new DeepSeekAdapter({ apiKey: "test-key", thinking: "enabled", fetch: foreignFetch });
  const request: PreparedLlmRequest = {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "runtime",
    model: adapter.model,
    messages: [{
      role: "assistant", content: null, toolCalls: [{ id: "c", name: "x", arguments: "{}" }],
      providerState: { providerId: "other", adapterId: "other", adapterVersion: "1", stateVersion: 1, classification: "confidential", payload: { reasoningContent: "do-not-send" } },
    }],
    tools: [], parameters: adapter.defaultParameters ?? {}, contentHash: "h",
  };
  for await (const _event of adapter.stream(request, new AbortController().signal)) { /* consume */ }
  const sent = capturedBody.messages as Array<Record<string, unknown>>;
  assert.equal("reasoning_content" in (sent[0] ?? {}), false);

  const oversized = new DeepSeekAdapter({
    apiKey: "test-key",
    thinking: "enabled",
    maxReasoningContentChars: 3,
    fetch: async () => streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "ok", reasoning_content: "long" } }] }]),
  });
  await assert.rejects(async () => {
    for await (const _event of oversized.stream({ ...request, model: oversized.model }, new AbortController().signal)) { /* consume */ }
  }, /reasoning state exceeds/i);
});

test("DeepSeek plugin snapshot config includes non-secret protocol settings", () => {
  const disabled = createDeepSeekPlugin({ apiKey: "secret", thinking: "disabled" });
  const enabled = createDeepSeekPlugin({ apiKey: "secret", thinking: "enabled" });
  assert.equal(disabled.config?.thinking, "disabled");
  assert.equal(enabled.config?.thinking, "enabled");
  assert.equal(JSON.stringify(enabled.config).includes("secret"), false);
});

test("DeepSeek resolves context metadata for the exact mounted model route", async () => {
  const known = new DeepSeekAdapter({ apiKey: "secret", model: "deepseek-v4-flash" });
  const knownRoute = await known.resolveModel();
  assert.equal(knownRoute.modelId, known.model);
  assert.equal(knownRoute.contextWindowTokens, 1_000_000);
  assert.equal(knownRoute.metadataSource, "adapter-catalog");

  const custom = new DeepSeekAdapter({
    apiKey: "secret", model: "company-deployment",
    modelContext: { contextWindowTokens: 64_000, revision: "control-plane:42" },
  });
  const customRoute = await custom.resolveModel();
  assert.equal(customRoute.contextWindowTokens, 64_000);
  assert.equal(customRoute.metadataSource, "deployment-override");
  assert.equal(customRoute.routeRevision, "control-plane:42");
});

function minimalRequest(adapter: DeepSeekAdapter): PreparedLlmRequest {
  return {
    requestId: "r", attemptId: "a", turnId: "t", stepId: "s", runtimeSnapshotId: "rt",
    model: adapter.model, messages: [{ role: "user", content: "hello" }], tools: [],
    parameters: { ...adapter.defaultParameters, max_tokens: 100 }, contentHash: "hash",
  };
}

test("a turn deadline abort stays a timeout, and a caller abort stays a cancellation", async () => {
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    fetch: async () => { throw new DOMException("The operation was aborted", "AbortError"); },
  });
  const deadline = new AbortController();
  deadline.abort(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  await assert.rejects(
    async () => { for await (const _event of adapter.stream(minimalRequest(adapter), deadline.signal)) { /* consume */ } },
    (error: unknown) => error instanceof AgenticError && error.code === "timeout",
  );
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    async () => { for await (const _event of adapter.stream(minimalRequest(adapter), caller.signal)) { /* consume */ } },
    (error: unknown) => error instanceof AgenticError && error.code === "cancelled",
  );
});


test("a private reasoning limit cancels the upstream stream and carries a typed recovery reason", async () => {
  let cancelled = false;
  const adapter = new DeepSeekAdapter({ apiKey: "test", thinking: "enabled", maxReasoningContentChars: 3,
    fetch: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"long"}}]}\n\n'));
    }, cancel() { cancelled = true; } })) });
  await assert.rejects(async () => {
    for await (const _event of adapter.stream(minimalRequest(adapter), new AbortController().signal)) { /* consume */ }
  }, (error: unknown) => error instanceof AgenticError && error.code === "budget-exceeded" && error.reason === "reasoning-limit");
  assert.equal(cancelled, true);
});


test("a plain recovery's tool call carries explicit empty reasoning into the next thinking request", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new DeepSeekAdapter({ apiKey: "test", thinking: "enabled", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? streamResponse([{ choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0,
      id: "c", function: { name: "audit", arguments: "{}" } }] } }] }])
      : streamResponse([{ choices: [{ finish_reason: "stop", delta: { content: "done" } }] }]);
  } });
  let final;
  for await (const event of adapter.stream({ ...minimalRequest(adapter), parameters: adapter.plainParameters }, new AbortController().signal)) {
    if (event.type === "final") final = event;
  }
  assert.ok(final);
  for await (const _event of adapter.stream({ ...minimalRequest(adapter), messages: [
    { role: "assistant", content: null, toolCalls: final.toolCalls, providerState: final.providerState },
    { role: "tool", toolCallId: "c", content: "source rows audited" },
  ] }, new AbortController().signal)) { /* consume */ }
  const messages = bodies[1]?.messages as Record<string, unknown>[];
  assert.equal(messages[0]?.reasoning_content, "");
});
