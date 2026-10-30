import type { JsonValue, ToolDefinition } from "@0xsyncroot/contracts";

export function createEchoTool(): ToolDefinition {
  return {
    id: "agentic_echo", version: "1.0.0", description: "Return the supplied value unchanged. Used only to verify the tool loop.",
    inputSchema: { type: "object", properties: { value: { description: "Any JSON value" } }, required: ["value"], additionalProperties: false },
    outputSchema: {},
    requiredPermissions: ["tool.echo"], sideEffect: "none", timeoutMs: 1_000,
    execute: async (invocation): Promise<JsonValue> => {
      const args = invocation.arguments;
      return args && typeof args === "object" && !Array.isArray(args) && "value" in args ? (args.value as JsonValue) : null;
    },
  };
}
