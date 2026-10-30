import type { AgentTelemetrySink } from "@0xsyncroot/contracts";
import { loadElkConfig } from "./elk-config.js";
import { ElkHttpTransport } from "./elk-http-transport.js";
import { ElkTelemetrySink } from "./elk-telemetry-sink.js";

export interface ElkTelemetryOptions {
  /** Path to elk.yaml. An absent file means this deployment ships no telemetry, not an error. */
  readonly configPath: string;
  /** The environment the named credentials are read from, passed in rather than reached for. */
  readonly env: NodeJS.ProcessEnv;
  readonly fields?: Readonly<Record<string, string>>;
  readonly onError?: (error: Error, dropped: number) => void;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ElkTelemetry {
  readonly sink: AgentTelemetrySink;
  close(): Promise<void>;
}

/**
 * Builds the sink from the file, or reports that there is nothing to build.
 *
 * A missing or disabled `elk.yaml` returns `undefined` rather than a silent no-op sink: the
 * caller then decides whether running without telemetry is acceptable for its profile, which
 * is a deployment decision and not this adapter's to make.
 */
export async function createElkTelemetrySink(options: ElkTelemetryOptions): Promise<ElkTelemetry | undefined> {
  const loaded = await loadElkConfig(options.configPath);
  if (!loaded || !loaded.enabled) return undefined;
  const config = options.fields ? { ...loaded, fields: Object.freeze({ ...loaded.fields, ...options.fields }) } : loaded;
  const transport = new ElkHttpTransport({
    config, env: options.env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const sink = new ElkTelemetrySink({
    config, transport, ...(options.onError ? { onError: options.onError } : {}),
  });
  return Object.freeze({ sink, close: () => sink.close() });
}
