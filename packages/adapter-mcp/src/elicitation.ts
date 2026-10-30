import {
  AgenticError,
  TOOL_EXECUTION_RESPONSE_PROTOCOL,
  type JsonValue,
  type ToolHandlerResult,
  type ToolInvocation,
} from "@0xsyncroot/contracts";
import { mcpToolId } from "./shared.js";
import type { McpCallContinuation, McpClientPort, McpCallResult, NormalizedMcpLimits } from "./types.js";
import { mcpCompletedResult, withNextCall } from "./image-result.js";

interface StoredContinuation {
  readonly version: 1;
  readonly requestKey: string;
  readonly requestState?: string;
}

/**
 * Core's `ToolExecutionCoordinator` rejects a serialized `continuation` over `maxToolResultChars`
 * (default 32 000 — packages/core/src/agent/agent-options.ts) with `budget-exceeded`, failing the
 * turn instead of pausing it. `{"version":1,"requestKey":"<256 chars>","requestState":"<this>"}`
 * adds well under 500 characters of its own JSON structure/keys/quoting on top of `requestState`,
 * so this bound has to sit comfortably under core's, not just under this file's own former 32 768.
 */
const MAX_REQUEST_STATE_LENGTH = 31_000;

function record(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function continuation(invocation: ToolInvocation): McpCallContinuation | undefined {
  if (!invocation.interaction) return undefined;
  const stored = invocation.interaction.continuation;
  if (!record(stored) || stored.version !== 1 || typeof stored.requestKey !== "string" || !stored.requestKey || stored.requestKey.length > 256 ||
      (stored.requestState !== undefined && (typeof stored.requestState !== "string" || stored.requestState.length > MAX_REQUEST_STATE_LENGTH))) {
    throw new AgenticError("denied", "MCP interaction continuation is invalid");
  }
  const response: Record<string, JsonValue> = { action: invocation.interaction.action };
  if (invocation.interaction.content !== undefined) response.content = invocation.interaction.content;
  return {
    inputResponses: { [stored.requestKey]: response },
    ...(typeof stored.requestState === "string" ? { requestState: stored.requestState } : {}),
  };
}

function request(result: Extract<McpCallResult, { kind: "input-required" }>, limits: NormalizedMcpLimits, fallbackOrigin?: string): ToolHandlerResult {
  if (!limits.elicitationEnabled) throw new AgenticError("denied", "MCP elicitation is disabled for this connector");
  const entries = Object.entries(result.inputRequests);
  if (entries.length !== 1) throw new AgenticError("permanent", "MCP tool must request one durable interaction at a time");
  const [requestKey, inputRequest] = entries[0]!;
  if (!requestKey || requestKey.length > 256 ||
      (result.requestState !== undefined && (typeof result.requestState !== "string" || result.requestState.length > MAX_REQUEST_STATE_LENGTH))) {
    throw new AgenticError("validation", "MCP input-required continuation is invalid");
  }
  if (!record(inputRequest) || inputRequest.method !== "elicitation/create" || !record(inputRequest.params)) {
    throw new AgenticError("denied", "MCP requested an unsupported client interaction");
  }
  const params = inputRequest.params;
  const message = typeof params.message === "string" ? params.message : "";
  if (params.mode !== undefined && params.mode !== "form" && params.mode !== "url") {
    throw new AgenticError("denied", `Unsupported MCP elicitation mode: ${String(params.mode)}`);
  }
  const stored: StoredContinuation = {
    version: 1, requestKey, ...(result.requestState === undefined ? {} : { requestState: result.requestState }),
  };
  if (params.mode === "url") {
    if (typeof params.url !== "string") throw new AgenticError("validation", "MCP URL elicitation is incomplete");
    let url: URL;
    try { url = new URL(params.url); }
    catch { throw new AgenticError("validation", "MCP URL elicitation URL is invalid"); }
    const allowed = new Set([...limits.allowedUrlOrigins, ...(fallbackOrigin ? [fallbackOrigin] : [])]);
    if (!allowed.has(url.origin)) throw new AgenticError("denied", `MCP elicitation URL origin is not allowed: ${url.origin}`);
    return {
      protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required",
      request: {
        kind: "external", message, url: url.toString(),
        externalId: typeof params.elicitationId === "string" ? params.elicitationId : requestKey,
      },
      continuation: stored as unknown as JsonValue,
    };
  }
  if (!record(params.requestedSchema)) throw new AgenticError("validation", "MCP form elicitation is missing requestedSchema");
  return {
    protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "interaction-required",
    request: { kind: "form", message, requestedSchema: params.requestedSchema },
    continuation: stored as unknown as JsonValue,
  };
}

export async function executeMcpTool(
  client: McpClientPort,
  serverId: string,
  name: string,
  invocation: ToolInvocation,
  signal: AbortSignal,
  limits: NormalizedMcpLimits,
  fallbackOrigin?: string,
): Promise<ToolHandlerResult> {
  const result = await client.callTool(name, invocation.arguments, signal, continuation(invocation));
  if (record(result) && result.kind === "input-required") {
    return request(result as unknown as Extract<McpCallResult, { kind: "input-required" }>, limits, fallbackOrigin);
  }
  const completed = record(result) && result.kind === "completed" && "result" in result ? result.result : result;
  return withNextCall(mcpCompletedResult(completed, `MCP result ${mcpToolId(serverId, name)}`, limits.maxResultBytes), completed,
    (tool) => mcpToolId(serverId, tool));
}
