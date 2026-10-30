import type { ToolDefinition, ToolHandlerResult, ToolInvocation } from "./tool.js";

export interface ToolBrokerDispatch {
  readonly definition: ToolDefinition;
  readonly invocation: ToolInvocation;
}

/** Dispatch boundary. Production adapters may cross a process/service sandbox here. */
export interface ToolExecutionBroker {
  dispatch(command: ToolBrokerDispatch, signal: AbortSignal): Promise<ToolHandlerResult>;
}
