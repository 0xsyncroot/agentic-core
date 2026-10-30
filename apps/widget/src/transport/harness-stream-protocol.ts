const PLAN_CAUSES: ReadonlySet<string> = new Set(["proposal", "restore", "terminal"]);

/** @internal Maps Agentic domain progress to a deliberately small, user-safe UI projection. */
function projectHarnessProgress(progress: unknown): readonly AgentChatStreamEvent[] {
  if (!transportRecord(progress) || typeof progress.type !== "string") return [];
  switch (progress.type) {
    case "turn-started":
      return [{ type: "activity", activity: { id: "analysis", code: "analyzing", state: "active" } }];
    case "step-started":
      return [];
    case "tool-started":
      return harnessId(progress.turnId) && harnessId(progress.callId)
        ? [{ type: "tool-started", turnId: progress.turnId, callId: progress.callId, ...harnessActivityLabel(progress.label), ...harnessWorkStepId(progress.workStepId) }]
        : [];
    case "tool-completed":
      return harnessId(progress.turnId) && harnessId(progress.callId)
        ? [{ type: "tool-completed", turnId: progress.turnId, callId: progress.callId, status: harnessToolStatus(progress.status), ...harnessActivityLabel(progress.label), ...harnessWorkStepId(progress.workStepId) }]
        : [];
    case "model-attempt-started":
      return [{ type: "activity", activity: { id: "analysis", code: "analyzing", state: "active" } }];
    case "output-item-started":
      return [{ type: "activity", activity: { id: "composing", code: "composing", state: "active" } }];
    case "output-item-delta":
      return [];
    case "output-item-completed":
      return [];
    case "content-started":
      return [{ type: "activity", activity: { id: "composing", code: "composing", state: "active" } }];
    case "content-delta":
      return [];
    // A discarded attempt that is not retried ends the turn one way or another, and the ending
    // says so itself. A row announcing a "partial result" described nothing the user could act
    // on and was taken for the answer having been lost.
    case "model-attempt-discarded":
      return progress.willRetry === true ? [{ type: "activity", activity: { id: "retry", code: "retrying", state: "active" } }] : [];
    // The answer on screen was sent back by a policy and is about to be retracted. The row lands
    // before the bubble empties, so the retraction reads as a review rather than as a glitch.
    case "answer-revision-requested":
      return [{ type: "activity", activity: { id: "revision", code: "revising", state: "active" } }];
    case "plan-updated": {
      if (!harnessId(progress.turnId)) return [];
      const plan = harnessWorkPlan(progress.plan);
      if (!plan) return [];
      const cause = typeof progress.cause === "string" && PLAN_CAUSES.has(progress.cause) ? progress.cause as AgentChatPlanCause : "proposal";
      const changedStepIds = Array.isArray(progress.changedStepIds) ? progress.changedStepIds.filter(harnessId).slice(0, 20) : undefined;
      return [{ type: "plan-updated", turnId: progress.turnId, cause, plan, ...(changedStepIds && changedStepIds.length > 0 ? { changedStepIds } : {}) }];
    }
    case "work-decision":
      if (progress.decision === "budget-reached") return [{ type: "activity", activity: { id: "safety-limit", code: "safety-limit", state: "partial" } }];
      return [];
    case "turn-completed":
      return [{ type: "activity", activity: {
        id: "complete", code: "completed",
        // A turn the loop classified as partial did not finish, and it is not waiting for the
        // user either: it stopped. A turn paused on an approval or a question did not finish
        // either — it is not done and not stopped, it is waiting — so it gets its own state
        // rather than being told apart from a real ending (audit runtime bug, spec §3.7 item 7).
        state: progress.outcome === "partial" ? "partial"
          : progress.outcome === "awaiting_approval" || progress.outcome === "awaiting_interaction" ? "awaiting"
          : "done",
      } }];
    case "turn-failed":
      return [{ type: "activity", activity: { id: "complete", code: "failed", state: "partial" } }];
    default:
      return [];
  }
}

/** @internal */
function defaultHarnessStreamProtocol(frame: AgentChatSseFrame, context: AgentChatOperationContext): AgentChatStreamProtocolResult {
  if (frame.data.trim() === "[DONE]") return null;
  let payload: unknown;
  try { payload = JSON.parse(frame.data) as unknown; }
  catch (cause) { throw new AgentChatTransportError("The SSE frame contains invalid JSON.", { code: "invalid-sse-json", cause, details: frame, transportFailure: true }); }
  if (frame.event === "progress") return [{ type: "progress", progress: payload }, ...projectHarnessProgress(payload)];
  if (frame.event === "assistant-output-start" || frame.event === "assistant-output-delta" || frame.event === "assistant-output-end") {
    if (!transportRecord(payload) || payload.audience !== "user" || typeof payload.outputId !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,256}$/.test(payload.outputId)) {
      throw new AgentChatTransportError("The SSE assistant-output frame does not match the public shape.", { code: "invalid-output", details: payload, transportFailure: true });
    }
    if (frame.event === "assistant-output-start") {
      return { type: "assistant-output-start", outputId: payload.outputId, audience: "user", ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
    }
    if (frame.event === "assistant-output-delta") {
      if (typeof payload.delta !== "string" || !payload.delta) {
        throw new AgentChatTransportError("An SSE assistant-output delta must carry content.", { code: "invalid-output", details: payload, transportFailure: true });
      }
      return { type: "assistant-output-delta", outputId: payload.outputId, audience: "user", delta: payload.delta, ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
    }
    if (payload.status !== "completed" && payload.status !== "discarded") {
      throw new AgentChatTransportError("An SSE assistant-output end must carry a valid status.", { code: "invalid-output", details: payload, transportFailure: true });
    }
    return { type: "assistant-output-end", outputId: payload.outputId, audience: "user", status: payload.status, ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
  }
  if (frame.event === "assistant-narration-start" || frame.event === "assistant-narration-delta" || frame.event === "assistant-narration-end" ||
      frame.event === "assistant-narration-superseded") {
    if (!transportRecord(payload) || payload.audience !== "user" || typeof payload.narrationId !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,256}$/.test(payload.narrationId)) {
      throw new AgentChatTransportError("The SSE narration frame does not match the public shape.", { code: "invalid-narration", details: payload, transportFailure: true });
    }
    if (frame.event === "assistant-narration-start") {
      return { type: "assistant-narration-start", narrationId: payload.narrationId, audience: "user", ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}), ...(payload.kind === "draft" ? { kind: "draft" as const } : {}) };
    }
    if (frame.event === "assistant-narration-superseded") {
      if (typeof payload.by !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(payload.by)) {
        throw new AgentChatTransportError("An SSE superseded narration must name the narration that superseded it.", { code: "invalid-narration", details: payload, transportFailure: true });
      }
      return { type: "assistant-narration-superseded", narrationId: payload.narrationId, audience: "user", by: payload.by, ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
    }
    if (frame.event === "assistant-narration-delta") {
      if (typeof payload.delta !== "string" || !payload.delta) {
        throw new AgentChatTransportError("An SSE narration delta must carry content.", { code: "invalid-narration", details: payload, transportFailure: true });
      }
      return { type: "assistant-narration-delta", narrationId: payload.narrationId, audience: "user", delta: payload.delta, ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
    }
    if (payload.status !== "completed" && payload.status !== "discarded") {
      throw new AgentChatTransportError("An SSE narration end must carry a valid status.", { code: "invalid-narration", details: payload, transportFailure: true });
    }
    return { type: "assistant-narration-end", narrationId: payload.narrationId, audience: "user", status: payload.status, ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}) };
  }
  if (frame.event === "assistant-reasoning-start" || frame.event === "assistant-reasoning-delta" || frame.event === "assistant-reasoning-end") {
    if (!transportRecord(payload) || payload.audience !== "user" || typeof payload.reasoningId !== "string" ||
        !/^[a-zA-Z0-9._:-]{1,256}$/.test(payload.reasoningId)) {
      throw new AgentChatTransportError("The SSE reasoning frame does not match the public shape.", { code: "invalid-reasoning", details: payload, transportFailure: true });
    }
    const turnId = typeof payload.turnId === "string" ? { turnId: payload.turnId } : {};
    if (frame.event === "assistant-reasoning-start") {
      return { type: "assistant-reasoning-start", reasoningId: payload.reasoningId, audience: "user", ...turnId };
    }
    if (frame.event === "assistant-reasoning-delta") {
      if (typeof payload.delta !== "string" || !payload.delta) {
        throw new AgentChatTransportError("An SSE reasoning delta must carry content.", { code: "invalid-reasoning", details: payload, transportFailure: true });
      }
      return { type: "assistant-reasoning-delta", reasoningId: payload.reasoningId, audience: "user", delta: payload.delta, ...turnId };
    }
    if (payload.status !== "completed" && payload.status !== "discarded") {
      throw new AgentChatTransportError("An SSE reasoning end must carry a valid status.", { code: "invalid-reasoning", details: payload, transportFailure: true });
    }
    return { type: "assistant-reasoning-end", reasoningId: payload.reasoningId, audience: "user", status: payload.status, ...turnId };
  }
  if (frame.event === "result") {
    if (!transportRecord(payload) || typeof payload.content !== "string") throw new AgentChatTransportError("The SSE result frame does not match the expected shape.", { code: "invalid-result", details: payload, transportFailure: true });
    const approval = harnessApprovalChallenge(payload.approval, context.sessionId);
    const interaction = harnessHumanInteractionChallenge(payload.interaction, context.sessionId);
    if (payload.outcome === "awaiting_approval" && !approval) {
      throw new AgentChatTransportError("The SSE result is missing a valid approval challenge for the current session.", { code: "invalid-result", details: payload, transportFailure: true });
    }
    if (payload.outcome === "awaiting_interaction" && !interaction) {
      throw new AgentChatTransportError("The SSE result is missing a valid interaction challenge for the current session.", { code: "invalid-result", details: payload, transportFailure: true });
    }
    return { type: "result", result: {
      ...payload, ...(approval ? { content: "", approval } : {}), ...(interaction ? { interaction } : {}),
    } as AgentChatTurnResult };
  }
  if (frame.event === "error") {
    const details = transportRecord(payload) ? payload : {};
    const retryable = typeof details.retryable === "boolean" ? details.retryable : undefined;
    const hasMessage = typeof details.message === "string" && details.message.trim() !== "";
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    return { type: "error", error: new AgentChatTransportError(hasMessage ? (details.message as string) : "The stream reported an error with no message.", {
      code: typeof details.code === "string" ? details.code : "stream-error",
      ...(retryable === undefined ? {} : { retryable }),
      ...(reason ? { reason } : {}),
      // The Agent API's own `error` frame always carries `message`; only a malformed one falls
      // back here, and that fallback — like a bare HTTP status — is not for the chat.
      transportFailure: !hasMessage,
      details: payload,
    }) };
  }
  return { type: "metadata", data: { event: frame.event, payload } };
}
