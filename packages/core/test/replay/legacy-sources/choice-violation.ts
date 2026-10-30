import { AgenticError, type ToolDefinition, type TurnControlPolicy, type TurnControlState, type TurnModelDirective } from "@0xsyncroot/contracts";

const MAX_FALLBACK_CHARS = 2_000;

export function toolChoiceViolation(
  directive: TurnModelDirective,
  selectedTools: readonly ToolDefinition[],
  toolCalls: readonly { readonly name: string }[],
  isPlanningCall: (name: string) => boolean = () => false,
): string | undefined {
  const selected = new Set(selectedTools.map((tool) => tool.id));
  const acting = toolCalls.filter((call) => !isPlanningCall(call.name));
  if (directive.toolChoice === "required" && acting.length === 0) return "This step requires a tool call before a final answer";
  const namedChoice = directive.toolChoice && typeof directive.toolChoice === "object" ? directive.toolChoice : undefined;
  if (namedChoice && (acting.length === 0 || acting.some((call) => call.name !== namedChoice.name))) {
    return `This step requires the selected tool: ${namedChoice.name}${selected.has(namedChoice.name) ? "" : " (not selected)"}`;
  }
  if (directive.toolChoice === "none" && toolCalls.length > 0) return "This step does not allow tool calls";
  return undefined;
}

function payloadOf(event: { readonly payload: unknown }): Readonly<Record<string, unknown>> {
  return event.payload && typeof event.payload === "object" ? event.payload as Readonly<Record<string, unknown>> : {};
}

export function writesDispatched(state: TurnControlState): boolean {
  const events = state.context.events.filter((event) => event.turnId === state.turnId);
  const writes = events.filter((event) => event.type === "tool/intent" && payloadOf(event).sideEffect !== "none");
  const writeExecutions = new Set(writes.map((event) => payloadOf(event).executionId).filter((id) => typeof id === "string"));
  const writeCalls = new Set(writes.map((event) => event.callId));
  return events.some((event) => {
    if (event.type !== "tool/result" || payloadOf(event).dispatched !== true) return false;
    const executionId = payloadOf(event).executionId;
    return typeof executionId === "string" && writeExecutions.size > 0 ? writeExecutions.has(executionId) : writeCalls.has(event.callId);
  });
}

export function choiceViolationFallback(policy: TurnControlPolicy | undefined, state: TurnControlState): string {
  if (!policy?.fallbackText) return "";
  const text: unknown = policy.fallbackText({ kind: "choice-violation", writesDispatched: writesDispatched(state) });
  if (typeof text !== "string" || text.length > MAX_FALLBACK_CHARS) {
    throw new AgenticError("validation", "Turn-control fallback text must be a bounded string");
  }
  return text.trim();
}
