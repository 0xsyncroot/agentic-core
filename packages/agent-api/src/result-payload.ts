import { withoutInlineThought, projectTurnWork, type RunTurnResult } from "@0xsyncroot/contracts";
import type { BusinessMessages } from "./error-mapping.js";
import { publicPlan } from "./public-reasoning-text.js";

/** The subset of `TurnWork` a dev-harness result payload exposes: durable per-turn work. */
function workSummary(result: RunTurnResult): Record<string, unknown> | undefined {
  const work = projectTurnWork(result.events).find((entry) => entry.turnId === result.turnId);
  if (!work) return undefined;
  return {
    status: work.status,
    ...(work.durationMs !== undefined ? { durationMs: work.durationMs } : {}),
    ...(work.decision ? { decision: work.decision } : {}),
    ...(work.plan ? { plan: publicPlan(work.plan) } : {}),
    // Without the tool id or the execution id: this payload ends the public stream, and the stream
    // is built so a tool's own name never reaches a browser. It did, once per call, in the very
    // last frame — after every frame before it had withheld it.
    tools: work.tools.map((tool) => ({
      callId: tool.callId, state: tool.state,
      ...(tool.workStepId ? { workStepId: tool.workStepId } : {}),
      ...(tool.initiator ? { initiator: tool.initiator } : {}),
    })),
  };
}

/**
 * The product's sentence for a turn that ended with nothing to show for itself; "" when it has none.
 * A card the turn waits on carries its own words; the runtime's question at the end of a partial turn
 * does not say why the turn stopped, so the stopped sentence still goes above it.
 */
function emptyAnswer(result: RunTurnResult, ui: unknown, messages: BusinessMessages | undefined): string {
  if (result.content.trim() || (result.interaction && result.outcome !== "partial") || ui !== undefined) return result.content;
  if (result.outcome !== "completed" && result.outcome !== "partial") return result.content;
  return (result.outcome === "partial" ? messages?.emptyAnswer?.stopped : messages?.emptyAnswer?.completed) ?? result.content;
}

export function resultPayload(result: RunTurnResult, startedAt: number, messages?: BusinessMessages): Record<string, unknown> {
  const turnEvents = result.events.filter((event) => event.turnId === result.turnId);
  const assistant = [...turnEvents].reverse().find((event) => event.type === "assistant/message");
  const ui = assistant ? (assistant.payload as Record<string, unknown>).ui : undefined;
  const work = workSummary(result);
  return {
    content: result.approval ? "Approval required." : withoutInlineThought(emptyAnswer(result, ui, messages)), sessionId: result.sessionId, turnId: result.turnId,
    outcome: result.outcome, replayed: result.replayed ?? false,
    ...(result.approval ? { approval: result.approval } : {}),
    ...(result.interaction ? { interaction: result.interaction } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(work ? { work } : {}),
    metrics: {
      elapsedMs: Math.round(performance.now() - startedAt), events: turnEvents.length,
      steps: turnEvents.filter((event) => event.type === "step/start").length,
      tools: turnEvents.filter((event) => event.type === "tool/result" &&
        (event.payload as Record<string, unknown>).dispatched === true).length,
    },
  };
}
