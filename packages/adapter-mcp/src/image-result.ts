import { parseModelImages, TOOL_EXECUTION_RESPONSE_PROTOCOL, toolNextCallReads, type JsonValue, type ToolExecutionResponse, type ToolHandlerResult } from "@0xsyncroot/contracts";
import { boundedToolResult } from "./shared.js";

/** Translate MCP image blocks into the shared binary channel before applying text budgets. */
export function mcpCompletedResult(value: unknown, label: string, maxBytes: number): ToolHandlerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return boundedToolResult(value, label, maxBytes);
  const result = value as Record<string, JsonValue>;
  if (!Array.isArray(result.content)) return boundedToolResult(value, label, maxBytes);
  const images = result.content.filter((block) => block && typeof block === "object" && !Array.isArray(block) && block.type === "image");
  if (!images.length) return boundedToolResult(value, label, maxBytes);
  const parsed = parseModelImages(images.map((block) => {
    const image = block as Record<string, JsonValue>;
    return { mediaType: image.mimeType, data: image.data };
  }));
  return {
    protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed",
    result: boundedToolResult({ ...result, content: result.content.filter((block) => !images.includes(block)) }, label, maxBytes),
    images: parsed!,
  };
}

const isObject = (value: unknown): value is Record<string, JsonValue> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The read a result names next (`structuredContent.nextCall`: `tool`, `arguments`, `why`, optional `reads`), lifted into the
 * response the runtime reads (`ToolCompletedResponse.nextCall`). `tool` is a tool of the same server, by its MCP name; `toolId`
 * gives its id here. Anything else in that field names nothing; a `reads` the contract does not type is dropped and the call
 * stays. The result itself is left as the server sent it.
 */
export function withNextCall(response: ToolHandlerResult, value: unknown, toolId: (tool: string) => string): ToolHandlerResult {
  const next = isObject(value) && isObject(value.structuredContent) ? value.structuredContent.nextCall : undefined;
  if (!isObject(next) || typeof next.tool !== "string" || !next.tool || !isObject(next.arguments) || typeof next.why !== "string") return response;
  let id: string;
  try { id = toolId(next.tool); } catch { return response; }
  const completed = isObject(response) && response.protocol === TOOL_EXECUTION_RESPONSE_PROTOCOL && response.kind === "completed"
    ? response as unknown as Extract<ToolExecutionResponse, { kind: "completed" }>
    : { protocol: TOOL_EXECUTION_RESPONSE_PROTOCOL, kind: "completed" as const, result: response as JsonValue };
  const reads = toolNextCallReads(next.reads);
  return { ...completed, nextCall: { toolId: id, arguments: next.arguments, why: next.why, ...(reads ? { reads } : {}) } };
}
