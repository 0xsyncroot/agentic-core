import { withoutInlineThought } from "@0xsyncroot/contracts";
import type { JsonValue, SessionEvent, AgentProgressEvent } from "@0xsyncroot/contracts";
import { PublicAgentStreamWriter, type ToolTraceLabeller } from "./public-agent-stream.js";

/**
 * The narrations, per turn, that left the chat while the turn ran (`assistant/narration-superseded`): history leaves them out,
 * so a reload shows what the live stream showed.
 */
export function supersededNarrationIds(events: readonly SessionEvent[]): ReadonlyMap<string, ReadonlySet<string>> {
  const superseded = new Map<string, Set<string>>();
  for (const event of events) {
    const narrationId = (event.payload as Record<string, unknown> | null)?.narrationId;
    if (event.type !== "assistant/narration-superseded" || !event.turnId || typeof narrationId !== "string") continue;
    superseded.set(event.turnId, (superseded.get(event.turnId) ?? new Set()).add(narrationId));
  }
  return superseded;
}

/** Reuse the live public boundary: raw arguments, results, tool identities and reasoning stay server-side. */
export function historyTimelines(events: readonly SessionEvent[], toolTrace?: ToolTraceLabeller) {
  const timelines = new Map<string, Record<string, unknown>[]>();
  const calls = new Map<string, Record<string, JsonValue>>();
  const writer = new PublicAgentStreamWriter((_name, value) => {
    const event = value as Record<string, unknown>;
    const turnId = String(event.turnId);
    const timeline = timelines.get(turnId) ?? [];
    timeline.push(event);
    timelines.set(turnId, timeline);
  }, { ...(toolTrace ? { toolTrace } : {}) });
  // A call that ran within an earlier approval says so on reload as it did live (its decision is journaled after its intent).
  const covered = new Set(events.flatMap((event) => event.type === "tool/policy-decision" && typeof (event.payload as Record<string, unknown>)?.coveredBy === "string"
    ? [String((event.payload as Record<string, unknown>).executionId)] : []));
  // So does one that ran under the user's standing approval.
  const standing = new Set(events.flatMap((event) => event.type === "tool/policy-decision" && (event.payload as Record<string, unknown>)?.standingApproval
    ? [String((event.payload as Record<string, unknown>).executionId)] : []));
  const superseded = supersededNarrationIds(events);
  for (const event of events) {
    if (!event.turnId || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const payload = event.payload;
    if (event.type === "assistant/narration" && payload.audience === "user" && typeof payload.content === "string") {
      if (typeof payload.narrationId === "string" && superseded.get(event.turnId)?.has(payload.narrationId)) continue;
      writer.event("narration", { type: "narration", turnId: event.turnId, content: withoutInlineThought(payload.content),
        ...(typeof payload.narrationId === "string" ? { narrationId: payload.narrationId } : {}),
        // A draft a policy sent back and kept: the client hides it on reload as it did live.
        ...(payload.draft === true ? { draft: true } : {}) });
    } else if (event.type === "work/plan-updated") {
      writer.progress({ type: "plan-updated", turnId: event.turnId, plan: payload, cause: payload.cause, changedStepIds: payload.changedStepIds } as unknown as AgentProgressEvent);
    } else if (event.type === "tool/intent") {
      let args = payload.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args) as JsonValue; } catch { args = undefined; } }
      const call = { ...payload, ...(args !== undefined ? { arguments: args } : {}) };
      calls.set(String(payload.executionId ?? event.callId), call);
      writer.progress({ type: "tool-started", turnId: event.turnId, step: 0, callId: payload.callId ?? event.callId,
        toolId: payload.toolId, arguments: args, workStepId: payload.workStepId, initiator: payload.initiator,
        ...(covered.has(String(payload.executionId)) ? { approvalReused: true } : {}),
        ...(standing.has(String(payload.executionId)) ? { approvalStanding: true } : {}) } as AgentProgressEvent);
    } else if (event.type === "tool/result") {
      const call = calls.get(String(payload.executionId ?? event.callId));
      writer.progress({ type: "tool-completed", turnId: event.turnId, step: 0, callId: payload.callId ?? event.callId,
        toolId: payload.toolId, status: payload.state, arguments: call?.arguments, result: payload.result, error: payload.error,
        workStepId: payload.workStepId ?? call?.workStepId, initiator: payload.initiator ?? call?.initiator,
        ...(covered.has(String(payload.executionId)) ? { approvalReused: true } : {}),
        ...(standing.has(String(payload.executionId)) ? { approvalStanding: true } : {}) } as AgentProgressEvent);
    }
  }
  return timelines;
}
