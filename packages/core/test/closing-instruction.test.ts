import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, LlmToolChoice, ToolDefinition, TurnControlPolicy } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { closingMessage, DEFAULT_STEP_CALLS_INSTRUCTION } from "../src/agent/step-instruction.js";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * A product's closing instruction is the last thing in every request, after the conversation and every tool
 * result: the one place a rule holds against everything said before it (without one, a conversation drifts into
 * the language of a single narration). Core's step-calls line comes right before it, in the same last message, on every
 * step that offers tools: never after the closing instruction, never changing from step to step.
 */
const STEP_CALLS = DEFAULT_STEP_CALLS_INSTRUCTION;
const readTool: ToolDefinition = {
  id: "test_read", version: "1", description: "read", requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
  inputSchema: { type: "object" }, outputSchema: {}, execute: async () => ({ rows: 3, note: "English tool text" }) as JsonValue,
};

test("the closing instruction ends every request, before and after tool results, with the step-calls line right before it", async () => {
  const CLOSING = "Viết mọi câu gửi người dùng bằng tiếng Việt.";
  const { adapter, requests } = scriptedModel([call("c1", "test_read", {}), answer("Đã đọc 3 dòng.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [readTool])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { modelInstructions: { closingInstruction: CLOSING } })
      .runTurn({ sessionId: "closing", content: "đọc bảng", security: security() });
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(request.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}`, "last in the request");
    for (const request of requests) assert.equal(request.messages.at(-1)?.content?.split("\n").at(-1), CLOSING, "the closing instruction is the last line");
    assert.ok(requests[1]!.messages.some((message) => message.role === "tool"), "the second request carries the tool result before it");
  } finally { await host.shutdown(); }
});

test("a skill's closing line ends the request while the skill is in effect in the task, after the closing instruction", async () => {
  // A skill's one line read last keeps a rule the rest of the prompt loses. Core knows nothing of the line's words: a
  // prompt provider says which are in effect.
  const { CAPABILITIES } = await import("@0xsyncroot/contracts");
  const { SYSTEM_PROMPT_CAPABILITY } = await import("@0xsyncroot/plugin-sdk");
  const { writeTool } = await import("./turn-harness.js");
  const seen: { readonly loaded: readonly string[]; readonly skipped: readonly string[] }[] = [];
  const prompt = {
    id: "skills", skillLoader: { toolId: "skill_load", argument: "skill_id" },
    render: async () => "SYSTEM",
    skillClosings: (turn: { readonly loadedSkills: ReadonlySet<string>; readonly skippedSkills?: ReadonlySet<string> }) => {
      seen.push({ loaded: [...turn.loadedSkills], skipped: [...(turn.skippedSkills ?? [])] });
      return turn.loadedSkills.has("x.recon") ? ["Each cause group with its difference."] : [];
    },
  };
  const promptPlugin = {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: "io.syncroot.test.skills-prompt", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:skills-prompt", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.systemPrompt]: { version: "1.0.0", cardinality: "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate: async (context: { registrations: { provide: (token: unknown, value: unknown) => void } }) => {
      context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, prompt);
      return { dispose: () => undefined };
    } },
  } as never;
  const skillLoad: ToolDefinition = { ...readTool, id: "skill_load", execute: async () => ({ id: "x.recon", instructions: "RECON RULES" }) as JsonValue };
  const CLOSING = "Write every sentence for the user in their language.";
  const LINE = "Each cause group with its difference.";
  const { adapter, requests } = scriptedModel([
    call("s1", "skill_load", { skill_id: "x.recon" }), call("w1", "test_write", { value: "a" }), answer("Report."), answer("Unrelated."),
  ]);
  const { host, router } = await activeHost(adapter, [promptPlugin, toolPlugin("tools", [skillLoad, readTool, writeTool()])]);
  try {
    const agent = new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 6 }, { modelInstructions: { closingInstruction: CLOSING } });
    const principal = security({ permissions: new Set(["test.write"]) });
    const paused = await agent.runTurn({ sessionId: "skill-closing", content: "reconcile the payroll", security: principal });
    assert.equal(paused.outcome, "awaiting_approval");
    assert.equal(requests[0]!.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}`, "before the skill is loaded: no skill line");
    assert.equal(requests[1]!.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}\n${LINE}`, "the step after the load: the skill's line, after the closing, in the same last message");
    const resumed = await agent.resumeTurn({ sessionId: "skill-closing", approvalId: paused.approval!.approvalId, decision: "approve", security: principal, idempotencyKey: "ok" });
    assert.equal(resumed.content, "Report.");
    assert.equal(requests[2]!.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}\n${LINE}`, "the task resumed after the approval: still in effect");
    await agent.runTurn({ sessionId: "skill-closing", content: "what day is it?", security: principal });
    assert.equal(requests[3]!.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}`, "a new request is a new task: the earlier load is not its procedure");
    assert.equal(requests.filter((request) => JSON.stringify(request.messages.slice(0, -1)).includes(LINE)).length, 0, "the line is nowhere else in any request");
    assert.deepEqual(seen.at(-1), { loaded: [], skipped: [] });
  } finally { await host.shutdown(); }
});

test("a composition's own wording replaces the step-calls line, byte-identical on every step and the only one in the request", async () => {
  const CLOSING = "Viết mọi câu gửi người dùng bằng tiếng Việt.";
  const OWN = "Gửi ngay trong bước này mọi lệnh đã biết đủ tham số.";
  const { adapter, requests } = scriptedModel([call("c1", "test_read", {}), call("c2", "test_read", { page: 2 }), answer("Đã đọc 6 dòng.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [readTool])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), {}, { modelInstructions: { closingInstruction: CLOSING, stepCallsInstruction: OWN } })
      .runTurn({ sessionId: "own-wording", content: "đọc bảng", security: security() });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      const last = request.messages.at(-1)!;
      assert.equal(last.content, `${OWN}\n${CLOSING}`, "the composition's line, then its closing instruction");
      assert.equal(last.context?.provenance, "agent-loop:language", "kept at the tail as a step instruction");
      const text = JSON.stringify(request.messages);
      assert.equal(text.split(OWN).length - 1, 1, "said once, at the tail, never left behind in the conversation");
      assert.ok(!text.includes(STEP_CALLS), "core's English line is replaced, not added");
    }
  } finally { await host.shutdown(); }
});

test("without a closing instruction the step-calls line alone ends a request that offers tools", async () => {
  const { adapter, requests } = scriptedModel([call("c1", "test_read", {}), answer("Read 3 rows.")]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [readTool])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore()).runTurn({ sessionId: "no-closing", content: "read the table", security: security() });
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(request.messages.at(-1)?.content, STEP_CALLS);
  } finally { await host.shutdown(); }
});

test("the turn's last step carries the closing instruction without the step-calls line, even when it offers a tool that asks", async () => {
  // Inviting more calls on the last step contradicts its own instruction not to continue the task.
  const askTool: ToolDefinition = { ...readTool, id: "test_ask", asksUser: true, execute: async () => ({ asked: true }) as JsonValue };
  const CLOSING = "Write every sentence for the user in their language.";
  const { adapter, requests } = scriptedModel([(request) => request.tools.some((tool) => tool.name === "test_read")
    ? call(`r${request.messages.length}`, "test_read", { at: request.messages.length })()
    : answer("Read what there was.")()]);
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [readTool, askTool])]);
  try {
    const result = await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 2, initialStepBudget: 2 }, { modelInstructions: { closingInstruction: CLOSING } })
      .runTurn({ sessionId: "last-step", content: "read everything", security: security() });
    const last = requests.at(-1)!;
    assert.deepEqual(last.tools.map((tool) => tool.name), ["test_ask"], "the last step offers only the asking tool");
    assert.equal(last.messages.at(-1)?.content, CLOSING, "no line inviting more calls on the last step");
    assert.equal(requests[0]!.messages.at(-1)?.content, `${STEP_CALLS}\n${CLOSING}`, "an ordinary step has it");
    assert.equal(result.content, "Read what there was.");
  } finally { await host.shutdown(); }
});

/** A step that may call only the tool it names gets the closing instruction alone: the step-calls line would invite more calls. */
test("a step with a named tool choice offers the tool but not the step-calls line", async () => {
  const CLOSING = "Write every sentence for the user in their language.";
  const { adapter, requests } = scriptedModel([call("c1", "test_read", {})], { toolChoice: true });
  const policy: TurnControlPolicy = {
    id: "test.choice", revision: "v1",
    beforeModelStep: async () => ({ allowedToolIds: ["test_read"], toolChoice: { name: "test_read" } }),
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const { host, router } = await activeHost(adapter, [toolPlugin("read", [readTool])]);
  try {
    await new DefaultAgentLoop(router, new SpyStore(), { maxSteps: 3 }, { turnControlPolicy: policy, modelInstructions: { closingInstruction: CLOSING } })
      .runTurn({ sessionId: "named-choice", content: "read it", security: security() });
    const first = requests[0]!;
    assert.deepEqual(first.tools.map((tool) => tool.name), ["test_read"], "the step offers the tool");
    assert.deepEqual(first.toolChoice, { name: "test_read" });
    assert.equal(first.messages.at(-1)?.content, CLOSING, "no line inviting calls beside the choice");
    assert.ok(!JSON.stringify(first.messages).includes(STEP_CALLS));
  } finally { await host.shutdown(); }
});

test("the step-calls line is left out for tool choice none even when tools are offered, and kept for auto and required", () => {
  const CLOSING = "Write every sentence for the user in their language.";
  const tools = [readTool];
  const tail = (toolChoice?: LlmToolChoice) => closingMessage({ closingInstruction: CLOSING }, { tools, ...(toolChoice ? { toolChoice } : {}) })?.content;
  assert.equal(tail("none"), CLOSING);
  assert.equal(tail({ name: "test_read" }), CLOSING);
  for (const choice of [undefined, "auto", "required"] as const) assert.equal(tail(choice), `${STEP_CALLS}\n${CLOSING}`, String(choice));
});

test("the step-calls line says the answer goes with no call and the runtime closes the plan, naming no tool", () => {
  // Read last, "every call you know" otherwise covers the plan's marks once the work is done: a reply of marks alone, then the answer.
  assert.match(STEP_CALLS, /Once no call is left to send, answer with no call at all, plan updates included: the runtime closes the plan's steps from the results\./u);
  assert.doesNotMatch(STEP_CALLS, /plan_update|plan_mark|_[a-z]+\(/u);
});
