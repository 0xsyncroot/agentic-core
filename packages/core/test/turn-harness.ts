import {
  CAPABILITIES, type LlmAdapter, type LlmStreamEvent, type SecurityContext, type SessionStore, type ToolDefinition,
  type WorkPlanningProvider, type WorkPlanProposal,
} from "@0xsyncroot/contracts";
import { createEchoLlmPlugin } from "@0xsyncroot/adapter-echo";
import { PluginHost, TenantRuntimeRouter } from "@0xsyncroot/core";
import { InMemorySessionStore } from "@0xsyncroot/persistence-memory";
import { TOOL_CAPABILITY, WORK_PLANNING_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";

export function security(overrides: Partial<SecurityContext> = {}): SecurityContext {
  return {
    tenantId: "tenant-a", actorId: "user-a", permissions: new Set(["tool.echo", "test.write"]),
    correlationId: crypto.randomUUID(), purpose: "test", grantRevision: "grant-1", ...overrides,
  };
}

/** Mounts tools as one platform plugin, the way products provide theirs. */
export function toolPlugin(id: string, tools: readonly ToolDefinition[]): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id: `io.syncroot.test.${id}`, version: "1.0.0", publisher: "test", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}`, signature: "test" }, requires: {},
      provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        for (const tool of tools) context.registrations.provide(TOOL_CAPABILITY, tool);
        return { dispose: () => undefined };
      },
    },
  };
}

/** A write the permission policy sends to approval. */
export function writeTool(onExecute: () => void = () => undefined): ToolDefinition {
  return {
    id: "test_write", version: "1.0.0", description: "writes one value",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    outputSchema: {}, requiredPermissions: ["test.write"], sideEffect: "idempotent", timeoutMs: 1_000,
    execute: async () => { onExecute(); return { written: true }; },
  };
}

/** An LLM that plays one scripted reply per call and records every request it was sent. */
export function scriptedModel(replies: readonly ((request: Parameters<LlmAdapter["stream"]>[0]) => LlmStreamEvent)[], features?: LlmAdapter["features"]) {
  const requests: Parameters<LlmAdapter["stream"]>[0][] = [];
  const adapter: LlmAdapter = {
    id: "scripted", model: "scripted", ...(features ? { features } : {}),
    async *stream(request) {
      requests.push(request);
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      yield reply(request);
    },
  };
  return { adapter, requests };
}

export function answer(content: string): () => LlmStreamEvent {
  return () => ({ type: "final", content, toolCalls: [], finishReason: "stop", status: "completed" });
}

/** Several tool calls in one step, the way a model that mixes a plan update with a lookup sends them. */
export function calls(entries: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[], content: string | null = null): () => LlmStreamEvent {
  return () => ({
    type: "final", content, finishReason: "tool_calls", status: "tool_calls",
    toolCalls: entries.map((entry) => ({ id: entry.id, name: entry.name, arguments: JSON.stringify(entry.args) })),
  });
}

export const PLAN_TOOL_ID = "test_plan_update";

/**
 * A work-plan tool the way the base plugin mounts one: the runtime applies every proposal itself
 * and never dispatches it, so `execute` here is only what a host running it directly would see.
 */
export function planningPlugin(): PluginDescriptor {
  const definition: ToolDefinition = {
    id: PLAN_TOOL_ID, version: "1.0.0", description: "plan",
    inputSchema: { type: "object" }, outputSchema: {}, requiredPermissions: [], sideEffect: "none", timeoutMs: 100,
    execute: async (invocation) => ({ ...(invocation.arguments as Record<string, unknown>), updatedAt: new Date().toISOString() }) as never,
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

/** A plan-update call for `planningPlugin()`'s tool, the shape `test_plan_update` accepts. */
export function planStep(
  callId: string, goal: string, steps: readonly { readonly id: string; readonly description: string; readonly status: string; readonly outcome?: string }[],
  content: string | null = null,
): () => LlmStreamEvent {
  return () => ({
    type: "final", content, finishReason: "tool_calls", status: "tool_calls",
    toolCalls: [{ id: callId, name: PLAN_TOOL_ID, arguments: JSON.stringify({ goal, steps }) }],
  });
}

export function call(id: string, name: string, args: Record<string, unknown>, content: string | null = null): () => LlmStreamEvent {
  return () => ({ type: "final", content, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: "tool_calls", status: "tool_calls" });
}

export async function activeHost(model: LlmAdapter, plugins: readonly PluginDescriptor[]) {
  const host = new PluginHost();
  await host.activate([...plugins, createEchoLlmPlugin(model)], { security: security(), verifyArtifact: async () => true });
  const router = new TenantRuntimeRouter([{ tenantId: "tenant-a", agentProfileId: "default", provider: host, routeRevision: "test-route-v1" }]);
  return { host, router };
}

/**
 * The real in-memory store, wrapped so a test can see what the runtime read from it. Calls the
 * store makes to itself are not counted: only what core asked for.
 */
export class SpyStore implements SessionStore {
  readonly inner = new InMemorySessionStore();
  loads = 0;
  contextReads = 0;
  sinceReads = 0;
  rowsRead = 0;

  load: SessionStore["load"] = async (...args) => { this.loads += 1; return this.inner.load(...args); };
  loadRecent: SessionStore["loadRecent"] = async (...args) => {
    const rows = await this.inner.loadRecent(...args);
    this.rowsRead += rows.length;
    return rows;
  };
  loadContext: SessionStore["loadContext"] = async (...args) => {
    this.contextReads += 1;
    const view = await this.inner.loadContext(...args);
    this.rowsRead += view.events.length;
    return view;
  };
  loadSince: SessionStore["loadSince"] = async (...args) => {
    this.sinceReads += 1;
    const rows = await this.inner.loadSince(...args);
    this.rowsRead += rows.length;
    return rows;
  };
  append: SessionStore["append"] = (...args) => this.inner.append(...args);
  claimTurn: SessionStore["claimTurn"] = (...args) => this.inner.claimTurn(...args);
  appendLeased: SessionStore["appendLeased"] = (...args) => this.inner.appendLeased(...args);
  renewTurn: SessionStore["renewTurn"] = (...args) => this.inner.renewTurn(...args);
  finishTurn: SessionStore["finishTurn"] = (...args) => this.inner.finishTurn(...args);

  reset(): void {
    this.loads = 0;
    this.contextReads = 0;
    this.sinceReads = 0;
    this.rowsRead = 0;
  }
}
