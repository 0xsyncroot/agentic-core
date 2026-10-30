import { CAPABILITIES, type ToolResultSpool } from "@0xsyncroot/contracts";
import { TOOL_CAPABILITY, type PluginDescriptor } from "@0xsyncroot/plugin-sdk";
import { createCalculationTool, type CalculationViews } from "./calculation-tool.js";

export { CALCULATE_TOOL_ID, createCalculationTool, type CalculationView, type CalculationViews } from "./calculation-tool.js";
export { runSandboxed, type SandboxLimits, type SandboxOutcome } from "./sandbox.js";

/** `calculate`, reading inputs from the runtime's result spool (the same store `read_result` pages through). */
export function createCalculationToolPlugin(spool: ToolResultSpool, options: CalculationViews = {}): PluginDescriptor {
  const id = "io.syncroot.calculation.quickjs";
  return {
    trustTier: "platform-core",
    manifest: {
      manifestVersion: 1, id, version: "0.1.0", publisher: "Agentic Platform", coreApi: "^1.0.0",
      artifact: { digest: `builtin:${id}@0.1.0`, signature: "trusted-assembly" },
      requires: {}, provides: { [CAPABILITIES.tools]: { version: "1.0.0", cardinality: "multi" } }, permissions: {},
    },
    plugin: {
      validate: async () => ({ valid: true }),
      activate: async (context) => {
        context.registrations.provide(TOOL_CAPABILITY, createCalculationTool(spool, undefined, options));
        return { dispose: () => undefined };
      },
      health: async () => ({ healthy: true }),
    },
  };
}
