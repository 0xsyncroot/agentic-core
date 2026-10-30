import type { LlmAdapter } from "@0xsyncroot/contracts";
import { LLM_CAPABILITY, type CapabilityToken, type PluginDescriptor, type ScopedPluginContext } from "@0xsyncroot/plugin-sdk";
import { LangfuseClient, type LangfuseIngestion } from "./langfuse-client.js";
import { loadLangfuseConfig, type LangfuseConfig } from "./langfuse-config.js";
import { traceLlmAdapter } from "./traced-llm-adapter.js";

export interface LangfuseTracing {
  readonly config: LangfuseConfig;
  readonly ingestion: LangfuseIngestion;
  /** Returns the same descriptor with its model adapter traced. The manifest is untouched. */
  decorate(descriptor: PluginDescriptor): PluginDescriptor;
  close(): Promise<void>;
}

export interface LangfuseTracingOptions {
  /** Path to langfuse.yaml. An absent file means this deployment traces nothing. */
  readonly configPath: string;
  /** The environment the named credentials are read from, passed in rather than reached for. */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly onError?: (error: Error, dropped: number) => void;
}

/**
 * Decorates a model plugin without touching its manifest.
 *
 * The wrapper intercepts only the capability registration: the plugin still declares the same
 * id, version, digest and signature, so artifact pinning keeps verifying the thing that was
 * actually built. Tracing is a composition decision, and it leaves no trace in the plugin's
 * identity — which is what stops "we turned tracing on" from reading as "someone shipped a
 * different model adapter".
 */
export function decorateWithLangfuse(descriptor: PluginDescriptor, tracing: {
  readonly config: LangfuseConfig; readonly ingestion: LangfuseIngestion;
}): PluginDescriptor {
  return Object.freeze({
    ...descriptor,
    plugin: {
      ...descriptor.plugin,
      activate: (context: ScopedPluginContext) => descriptor.plugin.activate({
        ...context,
        registrations: {
          provide: <T>(token: CapabilityToken<T>, value: T) => context.registrations.provide(
            token,
            token.id === LLM_CAPABILITY.id
              ? traceLlmAdapter(value as LlmAdapter, { ingestion: tracing.ingestion, config: tracing.config }) as T
              : value,
          ),
        },
      }),
    },
  });
}

/**
 * Builds tracing from the file, or reports that this deployment has none.
 *
 * Absent or disabled returns `undefined` rather than a no-op tracer: the caller then composes
 * the undecorated plugin, and nothing about the model path changes at all.
 */
export async function createLangfuseTracing(options: LangfuseTracingOptions): Promise<LangfuseTracing | undefined> {
  const config = await loadLangfuseConfig(options.configPath);
  if (!config || !config.enabled) return undefined;
  const ingestion = new LangfuseClient({
    config, env: options.env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return Object.freeze({
    config,
    ingestion,
    decorate: (descriptor: PluginDescriptor) => decorateWithLangfuse(descriptor, { config, ingestion }),
    close: () => ingestion.close(),
  });
}
