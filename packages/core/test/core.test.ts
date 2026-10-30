import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoLlmPlugin, createEchoToolPlugin } from "@0xsyncroot/adapter-echo";
import type { JsonValue } from "@0xsyncroot/contracts";
import { boundToolResult } from "../src/agent/tool-result-bounds.js";
import { JsonSchemaToolInputValidator } from "../src/agent/tool-input-validator.js";
import { createSilenceWatch } from "../src/agent/claimed-turn.js";
import { StepBudget } from "../src/agent/step-budget.js";
import { stepBudgetNotice } from "../src/agent/step-budget-notice.js";

/** Whether a step must answer: at the allowance edge (`offer` in turn-end.ts). */
const isFinalStep = (budget: StepBudget, stepIndex: number): boolean => stepIndex >= budget.granted;
import { budgetFinal } from "../src/agent/llm-finish-policy.js";
import { agenticError } from "../src/agent/error-classifier.js";
import {
  AgenticError,
  CAPABILITIES,
  CORE_EVENT_REGISTRY,
  TOOL_EXECUTION_RESPONSE_PROTOCOL,
  assertValidCoreEventDraft,
  turnContextSnapshotEventType,
  type ApprovalPresentation,
  type AgentOutputEvent,
  type AgentProgressEvent,
  type AgentTelemetryEvent,
  type LlmAdapter,
  type LlmStreamEvent,
  type MemoryService,
  type RuntimeSnapshot,
  type SessionEvent,
  type SecurityContext,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolExecutionBroker,
  type TurnControlPolicy,
  type TurnContextProvider,
  type TurnAdmissionController,
  type TurnAdmissionSettlement,
  type WorkPlanningProvider,
  type WorkPlanProposal,
} from "@0xsyncroot/contracts";
import { ConfiguredContextCompactionPolicy, DefaultAgentLoop, DeterministicConversationCompactor, InMemoryToolResultSpool, InMemoryTurnAdmissionController, PermissionToolExecutionPolicy, PluginHost, TenantRuntimeRouter, validContextCheckpoint } from "@0xsyncroot/core";
import { InMemoryMemoryService, InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { TOOL_CAPABILITY, WORK_PLANNING_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import {
  BaseMemoryContextPolicy,
  createReadResultTool,
  createReadResultToolPlugin,
  createMemoryPlugin,
  createSystemPromptPlugin,
} from "@0xsyncroot/plugins-base";
import { ContextWindowPolicy } from "../src/agent/context-window-policy.js";
import { resolveTurnDirective, toolChoiceViolation, validateTerminalDecision } from "../src/agent/turn-control.js";
import { reviewTurnOutput } from "../src/agent/turn-output-review.js";
import { resolveAgentOptions } from "../src/agent/agent-options.js";
import { snapshotRunTurnInput } from "../src/agent/run-turn-input-policy.js";
import { ToolExecutionCoordinator } from "../src/agent/tool-execution-coordinator.js";
import { WorkStateTracker } from "../src/agent/work-state-tracker.js";
import { sha256 } from "../src/hash.js";

function security(tenantId = "tenant-a", actorId = "user-a"): SecurityContext {
  return {
    tenantId,
    actorId,
    permissions: new Set(["memory.read", "memory.propose", "memory.forget", "tool.echo"]),
    correlationId: crypto.randomUUID(),
    purpose: "test",
  };
}

function runtimeSnapshot(): RuntimeSnapshot {
  return {
    id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test",
    policyRevision: "test-policy", memoryPolicyRevision: "test-memory", createdAt: new Date().toISOString(),
  };
}

test("durable assistant narration is explicit, user-addressed and non-empty", () => {
  assert.doesNotThrow(() => assertValidCoreEventDraft({
    type: "assistant/narration", turnId: "turn-narration",
    payload: { narrationId: "narration-1", audience: "user", content: "Tôi đang kiểm tra dữ liệu." },
  }));
  assert.throws(() => assertValidCoreEventDraft({
    type: "assistant/narration", turnId: "turn-narration",
    payload: { narrationId: "narration-1", audience: "internal", content: "private" },
  }), /audience user/);
});

test("core event registry validates newly owned event envelopes", () => {
  assert.equal(Object.isFrozen(CORE_EVENT_REGISTRY), true);
  assert.equal(Object.isFrozen(CORE_EVENT_REGISTRY["turn/start"]), true);
  assert.throws(() => assertValidCoreEventDraft({
    type: "request/prepared", turnId: "turn-1", payload: {},
  }), /requires stepId/);
  assert.throws(() => assertValidCoreEventDraft({
    type: "model/route-selected", turnId: "turn-1",
    payload: {
      providerId: "provider", adapterId: "adapter", modelId: "model",
      routeRevision: "route-v1", metadataSource: 123,
    },
  }), /complete resolved route/);
  assert.doesNotThrow(() => assertValidCoreEventDraft({
    type: "turn/control-decision", turnId: "turn-1", stepId: "step-1",
    payload: { policyId: "test.control", policyRevision: "v1", phase: "terminal", decision: "accept" },
  }));
  assert.throws(() => assertValidCoreEventDraft({
    type: "turn/control-decision", turnId: "turn-1", stepId: "step-1",
    payload: { policyId: "", policyRevision: "v1", phase: "terminal", decision: "accept" },
  }), /policy identity/);
});

async function activeHost() {
  const host = new PluginHost();
  const memory = new InMemoryMemoryService();
  await host.activate(
    [createMemoryPlugin(memory), createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin()],
    {
      security: security(),
      verifyArtifact: async ({ manifest }) => manifest.artifact.digest.startsWith("builtin:"),
    },
  );
  return { host, memory };
}

function routedHost(host: PluginHost, tenantId = "tenant-a", agentProfileId = "default") {
  return new TenantRuntimeRouter([{
    tenantId, agentProfileId, provider: host, routeRevision: "test-route-v1",
  }]);
}

test("wildcard permission is honored by direct memory service guards", async () => {
  const memory = new InMemoryMemoryService();
  const wildcardSecurity = { ...security(), permissions: new Set(["*"]) };
  const result = await memory.search({
    text: "demo",
    scopes: [{ tenantId: wildcardSecurity.tenantId, type: "tenant", id: wildcardSecurity.tenantId }],
    limit: 1,
  }, wildcardSecurity);
  assert.deepEqual(result.records, []);
});

test("work state fingerprints observations and reports repeated evidence without blocking", () => {
  const tracker = new WorkStateTracker();
  assert.equal(tracker.observe({ result: { evidence: "same" } }), "new");
  assert.equal(tracker.observe({ result: { evidence: "same" } }), "repeated");
  assert.equal(tracker.observe({ result: { evidence: "different" } }), "new");
  assert.equal(tracker.observe({ error: { code: "denied" } }), "new");
  assert.equal(tracker.observe({ error: { code: "denied" } }), "repeated");
});

test("turn input policy snapshots permissions and rejects empty security identifiers", () => {
  const permissions = new Set(["tool.echo"]);
  const snapshot = snapshotRunTurnInput({
    sessionId: " session ", content: "hello",
    security: { ...security(), permissions },
    idempotencyKey: " request ",
  });
  permissions.add("later.permission");
  assert.equal(snapshot.sessionId, "session");
  assert.equal(snapshot.idempotencyKey, "request");
  assert.equal(snapshot.security.permissions.has("later.permission"), false);
  assert.equal("add" in snapshot.security.permissions, false);
  assert.equal("identity" in snapshot.security, false);
  // The display identity crosses the boundary a request established it at — only its known,
  // well-formed fields, and a malformed one is dropped rather than failing the turn.
  const identified = snapshotRunTurnInput({
    sessionId: "session", content: "hello",
    security: { ...security(), identity: {
      tenantName: " Tenant A ", userId: "user-1", fullName: "x".repeat(257), role: "admin",
    } as SecurityContext["identity"] },
  });
  assert.deepEqual(identified.security.identity, { tenantName: "Tenant A", userId: "user-1" });
  assert.ok(Object.isFrozen(identified.security.identity));
  const blankIdentity = snapshotRunTurnInput({
    sessionId: "session", content: "hello",
    security: { ...security(), identity: { userId: "   " } },
  });
  assert.equal(blankIdentity.security.identity, undefined, "blank identity fields are omitted");
  assert.throws(() => snapshotRunTurnInput({
    sessionId: " ", content: "hello", security: security(),
  }), /sessionId cannot be empty/);
  assert.throws(() => snapshotRunTurnInput({
    sessionId: "session", content: "hello",
    security: { ...security(), trustedContext: { plan: "basic" } },
    applicationContext: { trusted: { plan: "enterprise" } },
  }), /must come from verified security evidence/);
  const filteredTrusted = snapshotRunTurnInput({
    sessionId: "session", content: "hello",
    security: { ...security(), trustedContext: { plan: "basic", internalRoute: "node-1" } },
    applicationContext: { trusted: { plan: "basic" } },
  });
  assert.deepEqual(filteredTrusted.applicationContext?.trusted, { plan: "basic" });
  assert.throws(() => snapshotRunTurnInput({
    sessionId: "session", content: "hello", agentProfileId: "write-agent",
    security: { ...security(), authorizedAgentProfiles: ["read-agent"] },
  }), /not authorized/);
});

test("runtime rejects a work-planning capability whose tool is not mounted", async () => {
  const definition: ToolDefinition = {
    id: "orphan_planner", version: "1.0.0", description: "orphan",
    inputSchema: {}, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async () => null,
  };
  const provider: WorkPlanningProvider = {
    definition,
    parseProposal: (value) => value as unknown as WorkPlanProposal,
  };
  const descriptor: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.orphan-planner", version: "1.0.0",
      publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:orphan", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.workPlanning]: { version: "1.0.0", cardinality: "single" } },
      permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        context.registrations.provide(WORK_PLANNING_CAPABILITY, provider);
        return { dispose: () => undefined };
      },
    },
  };
  const host = new PluginHost();
  await host.activate([descriptor, createEchoLlmPlugin()], { security: security(), verifyArtifact: async () => true });
  await assert.rejects(new DefaultAgentLoop(routedHost(host), new InMemorySessionStore()).runTurn({
    sessionId: "orphan-planner", content: "test", security: security(),
  }), /provider tool is not mounted/);
  await host.shutdown();
});

test("blank harness persists request/prepared before the assistant response", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions);
  const result = await agent.runTurn({
    sessionId: "session-1", content: "xin chào",
    security: { ...security(), trustedContext: { companyName: "Tenant A" } },
    applicationContext: { untrusted: { screen: "invoice", invoiceId: "INV-42" } },
  });
  assert.equal(result.content, "[echo] xin chào");
  const types = result.events.map((event) => event.type);
  assert.ok(types.indexOf("request/prepared") < types.indexOf("assistant/message"));
  assert.equal(types[0], "turn/start");
  assert.equal(types[1], "application/context");
  assert.deepEqual(result.events[1]?.payload, {
    trusted: { companyName: "Tenant A" }, untrusted: { screen: "invoice", invoiceId: "INV-42" },
  });
  assert.equal(types.at(-1), "turn/end");
  assert.equal(types.filter((type) => type === "step/start").length, 1);
  assert.equal(types.filter((type) => type === "step/end").length, 1);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(types.filter((type) => type === "usage/recorded").length, 1);
  assert.ok(result.events.every((event, index) => event.seq === index + 1));
  await host.shutdown();
});

test("attachments are journaled as a manifest, and a turn with none is unaffected", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions);
  const attachments = [
    { id: "doc_1", name: "Budget.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 49_152, source: "picker" as const },
    { id: "doc_2", name: "notes.txt", mediaType: "text/plain", byteSize: 512 },
  ];
  const result = await agent.runTurn({
    sessionId: "session-attachments", content: "check this", security: security(), attachments,
  });
  // The manifest is its own untrusted message ahead of the user's words (proven at the projector
  // level, see conversation-joins.test.ts), so the echo model — which answers with only the very
  // last user message — still answers about exactly what the user typed.
  assert.equal(result.content, "[echo] check this");
  const inputEvent = result.events.find((event) => event.type === "user/input");
  assert.deepEqual(inputEvent?.payload, {
    content: "check this", source: "external",
    attachments: [
      { id: "doc_1", name: "Budget.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 49_152, source: "picker" },
      { id: "doc_2", name: "notes.txt", mediaType: "text/plain", byteSize: 512 },
    ],
  });
  // A turn with no attachments is byte-identical to before this feature: no attachments key at all.
  const plain = await agent.runTurn({ sessionId: "session-plain", content: "no files here", security: security() });
  assert.equal(plain.content, "[echo] no files here");
  const plainInputEvent = plain.events.find((event) => event.type === "user/input");
  assert.deepEqual(plainInputEvent?.payload, { content: "no files here", source: "external" });
  await host.shutdown();
});

test("committed provider usage is durable, replayable and settled through admission", async () => {
  const metered: LlmAdapter = {
    id: "metered-test", model: "metered-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "final", content: "metered", toolCalls: [], finishReason: "stop", usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 } };
    },
  };
  let settlement: TurnAdmissionSettlement | undefined;
  const admission: TurnAdmissionController = {
    productionSafe: false,
    acquire: async () => ({
      admissionId: "metered-admission", revision: "metered-v1",
      settle: async (value) => { settlement = value; },
    }),
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoLlmPlugin(metered)], {
    security: security(), verifyArtifact: async () => true,
  });
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions, {}, { admissionController: admission });
  const input = { sessionId: "metered-session", content: "measure", security: security(), idempotencyKey: "metered-key" };
  const result = await agent.runTurn(input);
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  assert.deepEqual(settlement, { outcome: "completed", usage: result.usage });
  assert.equal(result.events.filter((event) => event.type === "usage/recorded").length, 1);
  const replay = await agent.runTurn(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.usage, result.usage);
  assert.equal(replay.events.filter((event) => event.type === "usage/recorded").length, 1);
  await host.shutdown();
});

test("tenant runtime router resolves exact tenant/profile and fails closed", async () => {
  const { host } = await activeHost();
  const router = new TenantRuntimeRouter([{
    tenantId: "tenant-a", agentProfileId: "support", provider: host, routeRevision: "support-route-v7",
  }]);
  const lease = router.acquireRuntime({ security: security(), agentProfileId: "support" });
  assert.equal(lease.snapshot.id, host.snapshot.id);
  assert.deepEqual(lease.binding, {
    tenantId: "tenant-a",
    agentProfileId: "support",
    routeRevision: "support-route-v7",
    runtimeSnapshotId: host.snapshot.id,
  });
  assert.equal(Object.isFrozen(lease.binding), true);
  router.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "support", provider: host, routeRevision: "support-route-v8",
  }]);
  assert.equal(lease.binding.routeRevision, "support-route-v7");
  const replacementLease = router.acquireRuntime({ security: security(), agentProfileId: "support" });
  assert.equal(replacementLease.binding.routeRevision, "support-route-v8");
  lease.release();
  replacementLease.release();
  assert.throws(() => router.acquireRuntime({ security: security("tenant-b"), agentProfileId: "support" }), /No runtime is assigned/);
  assert.throws(() => router.acquireRuntime({ security: security(), agentProfileId: "default" }), /No runtime is assigned/);
  router.replaceRoutes([]);
  assert.throws(() => router.acquireRuntime({ security: security(), agentProfileId: "support" }), /No runtime is assigned/);
  await host.shutdown();
});

test("tenant runtime router rejects malformed snapshot sources without leaking acquired leases", async () => {
  const { host } = await activeHost();
  let releases = 0;
  const router = new TenantRuntimeRouter([{
    tenantId: "tenant-a",
    agentProfileId: "default",
    routeRevision: "malformed-route-v1",
    provider: {
      acquireSnapshot: () => ({
        snapshot: { ...host.snapshot, id: " " },
        capabilities: host.capabilities,
        release: () => { releases += 1; },
      }),
    },
  }]);
  assert.throws(() => router.acquireRuntime({ security: security() }), /snapshot ID/i);
  assert.equal(releases, 1);
  assert.throws(() => router.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: {} as never, routeRevision: "invalid-source-v1",
  }]), /requires a snapshot source/i);
  assert.throws(() => router.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: " ",
  }]), /routeRevision cannot be empty/i);
  await host.shutdown();
});

test("long conversations create durable bounded checkpoints and emit balanced telemetry", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const telemetry: AgentTelemetryEvent[] = [];
  const agent = new DefaultAgentLoop(routedHost(host), sessions, {}, {
    conversationCompactor: new DeterministicConversationCompactor(2),
    contextCompactionPolicy: new ConfiguredContextCompactionPolicy({
      thresholdRatio: 0.001, retainRatio: 0.0005, estimatedCharsPerToken: 3,
    }),
    telemetry: { record: (event) => { telemetry.push(event); } },
  });
  for (let index = 1; index <= 4; index += 1) {
    await agent.runTurn({
      sessionId: "long-session", content: `message ${index}`, security: security(), idempotencyKey: `long-${index}`,
    });
  }
  const all = await sessions.load("long-session", security());
  const view = await sessions.loadContext("long-session", security());
  const checkpoint = [...all].reverse().find((event) => event.type === "context/checkpoint");
  assert.ok(checkpoint);
  assert.ok(view.events.length <= InMemorySessionStore.MAX_CONTEXT_EVENTS);
  assert.equal(view.checkpoint?.eventId, checkpoint.eventId);
  assert.equal(typeof (checkpoint.payload as Record<string, unknown>).summaryHash, "string");
  assert.equal((checkpoint.payload as Record<string, unknown>).providerId, "echo");
  assert.equal((checkpoint.payload as Record<string, unknown>).maxContextChars, 120_000);
  assert.equal((checkpoint.payload as Record<string, unknown>).routeRevision, "echo-local-v1");
  assert.equal(telemetry.filter((event) => event.type === "agent.operation.started").length, 4);
  assert.equal(telemetry.filter((event) => event.type === "agent.operation.finished").length, 4);
  await host.shutdown();
});

test("conversation compaction never separates a tool call from its later approval result", async () => {
  const owner = security();
  const events: SessionEvent[] = [];
  const add = (type: string, turnId: string, payload: Record<string, unknown>, callId?: string) => {
    const seq = events.length + 1;
    events.push({
      eventId: `event-${seq}`, sessionId: "causal-session", seq, type, schemaVersion: 1,
      occurredAt: new Date(0).toISOString(), recordedAt: new Date(0).toISOString(),
      tenantId: owner.tenantId, actorId: owner.actorId, correlationId: owner.correlationId,
      runtimeSnapshotId: "runtime-test", classification: "internal", payload,
      turnId, ...(callId ? { callId } : {}), integrityHash: `hash-${seq}`,
    });
  };
  add("turn/start", "old", {}); add("user/input", "old", { content: "old" });
  add("assistant/message", "old", { content: "old answer", toolCalls: [] }); add("turn/end", "old", {});
  add("turn/start", "request", {}); add("user/input", "request", { content: "do protected work" });
  add("assistant/message", "request", { content: null, toolCalls: [{ id: "call-1", name: "protected", arguments: "{}" }] });
  add("approval/requested", "request", { callId: "call-1" }, "call-1"); add("turn/end", "request", {});
  add("turn/start", "resume", {}); add("approval/resolved", "resume", { callId: "call-1", decision: "approved" }, "call-1");
  add("tool/result", "resume", { callId: "call-1", toolId: "protected", state: "succeeded" }, "call-1");
  add("assistant/message", "resume", { content: "done", toolCalls: [] }); add("turn/end", "resume", {});
  add("turn/start", "current", {}); add("user/input", "current", { content: "next" });

  const compacted = await new DeterministicConversationCompactor(2).compact({
    events,
    budget: {
      trigger: "pressure", providerId: "test", modelId: "test",
      measuredContextChars: 100_000, maxContextChars: 20_000, targetContextChars: 1_000,
    },
    security: owner,
  });
  assert.ok(compacted);
  assert.equal(compacted.coveredThroughSeq, 4, "only the causally independent old turn may be covered");
  const tail = events.filter((event) => event.seq > compacted.coveredThroughSeq);
  assert.ok(tail.some((event) => event.type === "assistant/message" &&
    Array.isArray((event.payload as Record<string, unknown>).toolCalls)));
  assert.ok(tail.some((event) => event.type === "tool/result" && event.callId === "call-1"));
});

test("conversation compaction preserves operational context, observations and work state", async () => {
  const owner = security();
  const events: SessionEvent[] = [];
  const add = (type: string, turnId: string, payload: Record<string, unknown>) => {
    const seq = events.length + 1;
    events.push({
      eventId: `evidence-${seq}`, sessionId: "evidence-session", seq, type, schemaVersion: 1,
      occurredAt: new Date(0).toISOString(), recordedAt: new Date(0).toISOString(),
      tenantId: owner.tenantId, actorId: owner.actorId, correlationId: owner.correlationId,
      runtimeSnapshotId: "runtime-test", classification: "confidential", payload,
      turnId, integrityHash: `evidence-hash-${seq}`,
    });
  };
  add("turn/start", "old", {});
  add("application/context", "old", { trusted: { scope: "department:a" }, untrusted: { candidate: "case-7" } });
  add("user/input", "old", { content: "process the current case" });
  add("tool/result", "old", { toolId: "discover_cases", state: "succeeded", result: { caseId: "case-7", revision: "r3" } });
  add("work/plan-updated", "old", { goal: "Process case 7", steps: [{ id: "observe", status: "completed" }], updatedAt: "2026-08-25T00:00:00Z" });
  add("assistant/message", "old", { content: "I found case 7", toolCalls: [] });
  add("turn/end", "old", {});
  for (const id of ["recent-a", "recent-b"] as const) {
    add("turn/start", id, {}); add("user/input", id, { content: id });
    add("assistant/message", id, { content: `answer ${id}`, toolCalls: [] }); add("turn/end", id, {});
  }
  const compacted = await new DeterministicConversationCompactor(2).compact({
    events,
    budget: { trigger: "pressure", providerId: "test", modelId: "test", measuredContextChars: 50_000,
      maxContextChars: 10_000, targetContextChars: 4_000 },
    security: owner,
  });
  assert.ok(compacted);
  assert.match(compacted.summary, /Application context snapshot/u);
  assert.match(compacted.summary, /department:a/u);
  assert.match(compacted.summary, /discover_cases.*case-7.*r3/u);
  assert.match(compacted.summary, /Work plan snapshot.*Process case 7/u);
});

test("conversation compaction mentions attached files without repeating the manifest", async () => {
  const owner = security();
  const events: SessionEvent[] = [];
  const add = (type: string, turnId: string, payload: Record<string, unknown>) => {
    const seq = events.length + 1;
    events.push({
      eventId: `attach-${seq}`, sessionId: "attach-session", seq, type, schemaVersion: 1,
      occurredAt: new Date(0).toISOString(), recordedAt: new Date(0).toISOString(),
      tenantId: owner.tenantId, actorId: owner.actorId, correlationId: owner.correlationId,
      runtimeSnapshotId: "runtime-test", classification: "internal", payload,
      turnId, integrityHash: `attach-hash-${seq}`,
    });
  };
  add("turn/start", "old", {});
  add("user/input", "old", {
    content: "review these",
    attachments: [
      { id: "doc_1", name: "a.pdf", mediaType: "application/pdf", byteSize: 2_048 },
      { id: "doc_2", name: "b.pdf", mediaType: "application/pdf", byteSize: 4_096 },
    ],
  });
  add("assistant/message", "old", { content: "ok", toolCalls: [] });
  add("turn/end", "old", {});
  for (const id of ["recent-a", "recent-b"] as const) {
    add("turn/start", id, {}); add("user/input", id, { content: id });
    add("assistant/message", id, { content: `answer ${id}`, toolCalls: [] }); add("turn/end", id, {});
  }
  const compacted = await new DeterministicConversationCompactor(2).compact({
    events,
    budget: { trigger: "pressure", providerId: "test", modelId: "test", measuredContextChars: 50_000,
      maxContextChars: 10_000, targetContextChars: 4_000 },
    security: owner,
  });
  assert.ok(compacted);
  // The ids survive compaction (so a later step can still ask for "doc_2" by name); the rest of
  // the manifest — names, media types, sizes — does not need to.
  assert.match(compacted.summary, /User: review these \[\+2 files: doc_1, doc_2\]/u);
  assert.doesNotMatch(compacted.summary, /a\.pdf/u);
});

test("checkpoint validation rejects changed summaries and incompatible projector revisions", () => {
  const checkpoint = {
    eventId: "checkpoint-1", sessionId: "session", seq: 10, type: "context/checkpoint", schemaVersion: 1,
    occurredAt: new Date(0).toISOString(), recordedAt: new Date(0).toISOString(), tenantId: "tenant-a",
    actorId: "user-a", correlationId: "correlation", runtimeSnapshotId: "runtime", classification: "internal",
    payload: {
      summary: "summary", summaryHash: "invalid", coveredThroughSeq: 8, formatVersion: 1,
      projectorRevision: "conversation-projector-v1", compactorRevision: "deterministic-v2", inputDigest: "digest",
    },
    integrityHash: "hash",
  } as SessionEvent;
  assert.equal(validContextCheckpoint(checkpoint), false);
  const payload = checkpoint.payload as Record<string, unknown>;
  const summaryHash = sha256("summary");
  assert.equal(validContextCheckpoint({ ...checkpoint, payload: { ...payload, summaryHash, projectorRevision: "future-projector" } }), false);
});

test("an invalid future checkpoint falls back to the bounded raw tail", async () => {
  let observedMessages: readonly { readonly content: string | null }[] = [];
  const llm: LlmAdapter = {
    id: "checkpoint-fallback", model: "checkpoint-fallback",
    async *stream(request) {
      observedMessages = request.messages;
      yield { type: "final", content: "context retained", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate([createEchoLlmPlugin(llm)], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  await sessions.append("invalid-checkpoint", 0, [{
    type: "user/input", turnId: "seed-turn", payload: { content: "must remain visible", source: "external" },
  }, {
    type: "context/checkpoint", turnId: "seed-turn", payload: {
      summary: "corrupt future checkpoint", summaryHash: sha256("corrupt future checkpoint"),
      coveredFromSeq: 1, coveredThroughSeq: 99_999, formatVersion: 1,
      projectorRevision: "conversation-projector-v1", compactorRevision: "test", inputDigest: "test",
    },
  }], "invalid-checkpoint-seed", { security: security(), runtime: runtimeSnapshot() });
  await new DefaultAgentLoop(routedHost(host), sessions).runTurn({
    sessionId: "invalid-checkpoint", content: "continue", security: security(), idempotencyKey: "continue",
  });
  assert.equal(observedMessages.some((message) => message.content === "must remain visible"), true);
  await host.shutdown();
});

test("memory is tenant-scoped and model-inferred candidates are quarantined", async () => {
  const memory = new InMemoryMemoryService();
  const owner = security();
  const record = await memory.propose(
    {
      scope: { tenantId: owner.tenantId, type: "actor", id: owner.actorId },
      kind: "semantic",
      content: "Người dùng thích câu trả lời ngắn",
      format: "text",
      classification: "internal",
      sourceRef: "session:event-1",
      authority: "model-inferred",
    },
    owner,
  );
  assert.equal(record.status, "quarantined");
  await assert.rejects(
    memory.search(
      { text: "câu trả lời", scopes: [{ tenantId: "tenant-b", type: "tenant", id: "tenant-b" }], limit: 5 },
      owner,
    ),
    /tenant boundary/i,
  );
});

test("in-memory session events snapshot caller payloads and remain immutable", async () => {
  const store = new InMemorySessionStore();
  const owner = security();
  const payload = { content: "original", source: "test" };
  await store.append("immutable-session", 0, [
    { type: "user/input", turnId: "immutable-turn", payload },
  ], "immutable-input", {
    security: owner,
    runtime: {
      id: "runtime-test", coreVersion: "1.0.0", pluginSetId: "test",
      policyRevision: "test", memoryPolicyRevision: "test", createdAt: new Date().toISOString(),
    },
  });
  payload.content = "mutated";
  const event = (await store.load("immutable-session", owner))[0];
  assert.equal((event?.payload as Record<string, unknown>).content, "original");
  assert.equal(Object.isFrozen(event?.payload), true);
});

test("session append idempotency rejects reusing a key for a different operation", async () => {
  const store = new InMemorySessionStore();
  const owner = security();
  const context = { security: owner, runtime: runtimeSnapshot() };
  const original = [{ type: "extension/test", payload: { value: "original" } }] as const;

  assert.equal(await store.append("idempotent-session", 0, original, "append-key", context), 1);
  assert.equal(await store.append("idempotent-session", 0, original, "append-key", context), 1);
  await assert.rejects(
    store.append("idempotent-session", 0, [
      { type: "extension/test", payload: { value: "changed" } },
    ], "append-key", context),
    /different append operation/i,
  );
});

test("session context reads retain only the newest bounded tail", async () => {
  const store = new InMemorySessionStore();
  const owner = security();
  const drafts = Array.from({ length: InMemorySessionStore.MAX_CONTEXT_EVENTS + 1 }, (_, index) => ({
    type: "extension/context-test",
    payload: { index },
  }));
  await store.append("bounded-context", 0, drafts, "bounded-context-seed", {
    security: owner,
    runtime: runtimeSnapshot(),
  });

  const view = await store.loadContext("bounded-context", owner);
  assert.equal(view.events.length, InMemorySessionStore.MAX_CONTEXT_EVENTS);
  assert.equal(view.events[0]?.seq, 2);
  assert.equal(view.events.at(-1)?.seq, InMemorySessionStore.MAX_CONTEXT_EVENTS + 1);
  assert.equal(view.truncatedBeforeSeq, 2);
  const recent = await store.loadRecent("bounded-context", 10, owner);
  assert.deepEqual(recent.map((event) => event.seq), Array.from({ length: 10 }, (_, index) => 992 + index));
  await assert.rejects(store.loadRecent("bounded-context", 1_001, owner), /limit must be from 1 to 1000/);
});

test("neutral core does not choose memory scopes unless assembly injects a policy", async () => {
  let searches = 0;
  const memory: MemoryService = {
    propose: async () => { throw new Error("not used"); },
    search: async () => {
      searches += 1;
      return { records: [], contextText: "", contextHash: "empty" };
    },
    forget: async () => false,
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(memory), createSystemPromptPlugin(), createEchoLlmPlugin()],
    { security: security(), verifyArtifact: async () => true },
  );
  await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore()).runTurn({
    sessionId: "neutral-memory-policy",
    content: "no implicit scope",
    security: security(),
  });
  assert.equal(searches, 0);

  await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), {}, {
    memoryContextPolicy: new BaseMemoryContextPolicy(),
  }).runTurn({
    sessionId: "base-memory-policy",
    content: "base scope is explicitly mounted",
    security: security(),
  });
  assert.equal(searches, 1);
  await host.shutdown();
});

test("identical session IDs are independent tenant aggregates", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(new TenantRuntimeRouter([
    { tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "shared-route-v1" },
    { tenantId: "tenant-b", agentProfileId: "default", provider: host, routeRevision: "shared-route-v1" },
  ]), sessions);
  await agent.runTurn({ sessionId: "shared-id", content: "one", security: security("tenant-a") });
  await agent.runTurn({ sessionId: "shared-id", content: "two", security: security("tenant-b") });
  const tenantAEvents = await sessions.load("shared-id", security("tenant-a"));
  const tenantBEvents = await sessions.load("shared-id", security("tenant-b"));
  assert.equal(tenantAEvents.find((event) => event.type === "user/input")?.payload.content, "one");
  assert.equal(tenantBEvents.find((event) => event.type === "user/input")?.payload.content, "two");
  await host.shutdown();
});

test("a session is permanently bound to its first routed agent profile", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(new TenantRuntimeRouter([
    { tenantId: "tenant-a", agentProfileId: "read", provider: host, routeRevision: "read-v1" },
    { tenantId: "tenant-a", agentProfileId: "write", provider: host, routeRevision: "write-v1" },
  ]), sessions);
  const owner = { ...security("tenant-a"), authorizedAgentProfiles: ["read", "write"] };

  await agent.runTurn({ sessionId: "profile-bound", content: "read", agentProfileId: "read", security: owner });
  await assert.rejects(
    agent.runTurn({ sessionId: "profile-bound", content: "write", agentProfileId: "write", security: owner }),
    /different agent profile/i,
  );
  await agent.runTurn({ sessionId: "profile-bound", content: "read again", agentProfileId: "read", security: owner });
  await host.shutdown();
});

test("read-only tool calls are intent-logged and fed back to the model", async () => {
  const scripted: LlmAdapter = {
    id: "scripted",
    model: "scripted-test",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      if (hasToolResult) {
        yield { type: "text-delta", delta: "tool " };
        yield { type: "text-delta", delta: "completed" };
        yield { type: "final", content: "tool completed", toolCalls: [], finishReason: "stop" };
      } else {
        yield { type: "text-delta", delta: "checking" };
        yield {
            type: "final",
            content: "checking",
            toolCalls: [{ id: "call-1", name: "agentic_echo", arguments: '{"value":"pong"}' }],
            finishReason: "tool_calls",
        };
      }
    },
  };
  const host = new PluginHost();
  await host.activate(
    [
      createMemoryPlugin(new InMemoryMemoryService()),
      createSystemPromptPlugin(),
      createEchoToolPlugin(),
      createEchoLlmPlugin(scripted),
    ],
    { security: security(), verifyArtifact: async () => true },
  );
  const progress: AgentProgressEvent[] = [];
  const output: AgentOutputEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore()).runTurn({
    sessionId: "tool-session",
    content: "ping",
    security: security(),
    onProgress: (event) => progress.push(event),
    onOutput: (event) => output.push(event),
  });
  assert.equal(result.content, "tool completed");
  assert.equal(result.events.filter((event) => event.type === "request/prepared").length, 2);
  assert.ok(result.events.some((event) => event.type === "tool/intent"));
  assert.ok(result.events.some((event) => event.type === "tool/result"));
  // The dispatch boundary is the one state recovery reads; a "running" row after it said nothing more.
  assert.ok(result.events.some((event) => event.type === "tool/state" && (event.payload as Record<string, unknown>).state === "dispatching"));
  assert.equal(result.events.some((event) => event.type === "tool/state" && (event.payload as Record<string, unknown>).state === "running"), false);
  const toolResult = result.events.find((event) => event.type === "tool/result");
  assert.equal((toolResult?.payload as Record<string, unknown>).state, "succeeded");
  assert.equal((toolResult?.payload as Record<string, unknown>).dispatched, true);
  assert.ok(progress.some((event) => event.type === "tool-started" && event.callId === "call-1" && event.toolId === "agentic_echo"));
  assert.ok(progress.some((event) => event.type === "tool-completed" && event.callId === "call-1" && event.toolId === "agentic_echo" && event.status === "succeeded"));
  assert.ok(progress.some((event) => event.type === "tool-state-changed" && event.callId === "call-1" && event.state === "succeeded"));
  assert.deepEqual(progress.filter((event) => event.type === "step-started").map((event) => event.step), [1, 2]);
  assert.equal(progress.filter((event) => event.type === "content-delta").map((event) => event.delta).join(""), "checkingtool completed");
  assert.equal(progress.filter((event) => event.type === "output-item-delta").map((event) => event.delta).join(""), "checkingtool completed");
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["discarded", "completed"]);
  assert.equal(output.filter((event) => event.type === "assistant-output-delta").map((event) => event.delta).join(""), "checkingtool completed");
  assert.equal(progress.at(-1)?.type, "turn-completed");
  await host.shutdown();
});

test("turn control selects a named tool and rejects a premature terminal draft", async () => {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  let modelCall = 0;
  let sawToolObservation = false;
  let contextProviderCalls = 0;
  const scripted: LlmAdapter = {
    id: "controlled", model: "controlled", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        yield { type: "final", content: null, toolCalls: [{
          id: "controlled-call", name: "agentic_echo", arguments: '{"value":"evidence"}',
        }], finishReason: "tool_calls" };
      } else if (modelCall === 2) {
        yield { type: "text-delta", delta: "premature" };
        yield { type: "final", content: "premature", toolCalls: [], finishReason: "stop", status: "completed" };
      } else {
        yield { type: "text-delta", delta: "done" };
        yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
      }
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.turn-control", revision: "v1",
    beforeModelStep: async (state) => {
      if (state.stepIndex === 2) sawToolObservation = state.context.events.some((event) => event.type === "tool/result");
      return state.stepIndex === 1
        ? { allowedToolIds: ["agentic_echo"], toolChoice: { name: "agentic_echo" } }
        : { allowedToolIds: [] };
    },
    reviewTerminal: async ({ candidate }) => candidate.content === "premature"
      ? { decision: "continue", feedback: "Collect the required evidence before answering." }
      : { decision: "accept", reason: "Evidence is complete" },
  };
  const turnContextProvider: TurnContextProvider = {
    id: "test.turn-state", revision: "v1",
    prepare: async ({ events }) => {
      contextProviderCalls += 1;
      return {
        classification: "internal",
        snapshot: { hasToolResult: events.some((event) => event.type === "tool/result") },
      };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], {
    security: security(), verifyArtifact: async () => true,
  });
  const output: AgentOutputEvent[] = [];
  // One log for both channels: the order a policy's retraction reaches the screen in is the point.
  const timeline: string[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 }, {
    turnControlPolicy: policy,
    turnContextProvider,
  }).runTurn({ sessionId: "controlled-turn", content: "work", security: security(),
    onOutput: (event) => { output.push(event); timeline.push(`output:${event.type}${"status" in event ? `:${event.status}` : ""}`); },
    onProgress: (event) => timeline.push(`progress:${event.type}${"step" in event ? `@${event.step}` : ""}`) });
  assert.equal(result.content, "done");
  assert.equal(sawToolObservation, true);
  assert.deepEqual(requests[0]?.toolChoice, { name: "agentic_echo" });
  assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["agentic_echo"]);
  assert.equal((result.events.find((event) => event.type === "request/prepared")?.payload as Record<string, unknown>).toolChoiceEnforcement, "provider",
    "an adapter that takes the parameter is recorded as enforcing it");
  assert.equal(requests[1]?.tools.length, 0);
  assert.ok(requests[1]?.messages.some((message) => message.context?.provenance === "turn-context:test.turn-state@v1" &&
    /"hasToolResult":true/u.test(message.content ?? "")));
  assert.ok(requests[2]?.messages.some((message) => message.context?.provenance === "turn-context:test.turn-state@v1" &&
    /"hasToolResult":true/u.test(message.content ?? "")));
  assert.ok(requests[2]?.messages.some((message) => message.role === "system" && /required evidence/u.test(message.content ?? "")));
  // The rejected draft travels inside the objection: a system message about a sentence the
  // model can no longer see is feedback it cannot act on. It is not in the journal, so the quote
  // is the only place it appears — and it is never replayed as an assistant turn, which a model
  // would read as text to continue.
  const replay = requests[2]?.messages ?? [];
  const objection = replay.find((message) => message.role === "system" && /required evidence/u.test(message.content ?? ""));
  assert.match(objection?.content ?? "", /withheld from the user[\s\S]*"""\npremature\n"""/u);
  // The trailer names both remedies: an objection can ask for a tool call, and "write the
  // corrected answer" sent a model rewriting three times when one read would have done.
  assert.match(objection?.content ?? "", /with the tool call it asks for, if it asks for one; otherwise with a corrected answer/u);
  assert.equal(replay.filter((message) => (message.content ?? "").includes("premature")).length, 1);
  assert.equal(replay.some((message) => message.role === "assistant" && message.content === "premature"), false);
  // The screen is told the draft is being reconsidered before the draft is taken away.
  const announced = timeline.indexOf("progress:answer-revision-requested@2");
  const retracted = timeline.indexOf("output:assistant-output-end:discarded");
  assert.ok(announced >= 0 && retracted > announced, `retraction was not announced first: ${timeline.join(" → ")}`);
  assert.equal(contextProviderCalls, 3);
  assert.equal(result.events.filter((event) => event.type === turnContextSnapshotEventType("test.turn-state")).length, 2);
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["discarded", "completed"]);
  assert.equal(result.events.filter((event) => event.type === "assistant/message").length, 2);
  assert.equal(result.events.filter((event) => event.type === "usage/recorded").length, 3);
  assert.ok(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).phase === "terminal" && (event.payload as Record<string, unknown>).decision === "continue"));
  await host.shutdown();
});

test("an objection the model ignores twice ends the turn on the fallback, with the withheld answer quoted", async () => {
  let modelCall = 0;
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const scripted: LlmAdapter = {
    id: "stubborn", model: "stubborn", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        yield { type: "final", content: null, toolCalls: [{ id: "c", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: "Kỳ 11/2026" };
      yield { type: "final", content: "Kỳ 11/2026", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.stubborn", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async ({ candidate }) => /11\/2026/u.test(candidate.content ?? "")
      ? { decision: "continue", feedback: "Kỳ 11/2026 không có trong dữ liệu.", fallback: "Dữ liệu chỉ ghi nhận kỳ 08/2026." }
      : { decision: "accept" },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], {
    security: security(), verifyArtifact: async () => true,
  });
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "stubborn-turn", content: "work", security: security(), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, "Dữ liệu chỉ ghi nhận kỳ 08/2026.");
  assert.equal(result.outcome, "partial");
  // Three objections, each sent differently: the objection with the withheld answer quoted; the
  // same plus the policy's fallback as guidance to write from; and only then the fallback itself.
  // A bounced step is refunded — so this ends on the fourth model call, not at the ceiling.
  assert.equal(modelCall, 4);
  assert.deepEqual(progress.filter((event) => event.type === "answer-revision-requested").map((event) => event.step), [2, 3, 4]);
  const secondLap = requests[2]?.messages.find((message) => message.role === "system" && /không có trong dữ liệu/u.test(message.content ?? ""));
  assert.match(secondLap?.content ?? "", /"""\nKỳ 11\/2026\n"""/u, "the first objection quotes the withheld answer");
  assert.doesNotMatch(secondLap?.content ?? "", /sent back again/u, "guidance is not offered before the model has ignored the objection once");
  // Both objections are in the third lap's context; the guidance is on the later one.
  const thirdLap = requests[3]?.messages.filter((message) => message.role === "system" && /không có trong dữ liệu/u.test(message.content ?? "")).at(-1);
  assert.match(thirdLap?.content ?? "", /sent back again[\s\S]*Dữ liệu chỉ ghi nhận kỳ 08\/2026\./u, "the second objection hands over the way out");
  assert.equal(requests[3]?.messages.filter((message) => message.role === "system" && /không có trong dữ liệu/u.test(message.content ?? "")).length, 2,
    "each objection is one message; the earlier one is kept");
  assert.ok(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).decision === "fallback"));
  await host.shutdown();
});

test("a rejected tool call is sent back without announcing an answer under review", async () => {
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "rejected-call", model: "rejected-call",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      if (modelCall === 1) yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"overwrite"}' }], finishReason: "tool_calls" };
      else if (modelCall === 2) yield { type: "final", content: null, toolCalls: [{ id: "c2", name: "agentic_echo", arguments: '{"value":"append"}' }], finishReason: "tool_calls" };
      else { yield { type: "text-delta", delta: "done" }; yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" }; }
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.no-overwrite", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewToolCalls: async ({ toolCalls }) => toolCalls.some((call) => call.arguments.includes("overwrite"))
      ? { decision: "continue", feedback: "Append instead of overwriting.", fallback: "Nothing was changed." }
      : { decision: "accept" },
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "rejected-call", content: "work", security: security(), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, "done");
  assert.equal(result.outcome, "completed");
  assert.ok(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).phase === "tool-call" && (event.payload as Record<string, unknown>).decision === "continue"));
  // No answer was ever on screen, so nothing is announced as being reconsidered.
  assert.equal(progress.some((event) => event.type === "answer-revision-requested"), false);
  assert.equal(modelCall, 3);
  await host.shutdown();
});

test("a tool call rejected three times ends on the fallback, with the way out offered the second time", async () => {
  let modelCall = 0;
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const scripted: LlmAdapter = {
    id: "insistent-call", model: "insistent-call",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      yield { type: "final", content: null, toolCalls: [{ id: `c${modelCall}`, name: "agentic_echo", arguments: '{"value":"overwrite"}' }], finishReason: "tool_calls" };
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.no-overwrite", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewToolCalls: async () => ({ decision: "continue", feedback: "Append instead of overwriting.", fallback: "Nothing was changed." }),
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "insistent-call", content: "work", security: security() });
  assert.equal(result.content, "Nothing was changed.");
  assert.equal(result.outcome, "partial");
  // With no answer to quote, the second objection is the objection plus the guidance.
  const objections = (lap: number) => requests[lap]?.messages.filter((message) => message.role === "system" && /Append instead/u.test(message.content ?? "")) ?? [];
  assert.equal(objections(1).length, 1);
  assert.doesNotMatch(objections(1)[0]?.content ?? "", /sent back again/u);
  assert.equal(objections(2).length, 2);
  assert.match(objections(2)[1]?.content ?? "", /sent back again[\s\S]*Nothing was changed\./u);
  assert.equal(modelCall, 3, "two objections sent back, then the fallback — not the step ceiling");
  await host.shutdown();
});

/** A work-plan tool the way the base plugin mounts one: the provider names it, the tool echoes the plan back. */
function planningPlugin(): PluginDescriptor {
  const definition: ToolDefinition = {
    id: "test_plan_update", version: "1.0.0", description: "plan",
    inputSchema: { type: "object" }, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async (invocation) => ({ ...(invocation.arguments as Record<string, unknown>), updatedAt: "2026-09-14T00:00:00.000Z" }) as never,
  };
  const provider: WorkPlanningProvider = { definition, parseProposal: (value) => value as unknown as WorkPlanProposal };
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.planner", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:planner", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.workPlanning]: { version: "1.0.0", cardinality: "single" }, [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
      permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        context.registrations.provide(WORK_PLANNING_CAPABILITY, provider);
        context.registrations.provide(TOOL_CAPABILITY, definition);
        return { dispose: () => undefined };
      },
    },
  };
}

const PLAN_CALL = { id: "plan-1", name: "test_plan_update", arguments: JSON.stringify({ goal: "Tính lương", steps: [{ id: "confirm", description: "Xác nhận kỳ lương", status: "in_progress" }] }) };
const QUESTION = "Em đề xuất kỳ 08/2026. Anh/chị xác nhận giúp em?";

test("an answer sent together with the plan update is delivered as the answer, reviewed like any other", async () => {
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "answer-with-plan", model: "answer-with-plan",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      if (modelCall === 1) { yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" }; return; }
      // The way the model is told to stop and ask: mark the step it is asking in, and ask.
      yield { type: "text-delta", delta: QUESTION };
      yield { type: "final", content: QUESTION, toolCalls: [PLAN_CALL], finishReason: "tool_calls" };
    },
  };
  const reviewed: string[] = [];
  const policy: TurnControlPolicy = {
    id: "test.answer-review", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async ({ candidate }) => { reviewed.push(candidate.content ?? ""); return { decision: "accept", reason: "grounded" }; },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const output: AgentOutputEvent[] = [];
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "answer-with-plan", content: "Hỗ trợ tôi tính lương", security: security(),
      onOutput: (event) => output.push(event), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, QUESTION);
  assert.equal(result.outcome, "completed");
  assert.equal(modelCall, 2, "the question is the end of the turn, not a step on the way to one");
  // The text the user watched stream in stays; the plan the model attached is published.
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["completed"]);
  assert.ok(progress.some((event) => event.type === "plan-updated"));
  assert.ok(result.events.some((event) => event.type === "work/plan-updated"));
  // And it did not slip past the product's terminal review by riding along with a tool call.
  assert.deepEqual(reviewed, [QUESTION]);
  assert.ok(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).phase === "terminal" && (event.payload as Record<string, unknown>).decision === "accept"));
  assert.equal(progress.some((event) => event.type === "answer-revision-requested"), false);
  await host.shutdown();
});

test("a notice the policy attaches to an accepted answer is streamed, returned and journaled with it", async () => {
  const NOTICE = "Hệ thống đã từ chối thao tác vừa gửi nên chưa có dữ liệu nào được ghi.";
  for (const withPlan of [false, true]) {
    let modelCall = 0;
    const scripted: LlmAdapter = {
      id: `noticed-${String(withPlan)}`, model: "noticed",
      async *stream(): AsyncIterable<LlmStreamEvent> {
        modelCall += 1;
        if (modelCall === 1) { yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" }; return; }
        yield { type: "text-delta", delta: QUESTION };
        yield { type: "final", content: QUESTION, toolCalls: withPlan ? [PLAN_CALL] : [], finishReason: withPlan ? "tool_calls" : "stop", status: "completed" };
      },
    };
    const reviewed: string[] = [];
    const policy: TurnControlPolicy = {
      id: "test.notice", revision: "v1",
      beforeModelStep: async () => ({}),
      // The review sees the model's own answer; the notice is not the model's to be judged on.
      reviewTerminal: async ({ candidate }) => { reviewed.push(candidate.content ?? ""); return { decision: "accept", notice: NOTICE }; },
    };
    const host = new PluginHost();
    await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
    const output: AgentOutputEvent[] = [];
    const sessions = new InMemorySessionStore();
    const result = await new DefaultAgentLoop(routedHost(host), sessions, { maxSteps: 4 }, { turnControlPolicy: policy })
      .runTurn({ sessionId: `noticed-${String(withPlan)}`, content: "Hỗ trợ tôi tính lương", security: security(), onOutput: (event) => output.push(event) });
    const expected = `${QUESTION}\n\n${NOTICE}`;
    assert.equal(result.content, expected, `returned (plan: ${String(withPlan)})`);
    assert.deepEqual(reviewed, [QUESTION]);
    assert.equal(output.filter((event) => event.type === "assistant-output-delta").map((event) => event.delta).join(""), expected,
      "the reader watches the notice arrive in the same output as the answer");
    assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["completed"]);
    const journaled = result.events.filter((event) => event.type === "assistant/message" && event.turnId === result.turnId).at(-1);
    assert.equal((journaled?.payload as Record<string, unknown>).content, expected, "history and replay read what the reader saw");
    await host.shutdown();
  }
  assert.throws(() => validateTerminalDecision({ decision: "accept", notice: " padded " }), /notice/u);
});

test("an answer sent with the plan update that the policy rejects is sent back, plan and all", async () => {
  // Work already dispatched in step 1, so the plan text in step 2 is not the opening narration —
  // it is reviewed exactly like any other answer beside the plan update.
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "answer-with-plan-rejected", model: "answer-with-plan-rejected",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      if (modelCall === 1) { yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" }; return; }
      if (modelCall === 2) { yield { type: "text-delta", delta: "Kỳ 11/2026 đúng không?" }; yield { type: "final", content: "Kỳ 11/2026 đúng không?", toolCalls: [PLAN_CALL], finishReason: "tool_calls" }; return; }
      yield { type: "text-delta", delta: "Kỳ 08/2026 đúng không?" };
      yield { type: "final", content: "Kỳ 08/2026 đúng không?", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.grounding", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async ({ candidate }) => /11\/2026/u.test(candidate.content ?? "")
      ? { decision: "continue", feedback: "Kỳ 11/2026 không có trong dữ liệu.", fallback: "Dữ liệu chỉ ghi nhận kỳ 08/2026." }
      : { decision: "accept" },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), planningPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const output: AgentOutputEvent[] = [];
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 5 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "answer-with-plan-rejected", content: "work", security: security(),
      onOutput: (event) => output.push(event), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, "Kỳ 08/2026 đúng không?");
  assert.equal(result.outcome, "completed");
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["discarded", "completed"]);
  assert.deepEqual(progress.filter((event) => event.type === "answer-revision-requested").map((event) => event.step), [2]);
  assert.ok(result.events.some((event) => event.type === "work/plan-updated"), "the plan the model attached was still published");
  // Usage for the rejected step was journaled with its assistant message; the review must not record it twice.
  assert.equal(result.events.filter((event) => event.type === "usage/recorded").length, modelCall);
  await host.shutdown();
});

test("what a model says beside a tool call reaches the user as it is said; gone silent after, it is asked for its answer without being told its words were lost", async () => {
  let modelCall = 0;
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const scripted: LlmAdapter = {
    id: "silent-after-narration", model: "silent-after-narration",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) { yield { type: "text-delta", delta: QUESTION }; yield { type: "final", content: QUESTION, toolCalls: [{ id: "c1", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" }; return; }
      if (modelCall === 2) { yield { type: "final", content: null, toolCalls: [], finishReason: "stop", status: "completed" }; return; }
      yield { type: "text-delta", delta: QUESTION };
      yield { type: "final", content: QUESTION, toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  // Above the initial allowance: the forced final answer is a step bought inside the ceiling.
  const said: string[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 })
    .runTurn({ sessionId: "silent-after-narration", content: "work", security: security(),
      onNarration: (event) => { if (event.type === "assistant-narration-delta") said.push(event.delta); } });
  // It used to be withdrawn when the call ran, and a silent model was then told its message had
  // not been delivered. It was delivered now, so the model is only asked for its answer — what it
  // said before the call ran is not an account of what the call found.
  assert.deepEqual(said, [QUESTION], "said beside the call, and delivered then");
  assert.equal(result.content, QUESTION);
  assert.equal(result.outcome, "completed");
  assert.equal(modelCall, 3, "one more step, for the answer the turn still owes");
  assert.equal(requests.some((request) => request.messages.some((message) => /was not delivered to the user/u.test(message.content ?? ""))), false,
    "and the model is not told something that is no longer true");
  await host.shutdown();
});

test("everything a model says beside its tool calls is kept as it goes, each one after the last, and the answer is its own", async () => {
  let modelCall = 0;
  const lines = ["Em mở tài liệu trước.", "Tài liệu có 46 biểu, em đọc biểu 18.", "Biểu 18 có 110 nhiệm vụ chi."];
  const scripted: LlmAdapter = {
    id: "narrates-each-step", model: "narrates-each-step",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      const line = lines[modelCall - 1];
      if (modelCall <= 2 && line) {
        yield { type: "text-delta", delta: line };
        yield { type: "final", content: line, toolCalls: [{ id: `c${modelCall}`, name: "agentic_echo", arguments: JSON.stringify({ value: `evidence-${modelCall}` }) }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: lines[2]! };
      yield { type: "final", content: lines[2]!, toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const said: string[] = [];
  const ended: string[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 }).runTurn({
    sessionId: "narrates-each-step", content: "work", security: security(),
    onNarration: (event) => {
      if (event.type === "assistant-narration-delta") said.push(event.delta);
      if (event.type === "assistant-narration-end") ended.push(event.status);
    },
  });
  assert.deepEqual(said, lines.slice(0, 2), "both, in the order they were said: the second did not replace the first");
  assert.deepEqual(ended, ["completed", "completed"]);
  assert.equal(result.content, lines[2], "and the answer is the answer, not one of them");
  assert.deepEqual(result.events.filter((event) => event.type === "assistant/narration").map((event) => (event.payload as { content: string }).content), lines.slice(0, 2),
    "journaled, so a reloaded conversation shows what the agent said while it worked");
  await host.shutdown();
});



test("a tool may declare its own result budget; the runtime cap stays for the rest", async () => {
  // One string, no list to shorten: over the budget this is the one result that still fails.
  const large = "x".repeat(40_000);
  const tool = (id: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    id, version: "1.0.0", description: id, inputSchema: { type: "object" }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 100, execute: async () => ({ text: large }) as never, ...extra,
  });
  const descriptor: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.big-tools", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:big-tools", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        context.registrations.provide(TOOL_CAPABILITY, tool("big_budgeted", { maxResultChars: 48_000 }));
        context.registrations.provide(TOOL_CAPABILITY, tool("big_default"));
        return { dispose: () => undefined };
      },
    },
  };
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "big-tools", model: "big-tools",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      if (modelCall === 1) { yield { type: "final", content: null, toolCalls: [{ id: "a", name: "big_budgeted", arguments: "{}" }, { id: "b", name: "big_default", arguments: "{}" }], finishReason: "tool_calls" }; return; }
      yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([descriptor, createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 })
    .runTurn({ sessionId: "big-tools", content: "work", security: security() });
  const outcome = (callId: string) => result.events.find((event) => event.type === "tool/result" && event.callId === callId)?.payload as Record<string, unknown>;
  assert.equal(outcome("a").state, "succeeded", "a declared budget admits the larger result");
  assert.equal(outcome("b").state, "failed");
  assert.match(JSON.stringify(outcome("b").error), /exceeds 32000 characters \(40011 returned\) and could not be cut under that budget/u, "the runtime cap still applies where nothing was declared, and says why the cut could not help");
  await host.shutdown();
});

test("turn control never executes a tool outside the selected model subset", async () => {
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "subset-violation", model: "subset-violation",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      modelCall += 1;
      yield modelCall === 1
        ? { type: "final", content: null, toolCalls: [{ id: "foreign", name: "agentic_echo", arguments: '{"value":"no"}' }], finishReason: "tool_calls" }
        : { type: "final", content: "safe", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.subset", revision: "v1",
    beforeModelStep: async () => ({ allowedToolIds: [] }),
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const host = new PluginHost();
  await host.activate([createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 3 }, {
    turnControlPolicy: policy,
  }).runTurn({ sessionId: "subset-violation", content: "work", security: security() });
  assert.equal(result.content, "safe");
  // The call outside the selection is refused with a result, not turned into an objection: the
  // model reads which tools it has and goes on. Nothing was dispatched.
  const refused = result.events.find((event) => event.type === "tool/result");
  assert.ok(refused, "the refused call leaves a result the model can read");
  const payload = refused.payload as Record<string, unknown>;
  assert.equal(payload.dispatched, false);
  assert.equal(payload.state, "not_started");
  // The tool is in the turn's catalogue, only held back from this step: the refusal says so, not that it is gone.
  assert.match(JSON.stringify(payload.error), /agentic_echo is not offered in this step/u);
  assert.equal(payload.unavailable, undefined, "a tool merely not offered is no missing capability");
  assert.equal(result.events.some((event) => event.type === "tool/state"), false, "a refused call never starts");
  assert.equal(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).phase === "choice-violation"), false);
  assert.equal(result.outcome, "completed");
  await host.shutdown();
});

test("a tool the model took from its instructions but the session does not carry is answered, not fatal", async () => {
  let modelCall = 0;
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const scripted: LlmAdapter = {
    id: "hallucinated-tool", model: "hallucinated-tool",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        // The skill said to call this first; the host never granted the permission it needs.
        yield { type: "final", content: null, toolCalls: [{ id: "c1", name: "payroll_period_overview", arguments: "{}" }], finishReason: "tool_calls" };
      } else if (modelCall === 2) {
        yield { type: "final", content: null, toolCalls: [{ id: "c2", name: "agentic_echo", arguments: '{"value":"evidence"}' }], finishReason: "tool_calls" };
      } else {
        yield { type: "text-delta", delta: "done" };
        yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
      }
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.payroll-like", revision: "v1",
    beforeModelStep: async () => ({}),
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "hallucinated-tool", content: "Hỗ trợ tôi tính lương", security: security(), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, "done");
  assert.equal(result.outcome, "completed");
  // The refusal reaches the model where it reads every other tool outcome, and says what to use.
  const toolMessage = requests[1]?.messages.find((message) => message.role === "tool" && message.toolCallId === "c1");
  assert.match(toolMessage?.content ?? "", /payroll_period_overview does not exist in this session/u);
  assert.match(toolMessage?.content ?? "", /agentic_echo/u, "the refusal names the tools the step does have");
  // Not an objection, not a retraction, not a fallback — and the wasted step is given back.
  assert.equal(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).decision !== "apply" && (event.payload as Record<string, unknown>).decision !== "accept"), false);
  assert.equal(progress.some((event) => event.type === "answer-revision-requested"), false);
  assert.equal(modelCall, 3);
  await host.shutdown();
});

test("a hard tool choice the adapter cannot enforce is enforced by the loop instead of failing the turn", async () => {
  let modelCalls = 0;
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const unsupported: LlmAdapter = {
    id: "unsupported-choice", model: "unsupported-choice",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCalls += 1;
      // Ignores the instruction once, then complies — the shape of a provider that took no parameter.
      if (modelCalls === 1) { yield { type: "final", content: "no", toolCalls: [], finishReason: "stop", status: "completed" }; return; }
      if (modelCalls === 2) { yield { type: "final", content: null, toolCalls: [{ id: "c", name: "agentic_echo", arguments: '{"value":"now"}' }], finishReason: "tool_calls" }; return; }
      yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const policy: TurnControlPolicy = {
    id: "test.hard-choice", revision: "v1",
    beforeModelStep: async (state) => state.stepIndex === 1
      ? { allowedToolIds: ["agentic_echo"], toolChoice: { name: "agentic_echo" } }
      : {},
    reviewTerminal: async () => ({ decision: "accept" }),
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(unsupported)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 5 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "unsupported-choice", content: "work", security: security() });
  // The turn used to be refused outright, before any model call. A payroll turn that had just
  // written data then ended on an error — after the write.
  assert.equal(result.content, "done");
  assert.equal(result.outcome, "completed");
  assert.equal(requests[0]?.toolChoice, undefined, "the parameter the provider cannot take is not sent");
  assert.ok(requests[0]?.messages.some((message) => message.role === "system" && /must call the tool `agentic_echo`/u.test(message.content ?? "")),
    "the choice is made in words instead");
  assert.equal(requests[0]?.tools.map((tool) => tool.name).join(), "agentic_echo", "the selected subset is still all that is offered");
  // And the journal says which way the choice was enforced, so an endpoint's behaviour can be
  // read back later instead of reproduced.
  const prepared = result.events.filter((event) => event.type === "request/prepared").map((event) => event.payload as Record<string, unknown>);
  assert.equal(prepared[0]?.toolChoiceEnforcement, "instruction");
  assert.deepEqual(prepared[0]?.requestedToolChoice, { name: "agentic_echo" });
  assert.equal(prepared[1]?.toolChoiceEnforcement, "none");
  // Ignoring the words is caught the same way ignoring the parameter would be.
  assert.ok(result.events.some((event) => event.type === "turn/control-decision" &&
    (event.payload as Record<string, unknown>).phase === "choice-violation"));
  assert.equal(modelCalls, 3);
  await host.shutdown();
});

test("context pressure is re-measured after tool observations at every clean model boundary", async () => {
  const measurements: number[] = [];
  const scripted: LlmAdapter = {
    id: "boundary-meter", providerId: "test", model: "boundary-model",
    resolveModel: async () => ({
      providerId: "test", adapterId: "boundary-meter", modelId: "boundary-model",
      routeRevision: "route-1", metadataSource: "adapter-catalog", contextWindowTokens: 2_000,
      estimatedCharsPerToken: 3,
    }),
    measureContext: async ({ messages }) => ({
      inputTokens: messages.some((message) => message.role === "tool") ? 1_800 : 100,
      method: "exact", revision: "test-meter-v1",
    }),
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      if (request.messages.some((message) => message.role === "tool")) {
        yield { type: "final", content: "done", toolCalls: [], finishReason: "stop" };
      } else {
        yield { type: "final", content: null, toolCalls: [{
          id: "boundary-call", name: "agentic_echo", arguments: '{"value":"large observation"}',
        }], finishReason: "tool_calls" };
      }
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], {
    security: security(), verifyArtifact: async () => true,
  });
  const delegate = new ConfiguredContextCompactionPolicy({ thresholdRatio: 0.8, retainRatio: 0.2 });
  const agent = new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), {}, {
    contextCompactionPolicy: {
      assess: (input) => { measurements.push(input.measuredContextTokens ?? -1); return delegate.assess(input); },
    },
  });
  const result = await agent.runTurn({ sessionId: "boundary-session", content: "run", security: security() });
  assert.equal(result.content, "done");
  assert.deepEqual(measurements, [100, 1_800]);
  const requests = result.events.filter((event) => event.type === "request/prepared");
  assert.equal(requests.length, 2);
  assert.equal(((requests[0]?.payload as Record<string, unknown>).modelRoute as Record<string, unknown>).routeRevision, "route-1");
  await host.shutdown();
});

test("provider context overflow gets one bounded compact-and-retry recovery", async () => {
  let calls = 0;
  const adapter: LlmAdapter = {
    id: "overflow-adapter", providerId: "test", model: "overflow-model",
    resolveModel: async () => ({
      providerId: "test", adapterId: "overflow-adapter", modelId: "overflow-model",
      routeRevision: "overflow-route-1", metadataSource: "adapter-catalog",
      contextWindowTokens: 10_000, estimatedCharsPerToken: 3,
    }),
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      if (calls === 1) throw new AgenticError("context-overflow", "provider rejected context length");
      yield { type: "final", content: "recovered", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoLlmPlugin(adapter)], {
    security: security(), verifyArtifact: async () => true,
  });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), {}, {
    contextCompactionPolicy: new ConfiguredContextCompactionPolicy(),
    conversationCompactor: new DeterministicConversationCompactor(),
  }).runTurn({ sessionId: "overflow-session", content: "recover", security: security() });
  assert.equal(result.content, "recovered");
  assert.equal(calls, 2);
  assert.equal(result.events.filter((event) => event.type === "llm/attempt-failed").length, 1);
  assert.equal(result.events.filter((event) => event.type === "request/prepared").length, 2);
  await host.shutdown();
});

test("cancellation between tool calls prevents the remaining call from dispatching", async () => {
  const controller = new AbortController();
  let executions = 0;
  const tool: ToolDefinition = {
    id: "cancel_batch_tool", version: "1.0.0", description: "cancel batch test",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"], additionalProperties: false },
    outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async () => {
      executions += 1;
      controller.abort(new AgenticError("cancelled", "stop after first tool"));
      return null;
    },
  };
  const toolPlugin: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.cancel-batch", version: "1.0.0",
      publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:cancel-batch", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        context.registrations.provide(TOOL_CAPABILITY, tool);
        return { dispose: () => undefined };
      },
    },
  };
  const scripted: LlmAdapter = {
    id: "cancel-batch", model: "cancel-batch",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "final", content: null, finishReason: "tool_calls", status: "tool_calls", toolCalls: [
        { id: "cancel-first", name: tool.id, arguments: '{"index":1}' },
        { id: "cancel-second", name: tool.id, arguments: '{"index":2}' },
      ] };
    },
  };
  const host = new PluginHost();
  await host.activate([toolPlugin, createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  await assert.rejects(new DefaultAgentLoop(routedHost(host), sessions).runTurn({
    sessionId: "cancel-batch", content: "run batch", security: security(), signal: controller.signal,
  }), /stop after first tool|cancel/i);
  const outcomes = (await sessions.load("cancel-batch", security())).filter((event) => event.type === "tool/result");
  assert.deepEqual(outcomes.map((event) => (event.payload as Record<string, unknown>).state), ["succeeded", "cancelled"]);
  assert.deepEqual(outcomes.map((event) => (event.payload as Record<string, unknown>).dispatched), [true, false]);
  assert.equal(executions, 1);
  await host.shutdown();
});

test("a model that returns an empty message is asked again rather than ending the turn blank", async () => {
  // The shape the budget path never sees: no tool calls, no text, a perfectly normal finish
  // reason. Nothing in the turn looks wrong until the chat under the trace is blank — which is
  // why the first version of this guard, keyed on budget suppression alone, walked straight past it.
  let attempts = 0;
  const quiet: LlmAdapter = {
    id: "quiet", model: "scripted-test",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      attempts += 1;
      const told = request.messages.some((message) => typeof message.content === "string" &&
        message.content.includes("Your previous response was empty"));
      yield told
        ? { type: "final", content: "Em chưa tính được lương, mới kiểm tra được kỳ.", toolCalls: [], finishReason: "stop" }
        : { type: "final", content: "", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(quiet)],
    { security: security(), verifyArtifact: async () => true },
  );
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 }).runTurn({
    sessionId: "quiet-turn", content: "tính lương giúp tôi", security: security(),
  });
  assert.match(result.content, /ch\u01b0a t\u00ednh \u0111\u01b0\u1ee3c l\u01b0\u01a1ng/u);
  assert.equal(result.outcome, "completed");
  assert.equal(attempts, 2, "asked exactly once more, not in a loop");
  await host.shutdown();
});

test("a turn that runs out of steps is asked for an answer before it is allowed to end", async () => {
  const seen: number[] = [];
  let toolsOffered = -1;
  const stubborn: LlmAdapter = {
    id: "stubborn", model: "scripted-test",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      seen.push(request.tools.length);
      // Keeps reaching for tools until the loop tells it, in words, that there are none left.
      const told = request.messages.some((message) => typeof message.content === "string" &&
        message.content.includes("No tools remain available for this turn"));
      if (!told) {
        yield { type: "final", content: "", toolCalls: [{ id: `c${seen.length}`, name: "agentic_echo", arguments: "{}" }], finishReason: "tool_calls" };
        return;
      }
      toolsOffered = request.tools.length;
      yield { type: "final", content: "Em mới kiểm tra được kết nối dữ liệu, chưa tính được lương.", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(stubborn)],
    { security: security(), verifyArtifact: async () => true },
  );
  // The ceiling has to leave room for the bought step; at the ceiling there is nothing to buy.
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 6 }).runTurn({
    sessionId: "forced-answer", content: "tính lương giúp tôi", security: security(),
  });
  // The turn reached an answer instead of stopping on nothing — which is the whole point: a
  // turn that cannot reach its goal still owes the person waiting an account of where it got to.
  assert.match(result.content, /chưa tính được lương/u);
  assert.equal(result.outcome, "partial", "a resource stop is not evidence that the requested payroll work finished");
  assert.equal(toolsOffered, 0, "the step that produced the answer was offered no tools");
  await host.shutdown();
});

test("a model that answers with tool calls alone does not end the turn in silence", async () => {
  // The shape reported from production, and the one the old code missed: `content` is the empty
  // string rather than null, which is what a reply carrying only tool calls actually looks like.
  const onlyToolCalls: LlmAdapter = {
    id: "only-tool-calls",
    model: "scripted-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield {
        type: "final", content: "",
        toolCalls: [{ id: "call-1", name: "agentic_echo", arguments: JSON.stringify({ value: 1 }) }],
        finishReason: "tool_calls",
      };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(onlyToolCalls)],
    { security: security(), verifyArtifact: async () => true },
  );
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 2 }).runTurn({
    sessionId: "silent-budget", content: "keep using tools", security: security(),
  });
  assert.equal(result.outcome, "partial");
  // Empty by design: the sentence a person reads belongs to the product, in its own language.
  // What must never happen again is this turn ending with neither an answer nor an outcome the
  // client can speak from — that is the silence a user cannot tell from a hang.
  assert.equal(result.content, "");
  assert.ok(result.events.some((event) => event.type === "assistant/message" &&
    /execution budget/u.test(String((event.payload as Record<string, unknown>).content ?? ""))),
  "the transcript keeps the note so the next turn knows what happened");
  await host.shutdown();
});

test("the final budget step disables tools and returns a durable partial result", async () => {
  let invocation = 0;
  const nonCompliantLoop: LlmAdapter = {
    id: "non-compliant-loop",
    model: "scripted-test",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      invocation += 1;
      if (invocation === 3) { assert.equal(request.tools.length, 0); assert.equal(request.toolChoice, "none"); }
      yield {
        type: "final",
        content: null,
        toolCalls: [{ id: `budget-${invocation}`, name: "agentic_echo", arguments: JSON.stringify({ value: invocation }) }],
        finishReason: "tool_calls",
      };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(nonCompliantLoop)],
    { security: security(), verifyArtifact: async () => true },
  );
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 3 }).runTurn({
    sessionId: "budget-finalization",
    content: "keep using tools",
    security: security(),
  });
  assert.equal(result.outcome, "partial");
  // The answer is empty, and that is the contract: this loop does not write the sentence a
  // person reads. It used to, in English, and only when the model returned null rather than the
  // empty string a tool-call-only reply actually carries — so the usual case ended in silence.
  assert.equal(result.content, "");
  // The note survives where it belongs: in the transcript, for the next turn to see.
  assert.ok(result.events.some((event) => event.type === "assistant/message" &&
    /execution budget/u.test(String((event.payload as Record<string, unknown>).content ?? ""))));
  assert.equal(result.events.filter((event) => event.type === "tool/result").length, 2);
  assert.equal(result.events.some((event) => event.type === "work/decision"), false);
  assert.equal((result.events.at(-1)?.payload as Record<string, unknown>).status, "partial");
  assert.equal((result.events.at(-1)?.payload as Record<string, unknown>).decision, "budget-reached");
  await host.shutdown();
});

test("transient LLM failures create a new prepared attempt and are retried", async () => {
  let attempts = 0;
  const flaky: LlmAdapter = {
    id: "flaky",
    model: "flaky-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      attempts += 1;
      if (attempts === 1) throw new AgenticError("transient", "temporary outage", true);
      yield { type: "final", content: "recovered", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoLlmPlugin(flaky)],
    { security: security(), verifyArtifact: async () => true },
  );
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { retryBaseDelayMs: 0 }).runTurn({
    sessionId: "retry-session",
    content: "retry",
    security: security(),
  });
  assert.equal(result.content, "recovered");
  assert.equal(result.events.filter((event) => event.type === "request/prepared").length, 2);
  assert.equal(result.events.filter((event) => event.type === "llm/attempt-failed").length, 1);
  await host.shutdown();
});

test("streamed output from a failed attempt is explicitly discarded before retry commits", async () => {
  let attempts = 0;
  const flaky: LlmAdapter = {
    id: "flaky-stream", model: "flaky-stream",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      attempts += 1;
      if (attempts === 1) {
        yield { type: "text-delta", delta: "discard me" };
        throw new AgenticError("transient", "stream interrupted", true);
      }
      yield { type: "text-delta", delta: "keep me" };
      yield { type: "final", content: "keep me", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoLlmPlugin(flaky)], {
    security: security(), verifyArtifact: async () => true,
  });
  const progress: AgentProgressEvent[] = [];
  const output: AgentOutputEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { retryBaseDelayMs: 0 }).runTurn({
    sessionId: "retry-stream", content: "retry stream", security: security(),
    onProgress: (event) => progress.push(event), onOutput: (event) => output.push(event),
  });
  assert.equal(result.content, "keep me");
  assert.equal(result.events.filter((event) => event.type === "llm/attempt-discarded").length, 1);
  assert.equal(result.events.filter((event) => event.type === "llm/attempt-committed").length, 1);
  assert.ok(progress.some((event) => event.type === "model-attempt-discarded" && event.willRetry));
  assert.ok(progress.some((event) => event.type === "model-attempt-committed"));
  assert.deepEqual(output.map((event) => event.type), [
    "assistant-output-start", "assistant-output-delta", "assistant-output-end",
    "assistant-output-start", "assistant-output-delta", "assistant-output-end",
  ]);
  assert.deepEqual(output.filter((event) => event.type === "assistant-output-end").map((event) => event.status), ["discarded", "completed"]);
  await host.shutdown();
});

test("incomplete provider finish reasons produce a durable partial outcome", async () => {
  const incomplete: LlmAdapter = {
    id: "incomplete", model: "incomplete",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "final", content: "truncated", toolCalls: [], finishReason: "length", status: "incomplete" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoLlmPlugin(incomplete)], {
    security: security(), verifyArtifact: async () => true,
  });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore()).runTurn({
    sessionId: "incomplete-finish", content: "long answer", security: security(),
  });
  assert.equal(result.outcome, "partial");
  const ended = result.events.find((event) => event.type === "turn/end")?.payload as Record<string, unknown>;
  assert.deepEqual([ended.status, ended.decision], ["partial", "partial"]);
  await host.shutdown();
});

test("repeated identical tool calls are blocked by the cycle guard", async () => {
  let calls = 0;
  const looping: LlmAdapter = {
    id: "looping",
    model: "looping-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      if (calls <= 3) {
        yield {
          type: "final",
          content: null,
          toolCalls: [{ id: `loop-${calls}`, name: "agentic_echo", arguments: '{"value":"same"}' }],
          finishReason: "tool_calls",
        };
      } else {
        yield { type: "final", content: "stopped", toolCalls: [], finishReason: "stop" };
      }
    },
  };
  const host = new PluginHost();
  await host.activate(
    [
      createMemoryPlugin(new InMemoryMemoryService()),
      createSystemPromptPlugin(),
      createEchoToolPlugin(),
      createEchoLlmPlugin(looping),
    ],
    { security: security(), verifyArtifact: async () => true },
  );
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxRepeatedToolCalls: 2 }).runTurn({
    sessionId: "cycle-session",
    content: "loop",
    security: security(),
  });
  const toolResults = result.events.filter((event) => event.type === "tool/result");
  const lastPayload = toolResults.at(-1)?.payload as { error?: { code?: string; message?: string } };
  assert.equal(lastPayload.error?.code, "cycle-detected");
  assert.match(lastPayload.error?.message ?? "", /^Repeated tool call blocked: agentic_echo was already called 2 times with these exact arguments\. Its last result: «.*same.*»\. Change what that result names/u);
  await host.shutdown();
});

test("turn idempotency replays a completed result without invoking the model again", async () => {
  let calls = 0;
  const counted: LlmAdapter = {
    id: "counted",
    model: "counted-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      yield { type: "final", content: "once", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoLlmPlugin(counted)],
    { security: security(), verifyArtifact: async () => true },
  );
  const sessions = new InMemorySessionStore();
  const runtimeRouter = routedHost(host);
  const agent = new DefaultAgentLoop(runtimeRouter, sessions);
  const input = {
    sessionId: "idempotent-session",
    content: "only once",
    security: security(),
    idempotencyKey: "stable-input-key",
  };
  const first = await agent.runTurn(input);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2",
  }]);
  const second = await agent.runTurn(input);
  assert.equal(calls, 1);
  assert.equal(second.turnId, first.turnId);
  assert.equal(second.replayed, true);
  assert.equal(second.events.length, first.events.length);
  await host.shutdown();
});

test("turn idempotency prevents concurrent runtimes from executing the same input", async () => {
  let calls = 0;
  let releaseModel!: () => void;
  let announceModel!: () => void;
  const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const entered = new Promise<void>((resolve) => { announceModel = resolve; });
  const blocked: LlmAdapter = {
    id: "blocked",
    model: "blocked-test",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      announceModel();
      await gate;
      yield { type: "final", content: "completed", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoLlmPlugin(blocked)],
    { security: security(), verifyArtifact: async () => true },
  );
  const sessions = new InMemorySessionStore();
  const firstRuntime = new DefaultAgentLoop(routedHost(host), sessions);
  const secondRuntime = new DefaultAgentLoop(routedHost(host), sessions);
  const input = {
    sessionId: "concurrent-idempotent-session",
    content: "only one runtime may own this input",
    security: security(),
    idempotencyKey: "distributed-input-key",
  };
  const first = firstRuntime.runTurn(input);
  await entered;
  await assert.rejects(secondRuntime.runTurn(input), /still in progress/i);
  releaseModel();
  assert.equal((await first).content, "completed");
  assert.equal(calls, 1);
  await host.shutdown();
});

test("durable lease prevents different inputs from concurrently owning one session", async () => {
  let calls = 0;
  let releaseModel!: () => void;
  let announceModel!: () => void;
  const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const entered = new Promise<void>((resolve) => { announceModel = resolve; });
  const blocked: LlmAdapter = {
    id: "blocked-distinct", model: "blocked-distinct",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      calls += 1;
      announceModel();
      await gate;
      yield { type: "final", content: "completed", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoLlmPlugin(blocked)],
    { security: security(), verifyArtifact: async () => true },
  );
  const sessions = new InMemorySessionStore();
  const first = new DefaultAgentLoop(routedHost(host), sessions).runTurn({
    sessionId: "concurrent-distinct-session", content: "first", security: security(), idempotencyKey: "first-key",
  });
  await entered;
  await assert.rejects(new DefaultAgentLoop(routedHost(host), sessions).runTurn({
    sessionId: "concurrent-distinct-session", content: "second", security: security(), idempotencyKey: "second-key",
  }), /still in progress/i);
  releaseModel();
  await first;
  assert.equal(calls, 1);
  const events = await sessions.load("concurrent-distinct-session", security());
  assert.equal(events.filter((event) => event.type === "turn/start").length, 1);
  assert.equal(events.filter((event) => event.type === "turn/end").length, 1);
  await host.shutdown();
});

test("idempotency key is bound to a request fingerprint", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions);
  await agent.runTurn({ sessionId: "fingerprint-session", content: "first", security: security(), idempotencyKey: "same-key" });
  await assert.rejects(agent.runTurn({
    sessionId: "fingerprint-session", content: "different", security: security(), idempotencyKey: "same-key",
  }), /different request/i);
  await host.shutdown();
});

test("idempotency key is bound to which files were attached, not just the words", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions);
  const attachmentA = [{ id: "doc-a", name: "a.pdf", mediaType: "application/pdf", byteSize: 1_024 }];
  const attachmentB = [{ id: "doc-b", name: "b.pdf", mediaType: "application/pdf", byteSize: 1_024 }];
  await agent.runTurn({
    sessionId: "attachment-fingerprint-session", content: "review this", security: security(),
    idempotencyKey: "same-key", attachments: attachmentA,
  });
  // Same key, same words, a different file: this must never replay the first turn's answer, which
  // was about doc-a, as though it had reviewed doc-b.
  await assert.rejects(agent.runTurn({
    sessionId: "attachment-fingerprint-session", content: "review this", security: security(),
    idempotencyKey: "same-key", attachments: attachmentB,
  }), /different request/i);
  // Same key, same words, no file at all is just as much a different request.
  await assert.rejects(agent.runTurn({
    sessionId: "attachment-fingerprint-session", content: "review this", security: security(),
    idempotencyKey: "same-key",
  }), /different request/i);
  await host.shutdown();
});

test("expired owner is repaired and stale fencing token cannot append", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const owner = security();
  const first = await sessions.claimTurn({
    sessionId: "lease-recovery-session", turnId: "turn-old", ownerId: "worker-old",
    idempotencyKey: "old-input", requestFingerprint: "old-fingerprint", leaseTtlMs: 1,
    startEvents: [
      { type: "turn/start", turnId: "turn-old", payload: { inputIdempotencyKey: "old-input" } },
      { type: "user/input", turnId: "turn-old", payload: { content: "old", source: "external" } },
    ],
  }, { security: owner, runtime: host.snapshot });
  assert.equal(first.kind, "acquired");
  if (first.kind !== "acquired") throw new Error("lease not acquired");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await sessions.claimTurn({
    sessionId: "lease-recovery-session", turnId: "turn-new", ownerId: "worker-new",
    idempotencyKey: "new-input", requestFingerprint: "new-fingerprint", leaseTtlMs: 1_000,
    startEvents: [
      { type: "turn/start", turnId: "turn-new", payload: { inputIdempotencyKey: "new-input" } },
      { type: "user/input", turnId: "turn-new", payload: { content: "new", source: "external" } },
    ],
  }, { security: owner, runtime: host.snapshot });
  assert.equal(second.kind, "acquired");
  await assert.rejects(sessions.appendLeased(first.lease, first.seq, [
    { type: "assistant/message", turnId: "turn-old", payload: { content: "stale" } },
  ], "stale-write", { security: owner, runtime: host.snapshot }), /lease lost|expired/i);
  const events = await sessions.load("lease-recovery-session", owner);
  assert.equal(events.filter((event) => event.type === "turn/failed" && event.turnId === "turn-old").length, 1);
  assert.equal(events.filter((event) => event.type === "turn/start").length, 2);
  await host.shutdown();
});

test("expired turn recovery balances undispatched and uncertain tool calls", async () => {
  const { host } = await activeHost();
  const sessions = new InMemorySessionStore();
  const owner = security();
  const claimed = await sessions.claimTurn({
    sessionId: "tool-recovery-session", turnId: "tool-turn-old", ownerId: "worker-old",
    idempotencyKey: "tool-old", requestFingerprint: "tool-old-fingerprint", leaseTtlMs: 10,
    startEvents: [
      { type: "turn/start", turnId: "tool-turn-old", payload: { inputIdempotencyKey: "tool-old" } },
      { type: "user/input", turnId: "tool-turn-old", payload: { content: "old", source: "external" } },
    ],
  }, { security: owner, runtime: host.snapshot });
  assert.equal(claimed.kind, "acquired");
  if (claimed.kind !== "acquired") throw new Error("lease not acquired");
  const stepId = "tool-step-old";
  await sessions.appendLeased(claimed.lease, claimed.seq, [
    { type: "assistant/message", turnId: "tool-turn-old", stepId, requestId: "tool-request-old", payload: {
      content: null, toolCalls: [
        { id: "uncertain-call", name: "one", arguments: "{}" },
        { id: "not-started-call", name: "two", arguments: "{}" },
      ],
    } },
    { type: "tool/intent", turnId: "tool-turn-old", stepId, callId: "uncertain-call", payload: {
      callId: "uncertain-call", executionId: "execution-uncertain", toolId: "one", arguments: "{}", sideEffect: "none", state: "prepared",
    } },
    { type: "tool/state", turnId: "tool-turn-old", stepId, callId: "uncertain-call", payload: {
      callId: "uncertain-call", executionId: "execution-uncertain", toolId: "one", state: "running",
    } },
    { type: "tool/intent", turnId: "tool-turn-old", stepId, callId: "not-started-call", payload: {
      callId: "not-started-call", executionId: "execution-not-started", toolId: "two", arguments: "{}", sideEffect: "none", state: "prepared",
    } },
  ], "tool-recovery-fixture", { security: owner, runtime: host.snapshot });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await sessions.claimTurn({
    sessionId: "tool-recovery-session", turnId: "tool-turn-new", ownerId: "worker-new",
    idempotencyKey: "tool-new", requestFingerprint: "tool-new-fingerprint", leaseTtlMs: 1_000,
    startEvents: [
      { type: "turn/start", turnId: "tool-turn-new", payload: { inputIdempotencyKey: "tool-new" } },
      { type: "user/input", turnId: "tool-turn-new", payload: { content: "new", source: "external" } },
    ],
  }, { security: owner, runtime: host.snapshot });
  const recovered = (await sessions.load("tool-recovery-session", owner)).filter((event) =>
    event.type === "tool/result" && event.turnId === "tool-turn-old");
  assert.deepEqual(recovered.map((event) => (event.payload as Record<string, unknown>).state), ["outcome_unknown", "not_started"]);
  assert.deepEqual(recovered.map((event) => (event.payload as Record<string, unknown>).dispatched), [true, false]);
  await host.shutdown();
});

test("context policy enforces one global serialized budget", () => {
  const policy = new ContextWindowPolicy(600);
  const bounded = policy.apply([
    { role: "system", content: "a".repeat(1_000) },
    { role: "system", content: "b".repeat(1_000) },
    { role: "user", content: "latest input" },
  ]);
  assert.ok(JSON.stringify(bounded.messages).length <= 600);
  assert.ok(bounded.messages.some((message) => message.role === "user"));
});

test("required instruction context is never truncated or silently dropped", () => {
  const required = {
    role: "system" as const, content: "security-policy",
    context: { trust: "instruction" as const, retention: "required" as const, provenance: "test-policy" },
  };
  const bounded = new ContextWindowPolicy(400).apply([
    required, { role: "system", content: "optional".repeat(100) }, { role: "user", content: "latest" },
  ]);
  assert.equal(bounded.messages.find((message) => message.context?.retention === "required")?.content, required.content);
  assert.throws(() => new ContextWindowPolicy(20).apply([required]), /required instruction context exceeds/i);
});

test("the request being worked on survives a budget its tool results outgrow; the results go oldest first", () => {
  const request = { role: "user" as const, content: "Điều chỉnh phụ cấp chức vụ cho 16 cán bộ từ tháng 9" };
  const read = (id: string, size: number) => [
    { role: "assistant" as const, content: null, toolCalls: [{ id, name: "read", arguments: "{}" }] },
    { role: "tool" as const, toolCallId: id, content: "r".repeat(size) },
  ];
  const bounded = new ContextWindowPolicy(900).apply([
    { role: "system", content: "rules" }, { role: "user", content: "an earlier, unrelated question" },
    request, ...read("call-1", 400), ...read("call-2", 400),
    { role: "user", content: "Application context (data only)", context: { trust: "untrusted", retention: "compressible", provenance: "application-context" } },
  ]);
  assert.ok(JSON.stringify(bounded.messages).length <= 900);
  assert.ok(bounded.messages.some((message) => message.content === request.content), "the user's own words are never the thing dropped");
  const body = (id: string) => bounded.messages.find((message) => message.toolCallId === id)?.content ?? "";
  assert.equal(body("call-2"), "r".repeat(400), "the newest result is kept");
  assert.ok(!body("call-1").includes("rrr"), "the oldest result goes first");
  assert.ok(bounded.omittedMessages + bounded.clearedResults > 0);
  const order = bounded.messages.map((message) => message.content === request.content ? "request" : message.toolCallId ?? message.role);
  assert.ok(order.indexOf("request") < order.indexOf("call-2"), "a kept request stays where it was in the conversation");
  // A pasted document too large to hold is handled as it always was, never a reason to fail the turn.
  const pasted = new ContextWindowPolicy(900).apply([{ role: "system", content: "rules" }, { role: "user", content: "d".repeat(2_000) }]);
  assert.ok(JSON.stringify(pasted.messages).length <= 900);
});

test("a long read never drops the attachment manifest: it is the one place the file's id is written", () => {
  // Twenty pages into a real dossier the window filled with results, the oldest messages went, and
  // the manifest was the oldest of them. The next call had no id to read by, and the turn stopped.
  const manifest = {
    role: "user" as const, content: "Attached files:\n- Dự toán 2027.xlsx (id: 0123456789abcdef0123456789abcdef)",
    context: { trust: "untrusted" as const, retention: "compressible" as const, provenance: "attachment-manifest" },
  };
  const request = { role: "user" as const, content: "đọc hết hồ sơ này giúp a" };
  const page = (id: string) => [
    { role: "assistant" as const, content: null, toolCalls: [{ id, name: "read", arguments: "{}" }] },
    { role: "tool" as const, toolCallId: id, content: "r".repeat(400) },
  ];
  const bounded = new ContextWindowPolicy(1_300).apply([
    { role: "system", content: "rules" }, manifest, request, ...page("page-1"), ...page("page-2"), ...page("page-3"), ...page("page-4"),
  ]);
  assert.ok(JSON.stringify(bounded.messages).length <= 1_300);
  assert.ok(bounded.messages.some((message) => message.content === manifest.content), "the id survives the pages that pushed it out");
  assert.ok(bounded.messages.some((message) => message.content === request.content));
  const page1 = bounded.messages.find((message) => message.toolCallId === "page-1")?.content ?? "";
  assert.ok(bounded.messages.some((message) => message.toolCallId === "page-4" && message.content === "r".repeat(400)) && !page1.includes("rrr"),
    "what goes is an old page, which can be read again");
  const order = bounded.messages.map((message) => message.content === manifest.content ? "manifest" : message.content === request.content ? "request" : message.toolCallId ?? message.role);
  assert.ok(order.indexOf("manifest") < order.indexOf("request"), "kept where it was: ahead of the words it belongs to");
});

test("a result the budget cannot hold loses its body and keeps its call, so what was read stays known", () => {
  // Thirty sheets into a dossier the oldest reads were dropped whole, call and result. Nothing in
  // view said they had happened, and the answer was written from the dozen sheets still there.
  const request = { role: "user" as const, content: "đọc hết hồ sơ này giúp a" };
  const read = (sheet: string) => [
    { role: "assistant" as const, content: `Em đọc biểu ${sheet}.`, toolCalls: [{ id: `call-${sheet}`, name: "read_table", arguments: JSON.stringify({ sheet }) }] },
    { role: "tool" as const, toolCallId: `call-${sheet}`, content: "r".repeat(3_000) },
  ];
  const sheets = ["01", "02", "03", "04", "05", "06"];
  const bounded = new ContextWindowPolicy(12_000).apply([{ role: "system", content: "rules" }, request, ...sheets.flatMap(read)]);
  assert.ok(JSON.stringify(bounded.messages).length <= 12_000);
  const results = sheets.map((sheet) => bounded.messages.find((message) => message.toolCallId === `call-${sheet}`)?.content ?? "(gone)");
  const whole = results.filter((content) => content === "r".repeat(3_000)).length;
  assert.ok(whole >= 2 && whole < sheets.length, "the newest results are held whole");
  assert.deepEqual(results.map((content) => content === "r".repeat(3_000)), sheets.map((_, index) => index >= sheets.length - whole), "and it is the oldest that are cleared");
  assert.ok(results.every((content) => content !== "(gone)"), "no read vanishes: every call is still answered");
  assert.match(results[0] ?? "", /cleared to fit the context budget.*call the tool again/isu);
  assert.equal(bounded.clearedResults, sheets.length - whole);
  assert.equal(bounded.omittedMessages, 0, "nothing was left out, so nothing is announced as omitted");
  for (const sheet of sheets) {
    const call = bounded.messages.find((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === `call-${sheet}`);
    assert.equal(call?.content, `Em đọc biểu ${sheet}.`, "what the model said when it made the call stays with it");
    assert.equal(call?.toolCalls?.[0]?.arguments, JSON.stringify({ sheet }), "and so does what it asked for");
  }
  // Everything fits: nothing is cleared and no room is held back for clearing.
  const roomy = new ContextWindowPolicy(60_000).apply([{ role: "system", content: "rules" }, request, ...sheets.flatMap(read)]);
  assert.deepEqual([roomy.clearedResults, roomy.omittedMessages], [0, 0]);
});

test("context compaction policy is model-aware and auto compaction can be disabled", () => {
  const policy = new ConfiguredContextCompactionPolicy({
    thresholdRatio: 0.8, retainRatio: 0.2, estimatedCharsPerToken: 3,
  });
  const matched = policy.assess({
    providerId: "provider-a", modelId: "small", measuredContextChars: 2_500,
    contextWindowTokens: 1_000, estimatedCharsPerToken: 3,
    fallbackMaxContextChars: 120_000, trigger: "pressure",
  });
  assert.equal(matched.maxContextChars, 3_000);
  assert.equal(matched.targetContextChars, 600);
  assert.equal(matched.shouldCompact, true);
  const otherProvider = policy.assess({
    providerId: "provider-b", modelId: "small", measuredContextChars: 2_500,
    fallbackMaxContextChars: 120_000, trigger: "pressure",
  });
  assert.equal(otherProvider.maxContextChars, 120_000);
  assert.equal(otherProvider.shouldCompact, false);
  const disabled = new ConfiguredContextCompactionPolicy({ mode: "off" }).assess({
    providerId: "provider-a", modelId: "small", measuredContextChars: 999_999,
    fallbackMaxContextChars: 120_000, trigger: "pressure",
  });
  assert.equal(disabled.shouldCompact, false);
});

test("tool schemas fail closed and invalid output becomes a normalized outcome", async () => {
  const invalidSchema: ToolDefinition = {
    id: "invalid-schema", version: "1.0.0", description: "test",
    // `multipleOf`, not `format`: this assertion is about failing closed on a keyword that
    // genuinely constrains and is not implemented. `format` used to serve as the example, but it is
    // an annotation that asserts nothing by default and is now accepted and ignored — keeping it
    // here would have tested the opposite of what the sentence above says.
    inputSchema: { type: "number", multipleOf: 3 }, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async () => null,
  };
  assert.throws(() => new ToolExecutionCoordinator([invalidSchema], resolveAgentOptions({})), /unsupported json schema keyword/i);

  const invalidOutput: ToolDefinition = {
    id: "invalid-output", version: "1.0.0", description: "test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "string" }, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async () => 42,
  };
  const outcome = await new ToolExecutionCoordinator([invalidOutput], resolveAgentOptions({})).execute(
    { id: "call-output", name: "invalid-output", arguments: "{}" },
    { sessionId: "s", turnId: "t", stepId: "p", security: security(), runtime: runtimeSnapshot() },
    new AbortController().signal,
  );
  assert.match(JSON.stringify(outcome.error), /invalid tool output/i);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.dispatched, true);
  assert.equal(Object.isFrozen(outcome), true);

  // A prepared call must not freeze its whole context as data: a frozen reviewer holding the turn's AbortSignal.any
  // signal makes the silence timer's abort throw inside Node and exit the server process.
  const silence = new AbortController();
  const turnSignal = AbortSignal.any([silence.signal]);
  class Reviewer { constructor(readonly signal: AbortSignal) {} }
  const live = { sessionId: "s", turnId: "t", stepId: "p", security: security(), runtime: runtimeSnapshot(), reviewer: new Reviewer(turnSignal) };
  const prepared = await new ToolExecutionCoordinator([invalidOutput], resolveAgentOptions({})).prepare({ id: "call-live", name: "invalid-output", arguments: "{}" }, live);
  assert.equal(prepared.kind, "ready");
  assert.equal(Object.isFrozen(turnSignal), false, "a live object in the context is not frozen as data");
  assert.doesNotThrow(() => silence.abort(new Error("silence")), "aborting the turn never throws");

  let deniedExecutions = 0;
  const denied: ToolDefinition = {
    id: "denied", version: "1.0.0", description: "test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: {},
    requiredPermissions: ["tool.denied"], sideEffect: "none", timeoutMs: 100,
    execute: async () => { deniedExecutions += 1; return null; },
  };
  const deniedOutcome = await new ToolExecutionCoordinator([denied], resolveAgentOptions({})).execute(
    { id: "call-denied", name: "denied", arguments: "{}" },
    { sessionId: "s", turnId: "t", stepId: "p", security: security(), runtime: runtimeSnapshot() },
    new AbortController().signal,
  );
  assert.equal(deniedOutcome.state, "denied");
  assert.equal(deniedOutcome.dispatched, false);
  assert.equal(deniedExecutions, 0);
});

test("non-cooperative LLM is bounded by a hard attempt deadline, retried, then closed unfinished with balanced events", async () => {
  const hanging: LlmAdapter = {
    id: "hanging", model: "hanging",
    async *stream(): AsyncIterable<LlmStreamEvent> {
      await new Promise<void>(() => undefined);
    },
  };
  const host = new PluginHost();
  await host.activate(
    [createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoLlmPlugin(hanging)],
    { security: security(), verifyArtifact: async () => true },
  );
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions, {
    maxLlmAttempts: 1, llmAttemptTimeoutMs: 20, turnTimeoutMs: 500,
    leaseTtlMs: 200, leaseRenewIntervalMs: 50,
  });
  // A step that times out is retried, then closed by a summary step; when even that cannot run, the turn ends unfinished,
  // never on a bare error after work — every step still opened and closed in the journal.
  const result = await agent.runTurn({ sessionId: "hanging-session", content: "hang", security: security() });
  assert.equal(result.outcome, "partial");
  const events = await sessions.load("hanging-session", security());
  const starts = events.filter((event) => event.type === "step/start").length;
  assert.equal(starts, 4, "the step, its retry, the closing step, and the step that ends it");
  assert.equal(events.filter((event) => event.type === "step/end").length, starts);
  assert.equal(events.filter((event) => event.type === "turn/failed").length, 0);
  await host.shutdown();
});

test("provider-private assistant state survives durable projection without entering visible content", async () => {
  let requestNumber = 0;
  const privateState = {
    providerId: "deepseek", adapterId: "deepseek", adapterVersion: "0.1.0", stateVersion: 1,
    classification: "confidential" as const, payload: { reasoningContent: "opaque-state" },
  };
  const scripted: LlmAdapter = {
    id: "deepseek", providerId: "deepseek", model: "private-state",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requestNumber += 1;
      if (requestNumber === 1) {
        yield {
          type: "final", content: null,
          toolCalls: [{ id: "private-call", name: "agentic_echo", arguments: '{"value":"ok"}' }],
          finishReason: "tool_calls", providerState: privateState,
        };
        return;
      }
      const privateAssistant = request.messages.find((message) => message.role === "assistant" && message.providerState);
      assert.equal((privateAssistant?.providerState?.payload as { reasoningContent?: string }).reasoningContent, "opaque-state");
      assert.equal(privateAssistant?.content, null);
      yield { type: "final", content: requestNumber === 2 ? "first complete" : "second complete", toolCalls: [], finishReason: "stop" };
    },
  };
  const host = new PluginHost();
  await host.activate([
    createMemoryPlugin(new InMemoryMemoryService()), createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted),
  ], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  await new DefaultAgentLoop(routedHost(host), sessions).runTurn({ sessionId: "private-state-session", content: "first", security: security() });
  await new DefaultAgentLoop(routedHost(host), sessions).runTurn({ sessionId: "private-state-session", content: "second", security: security() });
  const events = await sessions.load("private-state-session", security());
  const stateEvent = events.find((event) => event.type === "assistant/message" && (event.payload as Record<string, unknown>).providerState);
  assert.equal(stateEvent?.classification, "confidential");
  assert.equal(JSON.stringify((stateEvent?.payload as Record<string, unknown>).content).includes("opaque-state"), false);
  await host.shutdown();
});

test("tool policy filters model discovery and re-authorizes immediately before dispatch", async () => {
  let requestCount = 0;
  let exposedTools: readonly { readonly name: string }[] = [];
  const scripted: LlmAdapter = {
    id: "policy-test", model: "policy-test",
    async *stream(request) {
      requestCount += 1;
      exposedTools = request.tools;
      if (requestCount === 1 && request.tools.length > 0) {
        yield { type: "final", content: null, finishReason: "tool_calls", status: "tool_calls", toolCalls: [
          { id: "policy-call", name: "agentic_echo", arguments: '{"value":"blocked"}' },
        ] };
        return;
      }
      yield { type: "final", content: "policy complete", finishReason: "stop", status: "completed", toolCalls: [] };
    },
  };
  const denyAtInvocation: ToolExecutionPolicy = {
    discover: async (tools) => tools,
    authorize: async (input) => ({
      decisionId: "decision-deny", outcome: "deny", policyRevision: input.runtime.policyRevision,
      reason: "Invocation grant was revoked", actionDigest: "action-digest",
    }),
  };
  const host = new PluginHost();
  await host.activate([createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), {}, { toolExecutionPolicy: denyAtInvocation }).runTurn({
    sessionId: "policy-two-phase", content: "try tool", security: security(),
  });
  assert.equal(exposedTools.some((tool) => tool.name === "agentic_echo"), true);
  const decision = result.events.find((event) => event.type === "tool/policy-decision");
  const toolResult = result.events.find((event) => event.type === "tool/result");
  assert.equal((decision?.payload as Record<string, unknown>).outcome, "deny");
  assert.equal((toolResult?.payload as Record<string, unknown>).state, "denied");
  assert.equal((toolResult?.payload as Record<string, unknown>).dispatched, false);
  await host.shutdown();

  exposedTools = [];
  const hiddenHost = new PluginHost();
  await hiddenHost.activate([createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  await new DefaultAgentLoop(routedHost(hiddenHost), new InMemorySessionStore()).runTurn({
    sessionId: "policy-discovery", content: "list tools", security: { ...security(), permissions: new Set() },
  });
  assert.deepEqual(exposedTools, []);
  await hiddenHost.shutdown();
});

test("runtime resolution receives immutable tenant/profile context and admission rejects excess tenant concurrency", async () => {
  let releaseModel!: () => void;
  const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const blocking: LlmAdapter = {
    id: "admission-test", model: "admission-test",
    async *stream() { await gate; yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" }; },
  };
  const host = new PluginHost();
  await host.activate([createEchoLlmPlugin(blocking)], { security: security(), verifyArtifact: async () => true });
  let resolvedTenant = "";
  let resolvedProfile = "";
  const routed = routedHost(host, "tenant-quota", "profile-a");
  const provider = {
    acquireRuntime: (request: { security: SecurityContext; agentProfileId?: string }) => {
      resolvedTenant = request.security.tenantId;
      resolvedProfile = request.agentProfileId ?? "";
      return routed.acquireRuntime(request);
    },
  };
  const agent = new DefaultAgentLoop(provider, new InMemorySessionStore(), {}, {
    admissionController: new InMemoryTurnAdmissionController(1),
  });
  const first = agent.runTurn({
    sessionId: "quota-a", content: "hold",
    security: { ...security("tenant-quota"), authorizedAgentProfiles: ["profile-a"] }, agentProfileId: "profile-a",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(agent.runTurn({ sessionId: "quota-b", content: "reject", security: security("tenant-quota") }), /quota exceeded/i);
  assert.equal(resolvedTenant, "tenant-quota");
  assert.equal(resolvedProfile, "profile-a");
  releaseModel();
  assert.equal((await first).outcome, "completed");
  await host.shutdown();
});

test("side-effect approval is durable, action-bound, resumable and single-use", async () => {
  let executions = 0;
  let modelCalls = 0;
  let presentationTarget = "One payroll record";
  const sideEffectTool: ToolDefinition = {
    id: "approval_write", version: "1.0.0", description: "writes only after approval",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false },
    requiredPermissions: ["approval.write"], sideEffect: "idempotent", timeoutMs: 100,
    execute: async () => { executions += 1; return { accepted: true }; },
  };
  const toolPlugin: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.approval-write", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:approval-write", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => { context.registrations.provide(TOOL_CAPABILITY, sideEffectTool); return { dispose: () => undefined }; },
    },
  };
  let approvalOutcomeSeen = "";
  const scripted: LlmAdapter = {
    id: "approval-model", model: "approval-model",
    async *stream(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal(request.tools.some((tool) => tool.name === sideEffectTool.id), true);
        yield { type: "final", content: null, finishReason: "tool_calls", status: "tool_calls", toolCalls: [
          { id: "approval-call", name: sideEffectTool.id, arguments: '{"value":"CANARY_PRIVATE_ARGUMENT"}' },
        ] };
        return;
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && message.toolCallId === "approval-call"), true);
      approvalOutcomeSeen = request.messages.find((message) => message.role === "tool" && message.toolCallId === "approval-call")?.content ?? "";
      yield { type: "final", content: "approved action completed", finishReason: "stop", status: "completed", toolCalls: [] };
    },
  };
  const host = new PluginHost();
  await host.activate([toolPlugin, createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  const runtimeRouter = routedHost(host);
  const baselinePolicy = new PermissionToolExecutionPolicy();
  const presentationPolicy: ToolExecutionPolicy = {
    discover: (tools, context) => baselinePolicy.discover(tools, context),
    authorize: async (input) => {
      const decision = await baselinePolicy.authorize(input);
      return decision.outcome !== "require_approval" ? decision : Object.freeze({
        ...decision,
        approvalPresentation: {
          summary: "Update one approved payroll record.", action: "Update payroll record",
          target: presentationTarget, impact: "The selected value will be overwritten.",
          fields: [{ label: "Affected records", value: 1 }],
          secret: "CANARY_PRIVATE_PRESENTATION_EXTRA",
        } as ApprovalPresentation & { readonly secret: string },
      });
    },
  };
  const agent = new DefaultAgentLoop(runtimeRouter, sessions, {}, { toolExecutionPolicy: presentationPolicy });
  const owner = { ...security(), permissions: new Set(["approval.write"]), grantRevision: "grant-1" };
  const paused = await agent.runTurn({ sessionId: "approval-session", content: "perform write", security: owner, idempotencyKey: "approval-request" });
  assert.equal(paused.outcome, "awaiting_approval");
  assert.equal(paused.content, "", "approval presentation is the only user-facing action description");
  assert.equal(executions, 0);
  assert.ok(paused.approval);
  assert.equal(paused.approval.runtimeRouteRevision, "test-route-v1");
  assert.deepEqual(paused.approval.presentation, {
    summary: "Update one approved payroll record.", action: "Update payroll record",
    target: "One payroll record", impact: "The selected value will be overwritten.",
    fields: [{ label: "Affected records", value: 1 }],
  });
  assert.doesNotMatch(JSON.stringify(paused.approval), /CANARY_PRIVATE/);
  const durableApproval = paused.events.find((event) => event.type === "approval/requested");
  assert.deepEqual((durableApproval?.payload as Record<string, unknown>).presentation, paused.approval.presentation);
  assert.equal(paused.events.some((event) => event.type === "approval/requested"), true);
  assert.equal(paused.events.some((event) => event.type === "tool/result" && event.callId === "approval-call"), false);

  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2",
  }]);
  await assert.rejects(agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval.approvalId, decision: "approve",
    security: owner, idempotencyKey: "wrong-route-revision",
  }), /binding is stale/i);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1",
  }]);

  presentationTarget = "A different payroll record";
  await assert.rejects(agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval.approvalId, decision: "approve",
    security: owner, idempotencyKey: "changed-presentation",
  }), /durable action binding/i);
  presentationTarget = "One payroll record";

  await assert.rejects(agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval!.approvalId, decision: "approve",
    security: { ...owner, actorId: "other-user" }, idempotencyKey: "wrong-actor",
  }), /owner boundary|actor does not match/i);
  assert.equal(executions, 0);
  await assert.rejects(agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval!.approvalId, decision: "approve",
    security: { ...owner, grantRevision: "grant-2" }, idempotencyKey: "wrong-grant",
  }), /grants changed/i);
  assert.equal(executions, 0);

  const resumedProgress: AgentProgressEvent[] = [];
  const resumed = await agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval!.approvalId, decision: "approve",
    security: owner, idempotencyKey: "approval-resume", onProgress: (event) => resumedProgress.push(event),
  });
  assert.equal(resumed.outcome, "completed");
  assert.equal(resumed.content, "approved action completed");
  assert.equal(executions, 1);
  // The approved call is work in progress like any other, so the reader is shown what runs, not "thinking".
  const approvedCall = resumed.events.find((event) => event.type === "tool/result")?.callId;
  assert.deepEqual(resumedProgress.filter((event) => event.type === "tool-started" || event.type === "tool-completed")
    .map((event) => [event.type, "callId" in event ? event.callId : ""]), [["tool-started", approvedCall], ["tool-completed", approvedCall]]);
  assert.equal(resumed.events.some((event) => event.type === "approval/resolved"), true);
  assert.equal(resumed.events.some((event) => event.type === "tool/result" && (event.payload as Record<string, unknown>).state === "succeeded"), true);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2",
  }]);
  const replay = await agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval!.approvalId, decision: "approve",
    security: owner, idempotencyKey: "approval-resume",
  });
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1",
  }]);
  await assert.rejects(agent.resumeTurn({
    sessionId: "approval-session", approvalId: paused.approval!.approvalId, decision: "approve",
    security: owner, idempotencyKey: "approval-reuse",
  }), /already been resolved/i);
  assert.equal(executions, 1);

  modelCalls = 0;
  const deniedPause = await agent.runTurn({
    sessionId: "approval-denial", content: "do not perform", security: owner, idempotencyKey: "denial-request",
  });
  const deniedResume = await agent.resumeTurn({
    sessionId: "approval-denial", approvalId: deniedPause.approval!.approvalId, decision: "deny",
    security: owner, idempotencyKey: "denial-resume",
  });
  assert.equal(deniedResume.outcome, "completed");
  // A denial is not the end of the conversation: the model reads it as the tool's outcome and
  // answers — in the conversation's language, since the runtime no longer speaks for it.
  assert.equal(deniedResume.content, "approved action completed");
  assert.match(approvalOutcomeSeen, /declined this action; nothing was changed/u);
  assert.equal(deniedResume.events.some((event) => event.type === "assistant/message" && /not approved/u.test(JSON.stringify(event.payload))), false);
  assert.equal(executions, 1);

  modelCalls = 0;
  const expiringAgent = new DefaultAgentLoop(routedHost(host), sessions, { approvalTtlMs: 1 });
  const expiring = await expiringAgent.runTurn({
    sessionId: "approval-expiry", content: "perform later", security: owner, idempotencyKey: "expiry-request",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(expiringAgent.resumeTurn({
    sessionId: "approval-expiry", approvalId: expiring.approval!.approvalId, decision: "approve",
    security: owner, idempotencyKey: "expiry-resume",
  }), /expired/i);
  assert.equal(executions, 1);
  await host.shutdown();
});

test("tool interaction is durable, schema-bound, resumable and single-use", async () => {
  let executions = 0;
  let modelCalls = 0;
  const tool: ToolDefinition = {
    id: "interactive_lookup", version: "1.0.0", description: "needs a region before lookup",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["region"],
      properties: { region: { type: "string" } },
    },
    requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async (invocation) => {
      executions += 1;
      if (!invocation.interaction) return {
        protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required",
        request: {
          kind: "form", title: "Chọn khu vực", message: "Khu vực nào cần tra cứu?",
          requestedSchema: {
            type: "object", properties: {
              region: { type: "string", title: "Khu vực", oneOf: [
                { const: "north", title: "Miền Bắc" }, { const: "south", title: "Miền Nam" },
              ] },
              tags: { type: "array", title: "Phạm vi", minItems: 1, maxItems: 2, items: { anyOf: [
                { const: "audit", title: "Audit" }, { const: "runtime", title: "Runtime" },
              ] } },
            }, required: ["region", "tags"],
          },
        },
        continuation: { connectorState: "opaque-state" },
      };
      const content = invocation.interaction.content as Record<string, unknown> | undefined;
      return { region: String(content?.region ?? "declined") };
    },
  };
  const plugin: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.interaction", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:interaction", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => { context.registrations.provide(TOOL_CAPABILITY, tool); return { dispose: () => undefined }; },
    },
  };
  const llm: LlmAdapter = {
    id: "interaction-model", model: "interaction-model",
    async *stream(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "final", content: null, finishReason: "tool_calls", status: "tool_calls", toolCalls: [
          { id: "interaction-call", name: tool.id, arguments: "{}" },
        ] };
        return;
      }
      assert.equal(request.messages.some((message) => message.role === "tool" && message.content?.includes("north")), true);
      yield { type: "final", content: "Đã tra cứu khu vực north", finishReason: "stop", status: "completed", toolCalls: [] };
    },
  };
  const host = new PluginHost();
  await host.activate([plugin, createEchoLlmPlugin(llm)], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  const runtimeRouter = routedHost(host);
  const agent = new DefaultAgentLoop(runtimeRouter, sessions);
  const owner = { ...security(), grantRevision: "interaction-grant" };
  const paused = await agent.runTurn({ sessionId: "interaction-session", content: "lookup", security: owner, idempotencyKey: "interaction-start" });
  assert.equal(paused.outcome, "awaiting_interaction");
  assert.equal(paused.interaction?.kind, "form");
  assert.equal(paused.interaction?.runtimeRouteRevision, "test-route-v1");
  assert.equal(executions, 1);
  assert.equal("continuation" in (paused.interaction as unknown as Record<string, unknown>), false);
  const requested = paused.events.find((event) => event.type === "interaction/requested");
  assert.deepEqual((requested?.payload as Record<string, unknown>).continuation, { connectorState: "opaque-state" });

  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2",
  }]);
  await assert.rejects(agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "north", tags: ["audit"] },
    security: owner, idempotencyKey: "interaction-wrong-route",
  }), /binding is stale/i);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1",
  }]);

  await assert.rejects(agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "north", tags: ["audit"], note: "x".repeat(33_000) },
    security: owner, idempotencyKey: "interaction-oversized",
  }), /exceeds 32 KiB/i);
  assert.equal(executions, 1);
  await assert.rejects(agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "east", tags: ["audit"] }, security: owner, idempotencyKey: "interaction-invalid",
  }), /outside its choices/i);
  assert.equal(executions, 1);
  const resumed = await agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "north", tags: ["audit"] }, security: owner, idempotencyKey: "interaction-resume",
  });
  assert.equal(resumed.outcome, "completed");
  assert.equal(resumed.content, "Đã tra cứu khu vực north");
  assert.equal(executions, 2);
  assert.equal(resumed.events.some((event) => event.type === "interaction/resolved"), true);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v2",
  }]);
  const replay = await agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "north", tags: ["audit"] }, security: owner, idempotencyKey: "interaction-resume",
  });
  assert.equal(replay.replayed, true);
  assert.equal(executions, 2);
  runtimeRouter.replaceRoutes([{
    tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1",
  }]);
  await assert.rejects(agent.resumeInteraction({
    sessionId: "interaction-session", interactionId: paused.interaction!.interactionId,
    action: "accept", content: { region: "north" }, security: owner, idempotencyKey: "interaction-reuse",
  }), /already been resolved/i);
  await host.shutdown();
});

test("interaction data that changes a side-effect action requires a response-bound approval", async () => {
  let executions = 0;
  let modelCalls = 0;
  const tool: ToolDefinition = {
    id: "interactive_write", version: "1.0.0", description: "writes to a user-selected target",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
    requiredPermissions: [], sideEffect: "nonIdempotent", timeoutMs: 100,
    execute: async (invocation) => {
      executions += 1;
      if (!invocation.interaction) return {
        protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required",
        request: { kind: "form", message: "Choose target", requestedSchema: {
          type: "object", properties: { target: { type: "string", enum: ["A", "B"] } }, required: ["target"],
        } },
        continuation: { phase: "target-selection" },
      };
      return { target: String((invocation.interaction.content as Record<string, unknown>).target) };
    },
  };
  const plugin: PluginDescriptor = {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: "io.syncroot.test.interactive-write", version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: "builtin:interactive-write", signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => { context.registrations.provide(TOOL_CAPABILITY, tool); return { dispose: () => undefined }; },
    },
  };
  const llm: LlmAdapter = {
    id: "interactive-write-model", model: "interactive-write-model",
    async *stream() {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "final", content: null, finishReason: "tool_calls", status: "tool_calls", toolCalls: [
          { id: "interactive-write-call", name: tool.id, arguments: "{}" },
        ] };
      } else yield { type: "final", content: "write complete", finishReason: "stop", status: "completed", toolCalls: [] };
    },
  };
  const host = new PluginHost();
  await host.activate([plugin, createEchoLlmPlugin(llm)], { security: security(), verifyArtifact: async () => true });
  const sessions = new InMemorySessionStore();
  const agent = new DefaultAgentLoop(routedHost(host), sessions);
  const owner = { ...security(), grantRevision: "interactive-write-grant" };
  const firstApproval = await agent.runTurn({ sessionId: "interactive-write-session", content: "write", security: owner, idempotencyKey: "write-start" });
  assert.equal(firstApproval.outcome, "awaiting_approval");
  assert.equal(executions, 0);
  const interaction = await agent.resumeTurn({
    sessionId: "interactive-write-session", approvalId: firstApproval.approval!.approvalId,
    decision: "approve", security: owner, idempotencyKey: "write-first-approval",
  });
  assert.equal(interaction.outcome, "awaiting_interaction");
  assert.equal(executions, 1);
  const responseApproval = await agent.resumeInteraction({
    sessionId: "interactive-write-session", interactionId: interaction.interaction!.interactionId,
    action: "accept", content: { target: "B" }, security: owner, idempotencyKey: "write-target",
  });
  assert.equal(responseApproval.outcome, "awaiting_approval");
  assert.equal(responseApproval.content, "");
  assert.notEqual(responseApproval.approval!.actionDigest, firstApproval.approval!.actionDigest);
  assert.equal(executions, 1);
  const durableApproval = responseApproval.events.find((event) => event.type === "approval/requested" &&
    (event.payload as Record<string, unknown>).approvalId === responseApproval.approval!.approvalId);
  assert.equal(durableApproval?.classification, "confidential");
  assert.equal("interaction" in (responseApproval.approval as unknown as Record<string, unknown>), false);
  const completed = await agent.resumeTurn({
    sessionId: "interactive-write-session", approvalId: responseApproval.approval!.approvalId,
    decision: "approve", security: owner, idempotencyKey: "write-response-approval",
  });
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.content, "write complete");
  assert.equal(executions, 2);
  await host.shutdown();
});

test("tool execution crosses the broker port without coupling coordinator to transport", async () => {
  let localExecutions = 0;
  let brokerDispatches = 0;
  const tool: ToolDefinition = {
    id: "brokered", version: "1.0.0", description: "brokered tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "string" }, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async () => { localExecutions += 1; return "local"; },
  };
  const broker: ToolExecutionBroker = {
    dispatch: async (command) => {
      brokerDispatches += 1;
      assert.equal(command.definition.id, "brokered");
      assert.match(command.invocation.idempotencyKey, /^tool:/);
      return "isolated-result";
    },
  };
  const outcome = await new ToolExecutionCoordinator(
    [tool], resolveAgentOptions({}), undefined, broker,
  ).execute(
    { id: "broker-call", name: "brokered", arguments: "{}" },
    { sessionId: "broker-session", turnId: "broker-turn", stepId: "broker-step", security: security(), runtime: runtimeSnapshot() },
    new AbortController().signal,
  );
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.result, "isolated-result");
  assert.equal(brokerDispatches, 1);
  assert.equal(localExecutions, 0);
});

test("step budget grows while the agent keeps learning and holds while it repeats itself", () => {
  const budget = new StepBudget({ maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 3 });
  assert.equal(budget.granted, 4);
  assert.equal(budget.ceiling, 20);

  // A comfortable allowance stays silent and does not grow early.
  assert.equal(stepBudgetNotice(budget, 1), undefined);
  budget.recordStepOutcome(1, true);
  assert.equal(budget.granted, 4, "the allowance only grows as it runs low");

  // Approaching the end of an allowance that grows on its own is no limit, so nothing is said: "N steps left, otherwise
  // answer now" would contradict an audit saying "keep going".
  assert.equal(stepBudgetNotice(budget, 2), undefined);
  budget.recordStepOutcome(2, true);
  assert.equal(budget.granted, 7);
  assert.equal(isFinalStep(budget, 6), false);
  assert.equal(isFinalStep(budget, 7), true);

  // One repeated observation is ordinary and must not end the turn's growth.
  budget.recordStepOutcome(5, false);
  budget.recordStepOutcome(5, true);
  assert.equal(budget.granted, 10);

  // A run of them holds the allowance and says so, but a step that learns something again
  // clears the run: an early dry patch must not cap a turn that later finds real data.
  budget.recordStepOutcome(8, false);
  budget.recordStepOutcome(8, false);
  const stalled = stepBudgetNotice(budget, 8) ?? "";
  assert.match(stalled, /The last 2 steps returned only observations this turn already had/);
  assert.match(stalled, /only grows on steps that observe something new/);
  budget.recordStepOutcome(8, true);
  assert.equal(budget.granted, 13, "progress after a dry patch restores the allowance");
});

test("a circling agent is told so even while its allowance is comfortable — from the second repeat", () => {
  const budget = new StepBudget({ maxSteps: 40, initialStepBudget: 12, stepBudgetExtension: 4 });
  assert.equal(stepBudgetNotice(budget, 1), undefined, "an agent that is learning and has room is left alone");

  // One repeat is ordinary (a read confirming what is known); told at the first one, the model reads "answer now"
  // beside an audit saying "keep going". Circling is still told long before the room runs out.
  budget.recordStepOutcome(1, false);
  assert.equal(stepBudgetNotice(budget, 2), undefined, "a single repeat is not circling");
  budget.recordStepOutcome(2, false);
  const notice = stepBudgetNotice(budget, 3) ?? "";
  assert.match(notice, /The last 2 steps returned only observations this turn already had/);
  assert.doesNotMatch(notice, /step\(s\) left/, "there is no shortage to report yet");

  budget.recordStepOutcome(3, true);
  assert.equal(stepBudgetNotice(budget, 4), undefined, "one useful step clears the warning");
});

test("a turn that runs out of time is reported as a timeout, not as an internal defect", () => {
  // `AbortSignal.timeout` aborts with a DOMException, and the use cases used to rethrow it
  // raw: the HTTP boundary then reported a turn that simply ran long as an unclassified 500,
  // which tells the caller nothing and marks a retryable failure as permanent.
  const timedOut = agenticError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  assert.equal(timedOut.code, "timeout");
  assert.equal(timedOut.retryable, true);
  assert.equal((timedOut as { cause?: unknown }).cause instanceof Error, true, "the original failure stays attached");

  const cancelled = agenticError(Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal(cancelled.code, "cancelled");
  assert.equal(cancelled.retryable, false, "a cancelled turn is not retried on the caller's behalf");

  const already = new AgenticError("denied", "no");
  assert.equal(agenticError(already), already, "an error that already says what it is passes through unchanged");
  assert.equal(agenticError("boom").code, "permanent");
});

test("the silence watch aborts a quiet turn and leaves a turn that keeps reporting progress", async () => {
  const quiet = createSilenceWatch(30);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(quiet.signal.aborted, true);
  assert.equal((quiet.signal.reason as Error).name, "TimeoutError");
  quiet.stop();

  const working = createSilenceWatch(40);
  await new Promise((resolve) => setTimeout(resolve, 25));
  working.noteProgress();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(working.signal.aborted, false, "progress inside the window restarts it");
  working.stop();
});

test("a step the budget cut short never ends the turn in silence", () => {
  // The ordinary shape of a reply that is only tool calls: content is the empty string, not
  // null. `??` let that through, so the turn returned an empty answer — the panel said it had
  // finished and there was no message under it, which a user cannot tell from a hang.
  const onlyToolCalls = { type: "final", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }], finishReason: "tool_calls" } as never;
  const stopped = budgetFinal(onlyToolCalls);
  assert.equal(stopped.silent, true, "there was nothing the model wanted to say");
  assert.equal(stopped.final.toolCalls.length, 0, "no tool may run past the budget");
  assert.equal(stopped.final.finishReason, "step-budget");
  // The transcript keeps a note so the next turn can see what happened; it is not the answer.
  assert.match(stopped.final.content as string, /execution budget/u);

  // A model that did answer keeps its answer, and the turn is not treated as silent.
  const answered = budgetFinal({ type: "final", content: "Đã kiểm tra được một phần.", toolCalls: [], finishReason: "stop" } as never);
  assert.equal(answered.silent, false);
  assert.equal(answered.final.content, "Đã kiểm tra được một phần.");

  // Whitespace is not an answer either.
  assert.equal(budgetFinal({ type: "final", content: "  \n ", toolCalls: [], finishReason: "stop" } as never).silent, true);
});

test("publishing the plan does not cost the turn a step, and does not buy one either", () => {
  const budget = new StepBudget({ maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 3 });

  // The loop asks the agent to publish its plan before the first action and after every step.
  // A budget that charged a step for that would quietly shorten every turn that complied.
  budget.recordPlanningStep();
  assert.equal(isFinalStep(budget, 4), false, "the planning step was refunded");
  budget.recordPlanningStep();
  budget.recordPlanningStep();
  assert.equal(budget.granted, 7, "three plans, three refunds — and nothing more");

  // It is not progress either: restating intent observes nothing, so it must not extend the way
  // a real observation does, or a model could plan its way past any allowance.
  const working = new StepBudget({ maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 3 });
  working.recordStepOutcome(3, true);
  assert.equal(working.granted, 7, "an observation extends");

  // And it is not a stall: the note that tells the model it is circling must stay quiet.
  const planning = new StepBudget({ maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 3 });
  planning.recordPlanningStep();
  planning.recordPlanningStep();
  assert.doesNotMatch(stepBudgetNotice(planning, 2) ?? "", /only observations this turn already had/u);
  planning.recordStepOutcome(3, false);
  planning.recordStepOutcome(4, false);
  assert.match(stepBudgetNotice(planning, 4) ?? "", /only observations this turn already had/u,
    "real repetition is still called out");
});

test("step budget never exceeds the hard ceiling and resumes as a count, not an index", () => {
  const tight = new StepBudget({ maxSteps: 3, initialStepBudget: 8, stepBudgetExtension: 4 });
  assert.equal(tight.granted, 3, "the ceiling is the hard limit, not a suggestion");
  assert.equal(isFinalStep(tight, 3), true);

  const budget = new StepBudget({ maxSteps: 5, initialStepBudget: 4, stepBudgetExtension: 10 });
  budget.recordStepOutcome(2, true);
  assert.equal(budget.granted, 5);
  budget.recordStepOutcome(4, true);
  assert.equal(budget.granted, 5, "an extension is clamped to the ceiling");
  assert.equal(budget.remainingAfter(9), 0, "remaining never goes negative past the ceiling");

  // A turn resumed after an approval starts partway through, and must still get its work
  // steps rather than being treated as already out of allowance.
  const resumed = new StepBudget({ maxSteps: 20, initialStepBudget: 4, stepBudgetExtension: 4 }, 5);
  assert.equal(resumed.granted, 8);
  assert.equal(isFinalStep(resumed, 5), false, "a resumed turn is not immediately out of steps");
});

test("a step the runtime sent back is refunded, up to the ceiling, and is not counted as circling", () => {
  const budget = new StepBudget({ maxSteps: 6, initialStepBudget: 4, stepBudgetExtension: 2 });
  assert.equal(budget.granted, 4);
  budget.recordRejectedStep();
  assert.equal(budget.granted, 5, "the bounced lap is given back");
  budget.recordRejectedStep();
  budget.recordRejectedStep();
  assert.equal(budget.granted, 6, "never past the hard ceiling");
  assert.equal(stepBudgetNotice(budget, 1), undefined, "being sent back is not a stall and not a shortage");
});

test("a required tool choice is judged on acting calls: the plan update may come along, never stand in", () => {
  const echo: ToolDefinition = {
    id: "agentic_echo", version: "1.0.0", description: "echo", inputSchema: {}, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 100, execute: async () => null,
  };
  const isPlan = (name: string) => name === "plan_update";
  const named = { toolChoice: { name: "agentic_echo" } };
  assert.equal(toolChoiceViolation(named, [echo], [{ name: "plan_update" }, { name: "agentic_echo" }], isPlan), undefined,
    "the plan beside the required call is narration, not another tool");
  assert.match(toolChoiceViolation(named, [echo], [{ name: "plan_update" }], isPlan) ?? "", /requires the selected tool/u,
    "the plan alone does not satisfy the choice");
  assert.match(toolChoiceViolation(named, [echo], [{ name: "plan_update" }, { name: "other" }], isPlan) ?? "", /requires the selected tool/u);
  assert.equal(toolChoiceViolation({ toolChoice: "required" }, [echo], [{ name: "plan_update" }, { name: "agentic_echo" }], isPlan), undefined);
  assert.match(toolChoiceViolation({ toolChoice: "required" }, [echo], [{ name: "plan_update" }], isPlan) ?? "", /requires a tool call/u);
});

test("a policy's own read runs before the model step, journaled as the policy's, and its reviews see it", async () => {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "observed", model: "observed", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        yield { type: "final", content: null, toolCalls: [{ id: "write-1", name: "agentic_echo", arguments: '{"value":"written"}' }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: "done" };
      yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const observationOf = (events: readonly SessionEvent[]) => events.find((event) =>
    event.type === "tool/result" && (event.payload as Record<string, unknown>).initiator === "policy");
  const policy: TurnControlPolicy = {
    id: "test.observing", revision: "v1",
    // The write happened in step 1; before step 2's model call the policy reads it back itself.
    beforeModelStep: async (state) => state.context.events.some((event) => event.type === "tool/result") && !observationOf(state.context.events)
      ? { observations: [{ toolId: "agentic_echo", arguments: { value: "readback" }, reason: "verify the write" }] }
      : {},
    // Judged on the state the policy is handed: it must already hold the read it asked for.
    reviewTerminal: async (state) => (observationOf(state.context.events)?.payload as Record<string, unknown> | undefined)?.result === "readback"
      ? { decision: "accept", reason: "read back" }
      : { decision: "continue", feedback: "The read-back is missing from the state under review." },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const progress: AgentProgressEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4 }, { turnControlPolicy: policy })
    .runTurn({ sessionId: "observed-turn", content: "work", security: security(), onProgress: (event) => progress.push(event) });
  assert.equal(result.content, "done");
  const intent = result.events.find((event) => event.type === "tool/intent" && (event.payload as Record<string, unknown>).initiator === "policy");
  assert.ok(intent, "the read is journaled as an intent the policy initiated");
  assert.equal((intent.payload as Record<string, unknown>).policyId, "test.observing");
  assert.equal((intent.payload as Record<string, unknown>).reason, "verify the write");
  assert.equal((intent.payload as Record<string, unknown>).arguments, '{"value":"readback"}');
  const observed = observationOf(result.events);
  assert.equal((observed?.payload as Record<string, unknown>).result, "readback");
  assert.equal((observed?.payload as Record<string, unknown>).dispatched, true);
  // Not put in the model's mouth, and not an orphan tool message a provider would reject: the
  // model is told the runtime read it, and what it read.
  const secondRequest = requests[1]?.messages ?? [];
  const evidence = secondRequest.find((message) => message.context?.provenance === "policy-observation");
  assert.equal(evidence?.role, "user");
  assert.match(evidence?.content ?? "", /performed by the runtime, not by you — tool agentic_echo with arguments \{"value":"readback"\} \(verify the write\)[\s\S]*"readback"/u);
  assert.equal(secondRequest.some((message) => message.role === "tool" && message.toolCallId?.startsWith("observe-")), false);
  assert.equal(secondRequest.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id.startsWith("observe-"))), false);
  assert.equal(result.events.filter((event) => event.type === "assistant/message").length, 2, "the answer passed review at the first attempt");
  assert.equal(requests.length, 2, "no step was spent on a review that could not see the read");
  assert.equal(result.events.some((event) => event.type === "turn/control-decision" && (event.payload as Record<string, unknown>).decision === "continue"), false);
  const decision = result.events.find((event) => event.type === "turn/control-decision" && (event.payload as Record<string, unknown>).phase === "before-model"
    && Array.isArray((event.payload as Record<string, unknown>).observations));
  assert.deepEqual((decision?.payload as Record<string, unknown>).observations, ["agentic_echo"]);
  assert.ok(progress.some((event) => event.type === "tool-started" && event.initiator === "policy" && event.toolId === "agentic_echo"));
  assert.ok(progress.some((event) => event.type === "tool-completed" && event.initiator === "policy"));
  await host.shutdown();
});

test("a tool result over budget is cut at its largest list and the cut is told to the model in the step and in every replay", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({ employeeCode: `SHCB${String(index).padStart(3, "0")}`, fullName: `Nhân viên ${index}`, workdays: 22 }));
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "cutting", model: "cutting", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        yield { type: "final", content: null, toolCalls: [{ id: "big", name: "agentic_echo", arguments: JSON.stringify({ value: { message: "Bảng công tháng 08/2026", payload: rows } }) }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: "done" };
      yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const telemetry: AgentTelemetryEvent[] = [];
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 4, maxToolResultChars: 4_000 }, { telemetry: { record: (event) => { telemetry.push(event); } } })
    .runTurn({ sessionId: "cut-turn", content: "work", security: security() });
  assert.equal(result.content, "done");
  const cutEvent = telemetry.find((event) => event.type === "agent.tool.truncated");
  assert.ok(cutEvent && cutEvent.type === "agent.tool.truncated");
  assert.deepEqual([cutEvent.toolId, cutEvent.path, cutEvent.total, cutEvent.limitChars], ["agentic_echo", "payload", 300, 4_000]);
  assert.ok(cutEvent.shown > 0 && cutEvent.shown < 300);
  const endEvent = telemetry.find((event) => event.type === "agent.turn.ended");
  assert.ok(endEvent && endEvent.type === "agent.turn.ended");
  assert.deepEqual([endEvent.outcome, endEvent.reason], ["completed", "stop"]);
  assert.doesNotMatch(JSON.stringify(telemetry), /SHCB|Nhân viên/u, "telemetry carries counts, never rows");
  const journaled = result.events.find((event) => event.type === "tool/result")?.payload as Record<string, unknown>;
  assert.equal(journaled.state, "succeeded", "a result that can be shortened is never a failed call");
  const kept = (journaled.result as { payload: unknown[]; message: string });
  assert.equal(kept.message, "Bảng công tháng 08/2026", "everything but the cut list is kept");
  assert.ok(kept.payload.length > 0 && kept.payload.length < 300, `a prefix, not nothing: ${kept.payload.length}`);
  assert.deepEqual(kept.payload[0], rows[0], "rows are kept whole and in order");
  assert.ok(JSON.stringify(journaled.result).length <= 4_000);
  assert.deepEqual(journaled.truncated, [{ path: "payload", shown: kept.payload.length, total: 300, digest: sha256(rows) }],
    "the cut names the whole list by its hash, so a later identical read is known to hide the same rows");
  // The model reads the cut under the result — in the step that ran the tool and in the replay
  // of the journal on later steps, which is what a resumed or compacted turn sees.
  const replay = requests[1]?.messages.find((message) => message.role === "tool" && message.toolCallId === "big");
  assert.match(replay?.content ?? "", new RegExp(`\\n\\[Result too large: list payload shows only ${kept.payload.length} of 300 entries; the rest were not read\\.`, "u"));
  assert.ok(replay?.content.startsWith(JSON.stringify(journaled.result)), "the data itself is what the journal holds");
  const note = (replay?.content ?? "").slice(JSON.stringify(journaled.result).length);
  assert.match(note, new RegExp(`say plainly that ${kept.payload.length} of 300 were seen`, "u"), "the way out every answer has: saying how much was seen");
  assert.doesNotMatch(note, /department|employee|page\b/u, "the runtime knows no tool's filters, so it promises none");
  assert.doesNotMatch(note, /[\u00C0-\u1EF9]/u, "the model-facing note is English: the model answers in the user's language");
  await host.shutdown();
});

test("a policy may only observe through side-effect-free tools the session carries, and a choice-violation fallback never denies a write that ran", async () => {
  const echo: ToolDefinition = {
    id: "agentic_echo", version: "1.0.0", description: "echo", inputSchema: {}, outputSchema: {},
    requiredPermissions: [], sideEffect: "none", timeoutMs: 1_000, execute: async () => null,
  };
  const write: ToolDefinition = { ...echo, id: "agentic_write", sideEffect: "idempotent" };
  const state = (events: readonly SessionEvent[]) => ({
    sessionId: "s", turnId: "t", stepIndex: 2, maxSteps: 4, security: security(), runtime: { id: "r" } as never,
    context: { events }, taskTurnIds: ["t"], availableTools: [{ id: echo.id, version: echo.version, sideEffect: echo.sideEffect }, { id: write.id, version: write.version, sideEffect: write.sideEffect }],
  });
  const policyWith = (directive: unknown): TurnControlPolicy => ({
    id: "test.observer", revision: "v1", beforeModelStep: async () => directive as never, reviewTerminal: async () => ({ decision: "accept" }),
  });
  const signal = new AbortController().signal;
  await assert.rejects(resolveTurnDirective(policyWith({ observations: [{ toolId: write.id, arguments: {}, reason: "x" }] }), state([]), [echo, write], signal), /side-effect free/u);
  await assert.rejects(resolveTurnDirective(policyWith({ observations: [{ toolId: "missing", arguments: {}, reason: "x" }] }), state([]), [echo, write], signal), /does not carry/u);
  await assert.rejects(resolveTurnDirective(policyWith({ observations: [{ toolId: echo.id, arguments: [], reason: "x" }] }), state([]), [echo, write], signal), /must be an object/u);
  await assert.rejects(resolveTurnDirective(policyWith({ observations: [{ toolId: echo.id, arguments: {} }] }), state([]), [echo, write], signal), /observation reason/u);
  const accepted = await resolveTurnDirective(policyWith({ observations: [{ toolId: echo.id, arguments: { value: 1 }, reason: "x" }] }), state([]), [echo, write], signal);
  assert.deepEqual(accepted.directive.observations, [{ toolId: echo.id, arguments: { value: 1 }, reason: "x" }]);
  assert.deepEqual(accepted.tools.map((tool) => tool.id), [echo.id, write.id], "observing does not narrow what the model may call");

  // A required call the model ignored, right after a write that reached the source: the
  // fallback used to say nothing had changed. The sentence is the product's now, and it is told
  // whether a write went out; core itself writes no user-facing copy.
  const journal = (dispatched: boolean): SessionEvent[] => [
    { type: "tool/intent", turnId: "t", callId: "w", payload: { toolId: write.id, sideEffect: "idempotent" } } as never,
    { type: "tool/result", turnId: "t", callId: "w", payload: { toolId: write.id, state: "succeeded", dispatched } } as never,
  ];
  const told: boolean[] = [];
  const withSentence: TurnControlPolicy = { ...policyWith({}), fallbackText: ({ writesDispatched }) => {
    told.push(writesDispatched);
    return writesDispatched ? "writes-went-out" : "nothing-changed";
  } };
  const review = (policy: TurnControlPolicy, events: readonly SessionEvent[]) => reviewTurnOutput({
    policy, state: state(events), directive: { toolChoice: "required" }, selectedTools: [echo],
    candidate: { content: "Xong.", finishReason: "stop", toolCalls: [] }, finalBudgetStep: false, objections: { heard: 0, fallbackDue: false, spent: false }, signal,
  });
  const afterWrite = await review(withSentence, journal(true));
  assert.equal(afterWrite.kind === "continue" ? afterWrite.fallback : undefined, "writes-went-out");
  const declined = await review(withSentence, journal(false));
  assert.equal(declined.kind === "continue" ? declined.fallback : undefined, "nothing-changed");
  assert.deepEqual(told, [true, false]);
  const silent = await review(policyWith({}), journal(true));
  assert.equal(silent.kind === "continue" ? silent.fallback : undefined, "", "without the product's sentence the fallback is empty, never core copy");
});

test("a tool result whose only list entry is itself over budget is refused, not emptied", () => {
  // A scanned document comes back as one image content block. The cut used to be allowed to reach
  // zero, which turned that into an empty list plus a note saying nothing had been read — the
  // model cannot tell that from a tool that legitimately found nothing, and the block it would
  // need to fetch the picture again was gone with it.
  const scan = {
    content: [{ type: "image", data: "A".repeat(40_000), mimeType: "image/png" }],
    structuredContent: { documentId: "DOC-1", kind: "image", resourceUri: "document://abc" },
  };
  const bounded = boundToolResult(scan as unknown as JsonValue, 32_000);
  const content = (bounded.value as { content: readonly unknown[] }).content;
  assert.equal(content.length, 1, "the one entry must survive rather than be cut away");
  assert.deepEqual(bounded.marks, [], "an unbounded result carries no truncation marks, so the caller refuses it out loud");

  // Small enough to send: untouched, no marks.
  const small = { content: [{ type: "image", data: "A".repeat(1_000), mimeType: "image/png" }] };
  const fits = boundToolResult(small as unknown as JsonValue, 32_000);
  assert.deepEqual(fits.value, small);
  assert.deepEqual(fits.marks, []);

  // An ordinary list of rows still gets cut, with a mark, exactly as before.
  const table = { rows: Array.from({ length: 500 }, (_, index) => ({ index, text: "x".repeat(200) })) };
  const cut = boundToolResult(table as unknown as JsonValue, 32_000);
  const rows = (cut.value as { rows: readonly unknown[] }).rows;
  assert.ok(rows.length > 0 && rows.length < 500, `expected a partial list, got ${rows.length} of 500`);
  assert.equal(cut.marks[0]?.total, 500);
});

test("a schema annotation is accepted and asserts nothing", () => {
  const validator = new JsonSchemaToolInputValidator();
  // What a server generating schemas from a typed language emits: the C# MCP SDK writes exactly
  // this for a DateTimeOffset. Refusing it used to fail the whole tool catalogue of such a server.
  const schema = {
    type: "object",
    properties: { createdAt: { type: "string", format: "date-time" }, note: { type: "string", deprecated: true } },
  } as unknown as JsonValue;
  assert.doesNotThrow(() => validator.validateSchema(schema));

  // Accepted, not enforced: `format` is an annotation, so a value that does not match it still
  // validates. Pretending otherwise would reject data the schema never actually constrained.
  assert.doesNotThrow(() => validator.validate(schema, { createdAt: "not a date", note: "x" } as unknown as JsonValue));

  // A nullable parameter: `["string","null"]` is how JSON Schema spells it, and what the C# MCP SDK
  // emits for a `string?`. Both members validate, and the constraints of the matching branch apply.
  const nullable = { type: "object", properties: { period: { type: ["string", "null"], minLength: 4 } } } as unknown as JsonValue;
  assert.doesNotThrow(() => validator.validateSchema(nullable));
  assert.doesNotThrow(() => validator.validate(nullable, { period: "2027" } as unknown as JsonValue));
  assert.doesNotThrow(() => validator.validate(nullable, { period: null } as unknown as JsonValue));
  assert.throws(() => validator.validate(nullable, { period: 2027 } as unknown as JsonValue), /must be one of string, null/u);
  // The matching branch still constrains: a string shorter than minLength fails as it would alone.
  assert.throws(() => validator.validate(nullable, { period: "27" } as unknown as JsonValue), /at least 4 characters/u);

  // A keyword that genuinely constrains and is not implemented is still refused, so an unenforceable
  // constraint can never pass silently.
  assert.throws(
    () => validator.validateSchema({ type: "string", multipleOf: 3 } as unknown as JsonValue),
    /Unsupported JSON Schema keyword at \$: multipleOf/u,
  );
});

test("a cut result is kept, named in the note, and the model reads the rest with read_result until done", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({ employeeCode: `SHCB${String(index).padStart(3, "0")}`, fullName: `Nhân viên ${index}`, workdays: 22 }));
  const spool = new InMemoryToolResultSpool();
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const pages: Record<string, unknown>[] = [];
  let modelCall = 0;
  const scripted: LlmAdapter = {
    id: "paging", model: "paging", features: { toolChoice: true },
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request); modelCall += 1;
      if (modelCall === 1) {
        yield { type: "final", content: null, toolCalls: [{ id: "big", name: "agentic_echo", arguments: JSON.stringify({ value: { payload: rows } }) }], finishReason: "tool_calls" };
        return;
      }
      const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
      const content = lastTool?.content ?? "";
      const resultId = /"resultId":"(res_[a-f0-9]+)"/u.exec(content)?.[1];
      const next = /"nextOffset":(\d+)/u.exec(content);
      const start = /"path":"payload","offset":(\d+)\}/u.exec(content);
      const offset = next ? Number(next[1]) : start ? Number(start[1]) : undefined;
      if (resultId && offset !== undefined && !content.includes('"done":true')) {
        pages.push({ resultId, offset });
        yield { type: "final", content: null, toolCalls: [{ id: `page-${modelCall}`, name: "read_result", arguments: JSON.stringify({ resultId, path: "payload", offset, limit: 100 }) }], finishReason: "tool_calls" };
        return;
      }
      yield { type: "text-delta", delta: "done" };
      yield { type: "final", content: "done", toolCalls: [], finishReason: "stop", status: "completed" };
    },
  };
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createReadResultToolPlugin(spool), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
  const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 40, maxToolCalls: 40, maxToolResultChars: 4_000 }, { toolResultSpool: spool })
    .runTurn({ sessionId: "paging-turn", content: "work", security: security() });
  assert.equal(result.content, "done");
  const results = result.events.filter((event) => event.type === "tool/result").map((event) => event.payload as Record<string, unknown>);
  const first = results[0]!;
  const mark = (first.truncated as { path: string; shown: number; total: number; resultId?: string }[])[0]!;
  assert.match(mark.resultId ?? "", /^res_/u);
  const read = results.filter((payload) => payload.toolId === "read_result").map((payload) => payload.result as { offset: number; returned: number; rows: { employeeCode: string }[]; done: boolean });
  assert.ok(read.length >= 2, "more than one page was needed under a 4,000-character budget");
  assert.equal(read[0]!.offset, mark.shown, "reading starts where the cut left off");
  const seen = [...(first.result as { payload: { employeeCode: string }[] }).payload, ...read.flatMap((page) => page.rows)];
  assert.deepEqual(seen.map((row) => row.employeeCode), rows.map((row) => row.employeeCode), "every row arrives once, in order");
  assert.equal(read.at(-1)!.done, true);
  assert.ok(results.every((payload) => payload.state === "succeeded"));
  await host.shutdown();
});

test("read_result refuses another session's result and says plainly when a result is gone", async () => {
  const spool = new InMemoryToolResultSpool({ maxEntries: 1 });
  const mine = spool.put({ tenantId: "t", sessionId: "a" }, { toolId: "x", value: { payload: [1, 2, 3] } });
  assert.equal(spool.get({ tenantId: "t", sessionId: "b" }, mine), undefined, "another session reads nothing");
  assert.equal(spool.get({ tenantId: "u", sessionId: "a" }, mine), undefined, "another tenant reads nothing");
  spool.put({ tenantId: "t", sessionId: "a" }, { toolId: "x", value: { payload: [4] } });
  assert.equal(spool.get({ tenantId: "t", sessionId: "a" }, mine), undefined, "the oldest entry is evicted past the bound");
  const tool = createReadResultTool(spool);
  await assert.rejects(() => Promise.resolve(tool.execute({ callId: "c", sessionId: "a", turnId: "t", stepId: "s", idempotencyKey: "k",
    arguments: { resultId: mine, path: "payload" }, security: security() } as never, new AbortController().signal)), /is not stored\. It expired or the service restarted/u);
  // The near-miss names only this session's ids: another session's result is never suggested.
  const other = spool.put({ tenantId: "t", sessionId: "b" }, { toolId: "x", value: 1 });
  await assert.rejects(() => Promise.resolve(tool.execute({ callId: "c", sessionId: "a", turnId: "t", stepId: "s", idempotencyKey: "k",
    arguments: { resultId: other.replace(/.$/u, "z") }, security: security() } as never, new AbortController().signal)), (error: Error) => !error.message.includes(other));
});

// ---- E1: a turn that used every step must still answer, and never in markup. ----

/** The words that identify the final step's instruction, and the re-ask after a reply that called a tool. */
const LAST_STEP_MARK = "This is the last model step of this turn";
const CALLED_A_TOOL_MARK = "Your previous reply was a tool call";

type ScriptedRequest = Parameters<LlmAdapter["stream"]>[0];

/** A model in the middle of a long read: it calls a tool on every step it is offered one, noting what it found. */
function scrollingModel(onFinalStep: (request: ScriptedRequest, finalCall: number) => LlmStreamEvent): { adapter: LlmAdapter; requests: ScriptedRequest[] } {
  const requests: ScriptedRequest[] = [];
  let finalCalls = 0;
  const adapter: LlmAdapter = {
    id: "scrolling", model: "scripted-test",
    async *stream(request): AsyncIterable<LlmStreamEvent> {
      requests.push(request);
      if (request.tools.length > 0) {
        const step = requests.length;
        yield { type: "final", content: step === 2 ? "Đã thêm NV901 Nhân Viên Mẫu E 810.000." : "",
          toolCalls: [{ id: `scroll-${step}`, name: "agentic_echo", arguments: JSON.stringify({ value: `trang ${step}` }) }], finishReason: "tool_calls" };
        return;
      }
      finalCalls += 1;
      yield onFinalStep(request, finalCalls);
    },
  };
  return { adapter, requests };
}

async function runScrollingTurn(adapter: LlmAdapter, sessionId: string, maxSteps = 4) {
  const host = new PluginHost();
  await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(adapter)], { security: security(), verifyArtifact: async () => true });
  try {
    return await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps, initialStepBudget: maxSteps }).runTurn({
      sessionId, content: "Liệt kê nhân viên có phụ cấp ăn trưa lớn hơn 700.000", security: security(),
    });
  } finally {
    await host.shutdown();
  }
}

const textCallReply = (prose: string): LlmStreamEvent => ({
  // What the DeepSeek adapter makes of `prose` + a DSML envelope it can read: the prose and the call.
  type: "final", content: prose, finishReason: "tool_calls", status: "tool_calls",
  toolCalls: [{ id: "dsml:0", name: "agentic_echo", arguments: JSON.stringify({ value: "trang tiếp" }) }],
});
const ANSWER = "Các cán bộ có phụ cấp ăn trưa trên 700.000 đã rà được: NV901 (810.000), NV902 (745.000). Còn NV245–NV300 chưa rà.";

test("E1: the final step's instruction is the last thing the model reads, so it answers instead of writing its next call", async () => {
  // DeepSeek, replayed on a real last request of such a turn: with this instruction hoisted under the
  // system prompt it wrote the next scroll call as text 3 times of 3; moved last, it answered 3 of 3.
  // This model does the same: it answers only when the instruction is where it writes.
  const { adapter, requests } = scrollingModel((request) => {
    const last = request.messages.at(-1);
    return last?.role === "system" && last.content?.startsWith(LAST_STEP_MARK)
      ? { type: "final", content: ANSWER, toolCalls: [], finishReason: "stop" }
      : textCallReply("Đã thêm NV902 Nhân Viên Mẫu F 745.000.");
  });
  const result = await runScrollingTurn(adapter, "e1-position");
  assert.equal(result.content, ANSWER);
  const finalRequest = requests.find((request) => request.tools.length === 0)!;
  assert.equal(finalRequest.toolChoice, "none");
  assert.equal(finalRequest.messages[0]?.role, "system", "the system prompt still opens the request");
  const instruction = finalRequest.messages.at(-1)?.content ?? "";
  assert.match(instruction, /No tools exist any more/u);
  assert.match(instruction, /Đã thêm NV901 Nhân Viên Mẫu E 810\.000\./u, "the notes the model wrote while working come with it");
  assert.equal(requests.length, 4, "answered on the step the budget allowed, no re-ask needed");
});

test("E1: a silent last step at the hard ceiling is asked once more instead of ending the turn empty", async () => {
  // On the last step allowed, the adapter dropped an envelope it could not read, the reply was empty,
  // and refusing the re-ask because the ceiling was reached left the chat reading "no content".
  const { adapter, requests } = scrollingModel((_request, finalCall) => finalCall === 1
    ? { type: "final", content: null, toolCalls: [], finishReason: "stop", status: "completed" }
    : { type: "final", content: ANSWER, toolCalls: [], finishReason: "stop" });
  const result = await runScrollingTurn(adapter, "e1-silent-ceiling");
  assert.equal(result.content, ANSWER);
  assert.equal(requests.length, 5, "one step past the ceiling, and only one");
  const reask = requests.at(-1)!;
  assert.equal(reask.tools.length, 0, "the bought step can do nothing but answer");
  const tail = reask.messages.slice(-2).map((message) => message.content ?? "");
  assert.match(tail[0] ?? "", /No tools remain available for this turn/u);
  assert.match(tail[1] ?? "", new RegExp(LAST_STEP_MARK, "u"));
  assert.equal(result.events.filter((event) => event.type === "step/start").length, 5);
});

test("E1: a last step that writes a tool call is re-asked as a call, not delivered as its progress note", async () => {
  // The prose beside the call was "Đã thêm NV902 …" — the model narrating its next move. Delivered,
  // it ended a 32-step read on a progress note; dropped, on nothing. It is a note for the re-ask.
  const { adapter, requests } = scrollingModel((request, finalCall) => {
    if (finalCall === 1) return textCallReply("Đã thêm NV902 Nhân Viên Mẫu F 745.000.");
    const told = request.messages.some((message) => message.content?.includes(CALLED_A_TOOL_MARK));
    return told
      ? { type: "final", content: ANSWER, toolCalls: [], finishReason: "stop" }
      : textCallReply("Đã thêm NV245.");
  });
  const result = await runScrollingTurn(adapter, "e1-text-call");
  assert.equal(result.content, ANSWER);
  const reask = requests.at(-1)!;
  assert.equal(reask.messages.some((message) => message.content?.includes("was not delivered to the user")), false,
    "the progress note is never quoted back as an answer to resend");
  assert.match(reask.messages.at(-1)?.content ?? "", /Đã thêm NV902 Nhân Viên Mẫu F 745\.000\./u, "it is in the notes instead");
  assert.equal(result.events.filter((event) => event.type === "tool/result").length, 3, "no suppressed call ever ran");
});

test("E1: a model that never answers costs exactly one extra call and ends partial, without looping", async () => {
  const { adapter, requests } = scrollingModel(() => textCallReply(""));
  const result = await runScrollingTurn(adapter, "e1-never");
  assert.equal(result.outcome, "partial");
  assert.equal(result.content, "");
  assert.equal(requests.length, 5);
  assert.equal((result.events.at(-1)?.payload as Record<string, unknown>).decision, "budget-reached");
});

test("the loop's own step instructions keep their place after the conversation when the window trims it", () => {
  const instruction = (content: string, provenance: string) => ({
    role: "system" as const, content, context: { trust: "instruction" as const, retention: "required" as const, provenance },
  });
  const read = (id: string) => [
    { role: "assistant" as const, content: null, toolCalls: [{ id, name: "read", arguments: "{}" }] },
    { role: "tool" as const, toolCallId: id, content: "r".repeat(300) },
  ];
  const objection = instruction("objection from a policy", "turn-control:test@1");
  const bounded = new ContextWindowPolicy(1_400).apply([
    { role: "system", content: "system prompt" }, { role: "user", content: "request" },
    ...read("c1"), ...read("c2"), ...read("c3"), ...read("c4"),
    objection,
    instruction("final step", "agent-loop-budget"), instruction("must call x", "agent-loop:tool-choice"),
  ]);
  assert.ok(bounded.omittedMessages + bounded.clearedResults > 0, "the window did trim");
  assert.deepEqual(bounded.messages.slice(-2).map((message) => message.content), ["final step", "must call x"]);
  const firstUser = bounded.messages.findIndex((message) => message.role === "user");
  assert.ok(bounded.messages.indexOf(objection) < firstUser, "other system messages still lead the request");
  assert.ok(bounded.messages.findIndex((message) => message.content === "system prompt") < firstUser);
});

test("a step granted past the ceiling stays granted: nothing afterwards pulls the allowance back below it", () => {
  // The re-asked answer of a closing step at the ceiling, and a failed step's retry, run past it (turn-end.ts).
  const budget = new StepBudget({ maxSteps: 4, initialStepBudget: 4, stepBudgetExtension: 2 });
  assert.equal(isFinalStep(budget, 4), true);
  budget.grant(5, true);
  assert.equal(budget.granted, 5);
  assert.equal(isFinalStep(budget, 5), true, "it is offered no tools");
  budget.recordRejectedStep();
  budget.recordPlanningStep();
  budget.recordStepOutcome(5, true);
  budget.grant(7);
  assert.equal(budget.granted, 5, "a min against the ceiling would have ended the loop below the step it is running");
});

test("the model's own reads, new or repeated, never reset the objections to its answers", async () => {
  for (const changing of [true, false]) {
    let calls = 0;
    const scripted: LlmAdapter = {
      id: "progress-between-objections", model: "test",
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls++;
        if (calls % 2 === 1) {
          yield { type: "final", content: null, toolCalls: [{ id: `read-${calls}`, name: "agentic_echo",
            arguments: JSON.stringify({ value: changing ? `page-${calls}` : "same-page" }) }], finishReason: "tool_calls" };
        } else {
          yield { type: "final", content: calls < 10 ? "I will continue reading" : "Read all pages", toolCalls: [], finishReason: "stop", status: "completed" };
        }
      },
    };
    const policy: TurnControlPolicy = {
      id: "test.read-pages", revision: "1", beforeModelStep: async () => ({}),
      reviewTerminal: async ({ candidate }) => candidate.content === "Read all pages" ? { decision: "accept" }
        : { decision: "continue", feedback: "Read the remaining pages before concluding.", fallback: "Pages are incomplete." },
    };
    const host = new PluginHost();
    await host.activate([createSystemPromptPlugin(), createEchoToolPlugin(), createEchoLlmPlugin(scripted)], { security: security(), verifyArtifact: async () => true });
    try {
      const result = await new DefaultAgentLoop(routedHost(host), new InMemorySessionStore(), { maxSteps: 12 }, { turnControlPolicy: policy })
        .runTurn({ sessionId: `pages-${changing}`, content: "Read all pages", security: security() });
      assert.equal(result.outcome, "partial");
      assert.equal(result.content, "Pages are incomplete.");
      assert.equal(calls, 6, "two objections sent back, the third ends the turn: the model's reads, new or not, buy no more");
    } finally { await host.shutdown(); }
  }
});
