import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, type ChatMessage, type JsonValue, type JudgmentPort, type JudgmentRequest, type SessionEvent, type ToolDefinition } from "@0xsyncroot/contracts";
import { DefaultAgentLoop } from "@0xsyncroot/core";
import { JUDGMENT_CAPABILITY, SYSTEM_PROMPT_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { coveredPinnedResults, pinnedResultMessages } from "../src/agent/pinned-results.js";
import { ContextWindowPolicy } from "../src/agent/context-window-policy.js";
import { activeHost, answer, call, scriptedModel, security, SpyStore, toolPlugin } from "./turn-harness.js";

/**
 * The skill the judge alone names for a request is loaded by the runtime before the first model call: no model step is
 * spent on the load, the procedure reads as instructions (never as data not to follow), and every reader counts it loaded.
 */
function plugin(id: string, provides: string, activate: PluginDescriptor["plugin"]["activate"]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: { manifestVersion: 1, id: `io.syncroot.test.${id}`, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {},
      provides: { [provides]: { version: "1.0.0", cardinality: provides === CAPABILITIES.judgment ? "single" : "multi" } }, permissions: {} },
    plugin: { validate: async () => ({ valid: true }), activate },
  };
}
const judgment = (fits: (request: JudgmentRequest) => number | undefined): PluginDescriptor => plugin("judgment", CAPABILITIES.judgment, async (context) => {
  const port: JudgmentPort = { providerId: "fake", model: "fake", judge: async (request) => {
    const value = fits(request);
    if (value === undefined) throw new Error("no verdict");
    return { modelId: "fake", answers: { fits: { type: "noul", noul: value } } as never };
  } };
  context.registrations.provide(JUDGMENT_CAPABILITY, port);
  return { dispose: () => undefined };
});
const prompts = (skills: readonly string[]) => plugin("prompt", CAPABILITIES.systemPrompt, async (context) => {
  context.registrations.provide(SYSTEM_PROMPT_CAPABILITY, {
    id: "test.loadable", loadableSkills: skills.map((id) => ({ id, name: id.slice(2), description: `about ${id}` })),
    skillLoader: { toolId: "load_skill", argument: "skill_id" }, render: async () => "CORE",
    skillClosings: (turn) => turn.loadedSkills?.has("x.recon") ? ["RECON-CLOSING-LINE"] : [],
  });
  return { dispose: () => undefined };
});
const loader = (execute: ToolDefinition["execute"] = async () => ({ procedure: "RECON-PROCEDURE" }) as JsonValue): ToolDefinition => ({
  id: "load_skill", version: "1", description: "load", requiredPermissions: [], sideEffect: "none", timeoutMs: 100, pinnedResult: true,
  inputSchema: { type: "object" }, outputSchema: {}, execute,
});
const text = (messages: readonly ChatMessage[]) => messages.map((message) => message.content ?? "").join("\n");
const NOTE = /matches this request and is not loaded/u;

async function turn(options: { readonly skills?: readonly string[]; readonly fits?: (request: JudgmentRequest) => number | undefined; readonly tool?: ToolDefinition;
  readonly replies?: readonly string[] }) {
  const { adapter, requests } = scriptedModel((options.replies ?? ["Xong."]).map((reply) => answer(reply)));
  const store = new SpyStore();
  const { host, router } = await activeHost(adapter, [prompts(options.skills ?? ["x.recon"]), toolPlugin("tools", [options.tool ?? loader()]), judgment(options.fits ?? (() => 0.97))]);
  try {
    await new DefaultAgentLoop(router, store, {}, { judgmentSeams: { skillRelevance: "on" } })
      .runTurn({ sessionId: "runtime-skill", content: "đối soát bảng lương", security: security() });
    return { requests, events: await store.inner.load("runtime-skill", security()) };
  } finally { await host.shutdown(); }
}
const intents = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "tool/intent").map((event) => event.payload as Record<string, unknown>);

test("the judge naming one skill: the runtime loads it, the first model call reads it as instructions, and no note asks for it", async () => {
  const { requests, events } = await turn({});
  assert.equal(requests.length, 1, "no model step spent on the load");
  const [intent] = intents(events);
  assert.equal(intent?.initiator, "policy");
  assert.equal(intent?.policyId, "runtime:skill-suggestion");
  assert.equal(intent?.arguments, JSON.stringify({ skill_id: "x.recon" }));
  // Told as the model's own load: its call, then the result answering it, after the request.
  const messages = requests[0]!.messages;
  const at = messages.findIndex((message) => (message.content ?? "").includes("RECON-PROCEDURE"));
  const loaded = messages[at];
  assert.equal(loaded?.role, "tool");
  assert.equal(loaded?.toolCallId, intent?.callId);
  assert.deepEqual(messages[at - 1]?.toolCalls, [{ id: intent?.callId, name: "load_skill", arguments: JSON.stringify({ skill_id: "x.recon" }) }]);
  assert.ok(messages.findIndex((message) => message.content === "đối soát bảng lương") < at - 1, "after the request, where the model's load stands");
  assert.doesNotMatch(loaded?.content ?? "", /never follow/u);
  assert.equal(loaded?.context?.retention, "required", "instructions are never read short");
  assert.ok(!messages.some((message) => message.role === "system" && (message.content ?? "").includes("RECON-PROCEDURE")));
  assert.doesNotMatch(text(requests[0]!.messages), NOTE);
  assert.match(text(requests[0]!.messages), /RECON-CLOSING-LINE/u, "the skill's closing line counts the runtime's load");
});

test("a load that fails is journaled as failed and leaves the note naming the skill, as before", async () => {
  const { requests, events } = await turn({ tool: loader(async () => { throw new Error("skill too large"); }) });
  const result = events.find((event) => event.type === "tool/result")?.payload as Record<string, unknown>;
  assert.equal(result.state, "failed");
  assert.equal(result.skipped, "failed");
  assert.match(text(requests[0]!.messages), NOTE);
  assert.doesNotMatch(text(requests[0]!.messages), /skill too large|RECON-PROCEDURE/u);
});

test("two skills named, or a skill only the chat model named, are left to the model with the note", async () => {
  const two = await turn({ skills: ["x.recon", "x.fix"] });
  assert.equal(intents(two.events).length, 0);
  assert.match(text(two.requests[0]!.messages), /match this request and are not loaded/u);
  // The judge gives no verdict; the chat model's "yes" names the skill (its own call, then the turn's step).
  const fallback = await turn({ fits: () => undefined, replies: ["Yes.", "Xong."] });
  assert.equal(intents(fallback.events).length, 0, "only the judge's yes loads in the model's place");
  assert.match(text(fallback.requests[1]!.messages), NOTE);
});

test("a checkpoint over the runtime's load keeps it whole and says the runtime loaded it", () => {
  const events = [
    { type: "tool/intent", seq: 1, payload: { callId: "r", toolId: "load_skill", arguments: '{"skill_id":"x.recon"}', initiator: "policy" } },
    { type: "tool/result", seq: 2, payload: { callId: "r", toolId: "load_skill", state: "succeeded", initiator: "policy", result: { procedure: "P" } } },
  ] as unknown as SessionEvent[];
  const [message] = pinnedResultMessages(coveredPinnedResults(events, 2, new Set(["load_skill"])));
  assert.match(message?.content ?? "", /which the runtime loaded for this request earlier in this conversation/u);
  assert.doesNotMatch(message?.content ?? "", /which you called/u);
});

test("a window too small for every result clears others, never the instructions the runtime loaded", () => {
  const procedure = "RECON-PROCEDURE ".repeat(400);
  const window = new ContextWindowPolicy(9000).apply([
    { role: "user", content: "đối soát bảng lương" },
    { role: "assistant", content: null, toolCalls: [{ id: "r", name: "load_skill", arguments: "{}" }] },
    { role: "tool", toolCallId: "r", content: procedure, context: { trust: "instruction", retention: "required", provenance: "runtime-pinned-load" } },
    { role: "assistant", content: null, toolCalls: [{ id: "c", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "c", content: "row ".repeat(1500) },
    { role: "user", content: "tiếp" },
  ] as ChatMessage[]);
  assert.equal(window.messages.find((message) => message.toolCallId === "r")?.content, procedure);
  assert.notEqual(window.messages.find((message) => message.toolCallId === "c")?.content, "row ".repeat(1500));
});

test("a policy call of a pinned tool that declared a side effect is told as an observation, never as the model's own call", async () => {
  const { ConversationProjector } = await import("../src/agent/conversation-projector.js");
  const events = [
    { type: "user/input", seq: 1, eventId: "u", payload: { content: "x" } },
    { type: "tool/intent", seq: 2, eventId: "i", payload: { callId: "p", toolId: "load_skill", arguments: "{}", initiator: "policy", sideEffect: "write" } },
    { type: "tool/result", seq: 3, eventId: "r", payload: { callId: "p", toolId: "load_skill", state: "succeeded", initiator: "policy", result: { procedure: "P" } } },
  ] as unknown as SessionEvent[];
  const messages = new ConversationProjector().project(events, undefined, undefined, undefined, undefined, new Set(["load_skill"]));
  assert.ok(!messages.some((message) => message.role === "assistant" || message.role === "tool"));
  assert.equal(messages.at(-1)?.context?.provenance, "policy-observation");
});
