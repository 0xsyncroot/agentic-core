import type { CapabilityUnavailableReason, JsonValue, ToolCall, UnavailableCapabilities } from "@0xsyncroot/contracts";
import type { GroupLoad } from "./tool-selection.js";
import type { ToolBatchContext } from "./tool-call-drafts.js";
import type { ToolExecutionCoordinator, ToolPreparation } from "./tool-execution-coordinator.js";

/**
 * Why a call the step was not offered did not run, said from what the turn knows.
 *
 * A model calls a tool it does not have when something it read named that tool — its own
 * instructions, most often. Rejecting the whole step for that told it nothing it could act on; a
 * tool result does, in the channel it already reads tool outcomes from, and the loop goes on.
 *
 * One sentence used to answer every such call — "is not available in this session" — and it was
 * wrong twice over. The tool set it named was the step's, not the session's, so a tool the policy
 * only held back for one step read as gone for good; and a tool that truly could not run (its source
 * down, a permission missing) read as something to try again, so a model kept calling a reader that
 * was down (docs/incidents/2026-10-14-core-reader-down.md). Each case now says what it is:
 * a capability missing for the whole turn says so and that calling again will not change it, marked
 * `unavailable` on the result so a policy can treat the blocker as proven; a tool merely not offered
 * now says "in this step"; a name the turn never had says it does not exist.
 *
 * None of it names the source's id or the permission — a model repeats what it reads, and those are
 * no words for the chat; the product names the cause in its own notice. Nor does it guess why a
 * source failed: "did not answer" was wrong for a refused token, so it is "unavailable right now".
 *
 * A tool of a group the turn's selection left out is there to be loaded: the refusal names its group and carries the
 * loader call that offers it as data (`load`), so one step recovers it. It lists no other tools to use instead.
 */
export function unofferedCallRefusal(call: ToolCall, facts: {
  readonly offeredToolIds: readonly string[];
  /** The tool is in the turn's catalogue, only not offered in this step. */
  readonly inCatalogue: boolean;
  readonly unavailable?: UnavailableCapabilities;
  /** The tool is in a group the turn left out, and this is the loader call that offers it. */
  readonly load?: GroupLoad;
}): { readonly message: string; readonly unavailable?: CapabilityUnavailableReason; readonly load?: JsonValue } {
  const withheld = facts.unavailable?.withheldTools.find((tool) => tool.toolId === call.name);
  if (withheld) {
    return {
      unavailable: "withheld",
      message: `Tool ${call.name} cannot run in this turn: it needs a permission this account has not been granted. Calling it again will`
        + " not change that. Do not call it again; tell the user plainly that this cannot be done with their current permissions, and go on"
        + " with what the other tools allow.",
    };
  }
  const source = facts.unavailable?.sources.find((candidate) => call.name.startsWith(`${candidate.sourceId}_`));
  if (source) {
    return {
      unavailable: "source-unavailable",
      message: `Tool ${call.name} cannot run in this turn: the service it belongs to is unavailable right now, so none of its tools exist`
        + " for this turn. Calling it again will not change that. Do not call it again; tell the user plainly that this is"
        + (source.readsAttachments ? " unavailable right now — the files they attached cannot be read at the moment —" : " unavailable right now")
        + " and that they can try again later.",
    };
  }
  if (facts.load) {
    return {
      message: `Tool ${call.name} is in the tool group "${facts.load.group}", which this turn has not offered yet, so it was not run.`,
      load: { toolId: facts.load.call.toolId, arguments: { ...facts.load.call.arguments } },
    };
  }
  const available = [...facts.offeredToolIds].sort();
  const scope = facts.inCatalogue ? "is not offered in this step" : "does not exist in this session";
  return {
    message: `Tool ${call.name} ${scope}, so it was not run.`
      + (available.length > 0
        ? ` Tools available in this step: ${available.join(", ")}. Use one of them, or answer from what you already have.`
        : " No tools are available in this step: answer from what you already have."),
  };
}

/** The answer to a call the step was not offered (`unofferedCallRefusal`), counted like any call. */
export function unofferedPreparation(coordinator: ToolExecutionCoordinator, call: ToolCall, context: ToolBatchContext): ToolPreparation {
  const load = context.groupLoad?.(call.name);
  const refusal = unofferedCallRefusal(call, {
    offeredToolIds: [...(context.selectedToolIds ?? [])], inCatalogue: coordinator.definition(call) !== undefined,
    ...(context.unavailable ? { unavailable: context.unavailable } : {}), ...(load ? { load } : {}),
  });
  return {
    kind: "terminal",
    outcome: coordinator.refuseUnoffered(call, {
      executionId: coordinator.executionId(call, context), state: "not_started", dispatched: false,
      error: { type: "tool_error", code: "validation", retryable: false, message: refusal.message, ...(refusal.load ? { load: refusal.load } : {}) },
      ...(refusal.unavailable ? { unavailable: refusal.unavailable } : {}),
    }),
  };
}
