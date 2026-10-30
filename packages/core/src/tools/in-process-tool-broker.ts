import {
  TOOL_EXECUTION_RESPONSE_PROTOCOL,
  type ToolExecutionBroker,
  type ToolExecutionResponse,
} from "@0xsyncroot/contracts";

function executionResponse(value: Awaited<ReturnType<Parameters<ToolExecutionBroker["dispatch"]>[0]["definition"]["execute"]>>): ToolExecutionResponse {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      value.protocol === TOOL_EXECUTION_RESPONSE_PROTOCOL &&
      (value.kind === "completed" || value.kind === "interaction-required")) {
    return value as ToolExecutionResponse;
  }
  return { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed", result: value as import("@0xsyncroot/contracts").JsonValue };
}

/** Trusted built-in reference broker. Production can replace it with an isolated RPC adapter. */
export class InProcessToolExecutionBroker implements ToolExecutionBroker {
  async dispatch(command: Parameters<ToolExecutionBroker["dispatch"]>[0], signal: AbortSignal) {
    return executionResponse(await command.definition.execute(command.invocation, signal));
  }
}
