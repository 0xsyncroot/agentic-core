import { AgenticError, type ToolDefinition, type ToolSchema } from "@0xsyncroot/contracts";

/**
 * Every major model provider enforces this pattern on the function-call name, and `name` below is
 * minted straight from `tool.id` with no sanitizing — a tool source that violates it (e.g. a dotted
 * id) must fail loudly here, at the one place that builds the schema, rather than surface as a
 * provider request error that names an array index instead of the actual tool.
 */
const PROVIDER_FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function executionClass(tool: ToolDefinition): string {
  if (tool.sideEffect === "none") {
    return "Runtime classification: READ-ONLY. Use it to observe or resolve system-owned facts; policy may still require approval for protected sources.";
  }
  if (tool.sideEffect === "idempotent") {
    return "Runtime classification: MUTATION (idempotent). Do not use it for discovery; execution may require approval.";
  }
  return "Runtime classification: MUTATION (non-idempotent). Do not use it for discovery; execution may require approval.";
}

/** Gives the model the same high-level effect classification enforced by runtime policy. */
export function modelToolSchema(tool: ToolDefinition): ToolSchema {
  if (!PROVIDER_FUNCTION_NAME_PATTERN.test(tool.id)) {
    throw new AgenticError("validation", `Tool id "${tool.id}" is not a valid provider function name (must match ${PROVIDER_FUNCTION_NAME_PATTERN})`);
  }
  return Object.freeze({
    name: tool.id,
    description: `${executionClass(tool)}\n${tool.description}`,
    inputSchema: tool.modelInputSchema ?? tool.inputSchema,
  });
}
