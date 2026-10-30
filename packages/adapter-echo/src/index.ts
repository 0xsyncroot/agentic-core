import type { LlmAdapter, LlmStreamEvent, ResolvedLlmModel } from "@0xsyncroot/contracts";
import { CAPABILITIES } from "@0xsyncroot/contracts";
import {
  LLM_CAPABILITY,
  TOOL_CAPABILITY,
  type AgentPlugin,
  type PluginDescriptor,
  type PluginManifest,
} from "@0xsyncroot/plugin-sdk";
import { createEchoTool } from "./echo-tool.js";

function descriptor(
  id: string,
  provides: NonNullable<PluginManifest["provides"]>,
  plugin: AgentPlugin,
  config?: PluginDescriptor["config"],
): PluginDescriptor {
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1,
      id,
      version: "0.1.0",
      publisher: "Agentic Platform",
      coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
      requires: {},
      provides,
      permissions: {},
    },
    plugin,
    ...(config ? { config } : {}),
  };
}

function plugin(activate: AgentPlugin["activate"]): AgentPlugin {
  return {
    validate: async () => ({ valid: true }),
    activate,
    health: async () => ({ healthy: true }),
  };
}

export class EchoLlmAdapter implements LlmAdapter {
  readonly id = "gateway.echo-llm";
  readonly providerId = "echo";
  readonly model = "echo-local";
  async resolveModel(): Promise<ResolvedLlmModel> {
    return {
      providerId: this.providerId, adapterId: this.id, modelId: this.model,
      routeRevision: "echo-local-v1", metadataSource: "adapter-catalog",
      contextWindowTokens: 40_000, estimatedCharsPerToken: 3,
    };
  }
  async *stream(request: Parameters<LlmAdapter["stream"]>[0]): AsyncIterable<LlmStreamEvent> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    yield { type: "final", content: `[echo] ${lastUser?.content ?? ""}`, toolCalls: [], finishReason: "stop", status: "completed", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}

export function createEchoLlmPlugin(adapter: LlmAdapter = new EchoLlmAdapter()): PluginDescriptor {
  return descriptor(
    "io.syncroot.adapter.echo-llm",
    { [CAPABILITIES.llm]: { version: "1.0.0", cardinality: "single" } },
    plugin(async (context) => {
      context.registrations.provide(LLM_CAPABILITY, adapter);
      return { dispose: () => undefined };
    }),
    { adapterId: adapter.id, model: adapter.model },
  );
}

export function createEchoToolPlugin(): PluginDescriptor {
  return descriptor(
    "io.syncroot.adapter.echo-tool",
    { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } },
    plugin(async (context) => {
      context.registrations.provide(TOOL_CAPABILITY, createEchoTool());
      return { dispose: () => undefined };
    }),
  );
}
