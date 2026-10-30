import { AgenticError, type ToolDefinition, type TurnControlPolicy, type TurnControlState, type TurnModelDirective } from "@0xsyncroot/contracts";

const MAX_FALLBACK_CHARS = 2_000;

/**
 * Whether the model disobeyed the step's tool-choice directive.
 *
 * A call to a tool that is not among the selected ones is deliberately not a violation here.
 * It used to be, and the objection it produced — "a tool that was not selected for this step"
 * — told the model neither why nor what to use instead. A model whose instructions name a tool
 * the session does not carry (a permission the host never issued, say) then called it again,
 * the identical objection ended the turn on a fallback, and the accountant read "could not
 * complete the request" with no work done. Such a call is now answered like any other tool
 * failure: the batch executor refuses it with a result naming the tools that are available,
 * nothing runs, and the model carries on with what it has. Only the directive's own terms —
 * a required call, a named tool, no tools at all — are still enforced here.
 */
export function toolChoiceViolation(
  directive: TurnModelDirective,
  selectedTools: readonly ToolDefinition[],
  toolCalls: readonly { readonly name: string }[],
  isPlanningCall: (name: string) => boolean = () => false,
): string | undefined {
  const selected = new Set(selectedTools.map((tool) => tool.id));
  // The work-plan update is the agent narrating, not acting: it is asked for after every step,
  // and a model told to call one tool sends the plan alongside it. Counting that as a call to
  // "another tool" sent a compliant step back twice before the required read ever ran.
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

/**
 * Whether a side-effecting tool call of this turn reached its source, whatever it then reported.
 * Results are joined to their intents by execution (call ids repeat across turns), falling back to
 * the call id for rows journaled before results named their execution.
 */
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

/**
 * The sentence a turn ends on when the model kept ignoring the step's tool directive.
 *
 * It is the product's: core writes no user-facing copy, so without `fallbackText` the turn ends
 * with empty content and the outcome says it is partial. The policy is told whether a write was
 * dispatched, because a directive is most often issued right after one, and a sentence claiming
 * nothing changed would then be false.
 */
export function choiceViolationFallback(policy: TurnControlPolicy | undefined, state: TurnControlState): string {
  if (!policy?.fallbackText) return "";
  const text: unknown = policy.fallbackText({ kind: "choice-violation", writesDispatched: writesDispatched(state) });
  if (typeof text !== "string" || text.length > MAX_FALLBACK_CHARS) {
    throw new AgenticError("validation", "Turn-control fallback text must be a bounded string");
  }
  return text.trim();
}
