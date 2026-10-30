import type { AgentProgressEvent, AgentTelemetryEvent, AgentTelemetrySink } from "@0xsyncroot/contracts";

interface ProgressObserver {
  readonly onProgress?: (event: AgentProgressEvent) => void;
}

/** Delivery and telemetry observers are deliberately outside the durable operation outcome. */
export function report(input: ProgressObserver, progress: AgentProgressEvent): void {
  try { input.onProgress?.(progress); } catch { /* Delivery observers are best effort. */ }
}

export function observe(sink: AgentTelemetrySink | undefined, event: AgentTelemetryEvent): void {
  try { void Promise.resolve(sink?.record(event)).catch(() => undefined); } catch { /* Telemetry is best effort. */ }
}
