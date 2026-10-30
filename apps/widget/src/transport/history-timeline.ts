/** The public journal only; never reasoning or raw tool data. */
type HistoryTimelineItem =
  | { readonly type: "plan-updated"; readonly plan: AgentChatWorkPlan; readonly cause: AgentChatPlanCause; readonly changedStepIds?: readonly string[] }
  | { readonly type: "narration"; readonly content: string; readonly draft?: true }
  | { readonly type: "tool-started" | "tool-completed"; readonly callId: string; readonly label: string; readonly status?: AgentChatToolStatus; readonly workStepId?: string };

function harnessHistoryTimeline(value: unknown): readonly HistoryTimelineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): HistoryTimelineItem[] => {
    if (!transportRecord(item)) return [];
    // A draft a policy sent back and kept: hidden on reload as it was live.
    if (item.type === "narration" && typeof item.content === "string") return [{ type: "narration", content: clipNarration(item.content), ...(item.draft === true ? { draft: true as const } : {}) }];
    if (item.type === "plan-updated") {
      const plan = harnessWorkPlan(item.plan);
      return plan ? [{ type: "plan-updated", plan, cause: typeof item.cause === "string" && PLAN_CAUSES.has(item.cause) ? item.cause as AgentChatPlanCause : "restore",
        ...(Array.isArray(item.changedStepIds) ? { changedStepIds: item.changedStepIds.filter((id): id is string => typeof id === "string") } : {}) }] : [];
    }
    if ((item.type === "tool-started" || item.type === "tool-completed") && harnessId(item.callId) && typeof item.label === "string") {
      return [{ type: item.type, callId: item.callId, label: item.label.slice(0, 240), status: harnessToolStatus(item.status), ...harnessWorkStepId(item.workStepId) }];
    }
    return [];
  });
}

function harnessHistoryAttachments(value: unknown): readonly Omit<AgentChatAttachment, "file">[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (!transportRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id, name: item.name, type: typeof item.type === "string" ? item.type : "application/octet-stream",
      size: typeof item.size === "number" ? item.size : 0, source: "picker" as const }];
  }) : [];
}

interface AgentChatSessionSummary { readonly sessionId: string; readonly title: string; readonly createdAt: string }
interface AgentChatSessionPage { readonly sessions: readonly AgentChatSessionSummary[]; readonly nextCursor?: string }
