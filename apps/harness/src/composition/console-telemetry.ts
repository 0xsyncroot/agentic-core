import type { AgentTelemetryEvent, AgentTelemetrySink } from "@0xsyncroot/contracts";

/**
 * Writes the events an operator needs when an answer looks wrong — a cut tool result, a turn that
 * ended `partial` — as one JSON line each. Counts and identifiers only, like the ELK documents:
 * no rows, no arguments, no payroll values. Everything else is left to ELK, so a console stays
 * readable. Runs whether or not ELK is enabled.
 */
export function createDiagnosticConsoleSink(write: (line: string) => void = (line) => console.warn(line)): AgentTelemetrySink {
  return {
    record(event: AgentTelemetryEvent): void {
      const interesting = event.type === "agent.tool.truncated" || (event.type === "agent.turn.ended" && event.outcome === "partial");
      if (!interesting) return;
      try { write(`[agent] ${JSON.stringify(event)}`); } catch { /* A console must not fail a turn. */ }
    },
  };
}

/** One sink that forwards to each of the given ones; a sink that throws does not stop the others. */
export function teeTelemetry(...sinks: readonly (AgentTelemetrySink | undefined)[]): AgentTelemetrySink {
  const live = sinks.filter((sink): sink is AgentTelemetrySink => sink !== undefined);
  return {
    record(event: AgentTelemetryEvent): void {
      for (const sink of live) {
        try { void Promise.resolve(sink.record(event)).catch(() => undefined); } catch { /* Best effort, like the sinks. */ }
      }
    },
  };
}
