/** @internal */
function transportRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @internal Copies only bounded scalar presentation fields; arbitrary tool arguments never cross this boundary. */
function harnessApprovalPresentation(value: unknown): AgentChatApprovalPresentation | undefined {
  if (!transportRecord(value) || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 800 ||
      typeof value.action !== "string" || !value.action.trim() || value.action.length > 160 ||
      typeof value.target !== "string" || !value.target.trim() || value.target.length > 320 ||
      typeof value.impact !== "string" || !value.impact.trim() || value.impact.length > 800 ||
      (value.fields !== undefined && !Array.isArray(value.fields))) return undefined;
  const rawFields = Array.isArray(value.fields) ? value.fields : [];
  if (rawFields.length > 8) return undefined;
  const fields = rawFields.flatMap((item) => {
    if (!transportRecord(item) || typeof item.label !== "string" || !item.label.trim() || item.label.length > 80 ||
        !["string", "number", "boolean"].includes(typeof item.value) || String(item.value).length > 256 ||
        (typeof item.value === "number" && !Number.isFinite(item.value))) return [];
    return [{ label: item.label.trim(), value: item.value as string | number | boolean }];
  });
  if (fields.length !== rawFields.length) return undefined;
  return {
    summary: value.summary.trim(), action: value.action.trim(), target: value.target.trim(), impact: value.impact.trim(),
    ...(fields.length ? { fields } : {}),
  };
}

/** @internal Keeps only the user-safe, session-bound part of a durable approval challenge. */
const APPROVAL_STATES: ReadonlySet<string> = new Set(["pending", "approved", "denied", "superseded", "expired"]);
/** @internal Only ever set from history — a live card's state is what the widget itself just resolved. */
function isApprovalState(value: unknown): value is NonNullable<AgentChatApprovalChallenge["state"]> {
  return typeof value === "string" && APPROVAL_STATES.has(value);
}

function harnessApprovalChallenge(value: unknown, sessionId: string): AgentChatApprovalChallenge | undefined {
  if (!transportRecord(value) || value.sessionId !== sessionId ||
      typeof value.approvalId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.approvalId) ||
      typeof value.turnId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.turnId) ||
      typeof value.toolId !== "string" || !/^[a-zA-Z0-9._:/-]{1,256}$/.test(value.toolId) ||
      (value.sideEffect !== "none" && value.sideEffect !== "idempotent" && value.sideEffect !== "nonIdempotent") ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
  const agentProfileId = typeof value.agentProfileId === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.agentProfileId)
    ? value.agentProfileId
    : undefined;
  const presentation = harnessApprovalPresentation(value.presentation);
  const state = isApprovalState(value.state) ? value.state : undefined;
  return {
    kind: "approval",
    approvalId: value.approvalId,
    sessionId,
    turnId: value.turnId,
    toolId: value.toolId,
    sideEffect: value.sideEffect,
    expiresAt: value.expiresAt,
    ...(value.superseded === true ? { superseded: true } : {}),
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(presentation ? { presentation } : {}),
    ...(state ? { state } : {}),
  };
}

/** @internal `interaction/resolved.echo`: what the user picked, in the schema's own titles — never the raw value. */
function harnessInteractionEcho(value: unknown): readonly AgentChatInteractionEcho[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const echo = value.slice(0, 12).flatMap((item) => transportRecord(item) && typeof item.label === "string" && item.label.length <= 200
    && typeof item.value === "string" && item.value.length <= 500 ? [{ label: item.label, value: item.value }] : []);
  return echo.length > 0 ? echo : undefined;
}

const INTERACTION_STATES: ReadonlySet<string> = new Set(["pending", "answered", "declined", "superseded", "expired"]);
/** @internal Only ever set from history — a live card's state is what the widget itself just resolved. */
function isInteractionState(value: unknown): value is NonNullable<AgentChatInteractionBinding["state"]> {
  return typeof value === "string" && INTERACTION_STATES.has(value);
}

/** @internal Keeps only a bounded, user-safe delivery projection; continuation state is never accepted. */
function harnessHumanInteractionChallenge(value: unknown, sessionId: string): AgentChatHumanInteractionChallenge | undefined {
  if (!transportRecord(value) || (value.kind !== "form" && value.kind !== "external") || value.sessionId !== sessionId ||
      typeof value.interactionId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.interactionId) ||
      typeof value.turnId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.turnId) ||
      typeof value.toolId !== "string" || !/^[a-zA-Z0-9._:/-]{1,256}$/.test(value.toolId) ||
      typeof value.requesterId !== "string" || value.requesterId.length > 256 ||
      typeof value.message !== "string" || !value.message.trim() || value.message.length > 2_000 ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
  const state = isInteractionState(value.state) ? value.state : undefined;
  const echo = harnessInteractionEcho(value.echo);
  const common = {
    interactionId: value.interactionId, sessionId, turnId: value.turnId, toolId: value.toolId,
    requesterId: value.requesterId, message: value.message,
    ...(typeof value.title === "string" && value.title.length <= 120 ? { title: value.title } : {}),
    expiresAt: value.expiresAt,
    ...(typeof value.agentProfileId === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.agentProfileId)
      ? { agentProfileId: value.agentProfileId } : {}),
    ...(state ? { state } : {}), ...(echo ? { echo } : {}),
  };
  if (value.kind === "external") {
    if (typeof value.url !== "string" || value.url.length > 4_096 || typeof value.externalId !== "string" || value.externalId.length > 256) return undefined;
    try {
      const url = new URL(value.url);
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
      if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.hash) return undefined;
      return { kind: "external", ...common, url: url.toString(), externalId: value.externalId };
    } catch { return undefined; }
  }
  if (!transportRecord(value.requestedSchema) || value.requestedSchema.type !== "object" || !transportRecord(value.requestedSchema.properties) ||
      Object.keys(value.requestedSchema.properties).length < 1 || Object.keys(value.requestedSchema.properties).length > 20) return undefined;
  return { kind: "form", ...common, requestedSchema: value.requestedSchema };
}

/** @internal Built-in history projection: narration must be explicit and addressed to the user. */
function harnessHistoryNarrations(message: Record<string, unknown>): readonly AgentChatNarration[] {
  const direct = Array.isArray(message.narrations) ? message.narrations : [];
  const work = transportRecord(message.work) ? message.work : {};
  const interactions = Array.isArray(work.interactions) ? work.interactions : [];
  const fromDirect = direct.length > 0;
  return (fromDirect ? direct : interactions).filter(transportRecord).flatMap((candidate, index) => {
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    const explicit = fromDirect
      ? candidate.audience === "user"
      : candidate.type === "narration" && candidate.audience === "user";
    if (!explicit || !content) return [];
    const id = typeof candidate.id === "string" && candidate.id.trim()
      ? candidate.id.trim()
      : typeof candidate.narrationId === "string" && candidate.narrationId.trim()
        ? candidate.narrationId.trim()
        : `history-narration-${index + 1}`;
    const safeId = /^[a-zA-Z0-9._:-]{1,256}$/.test(id) ? id : `history-narration-${index + 1}`;
    return [{
      id: safeId,
      audience: "user",
      content: clipNarration(content),
      ...(typeof candidate.at === "string" ? { at: candidate.at } : {}),
      ...(candidate.draft === true ? { draft: true as const } : {}),
    } satisfies AgentChatNarration];
  });
}

/** @internal The runtime's own id pattern — a callId, a workStepId, a planId, a turnId. */
function harnessId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

/** @internal The runtime writes this plan itself; the widget only validates and renders it — never a phrase or a guess. */
function harnessWorkPlan(value: unknown): AgentChatWorkPlan | undefined {
  if (!transportRecord(value) || !Array.isArray(value.steps)) return undefined;
  const steps = value.steps.slice(0, 20).flatMap((item) => {
    if (!transportRecord(item) || !harnessId(item.id)) return [];
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description || description.length > 300) return [];
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed" && item.status !== "blocked") return [];
    const outcome = typeof item.outcome === "string" ? item.outcome.trim() : "";
    return [{ id: item.id, description, status: item.status, ...(outcome && outcome.length <= 500 ? { outcome } : {}) } satisfies AgentChatWorkPlanStep];
  });
  if (steps.length === 0) return undefined;
  const goal = typeof value.goal === "string" ? value.goal.trim() : "";
  const planId = harnessId(value.planId) ? value.planId : undefined;
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : undefined;
  const state = value.state === "active" || value.state === "awaiting_user" || value.state === "completed" || value.state === "stopped" || value.state === "failed"
    ? value.state : undefined;
  return {
    ...(planId ? { planId } : {}), ...(revision !== undefined ? { revision } : {}), ...(state ? { state } : {}),
    ...(goal && goal.length <= 300 ? { goal } : {}), steps,
  };
}

/**
 * @internal A business phrase the server chose to publish for a tool call, or nothing.
 *
 * Bounded and trimmed here as well as server-side: this value is rendered as text in the trace,
 * and a transport must not assume the thing on the other end of the socket stayed well behaved.
 */
function harnessActivityLabel(value: unknown): { label?: string } {
  if (typeof value !== "string") return {};
  const label = value.trim().replaceAll(/\s+/gu, " ");
  // The Agent API publishes up to 240 chars. Rejecting its longer valid labels lost audit
  // counts and left the completed call displaying its earlier "working" phrase instead.
  return label && label.length <= 240 ? { label } : {};
}

/** @internal The plan step a tool call is attributed to, when the runtime says which one. */
function harnessWorkStepId(value: unknown): { workStepId?: string } {
  return harnessId(value) ? { workStepId: value } : {};
}

const TOOL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "denied", "not_started", "outcome_unknown"]);
/** @internal Straight from the runtime; an unrecognized status is treated as the least it could mean. */
function harnessToolStatus(value: unknown): AgentChatToolStatus {
  return typeof value === "string" && TOOL_STATUSES.has(value) ? value as AgentChatToolStatus : "outcome_unknown";
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "awaiting_approval", "awaiting_interaction", "failed", "in_progress"]);

/** @internal `history.work`: the plan and tool marks a reload rebuilds the same folded checklist live had. */
function harnessHistoryWork(value: unknown): AgentChatHistoryWork | undefined {
  if (!transportRecord(value)) return undefined;
  const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : undefined;
  const decision = typeof value.decision === "string" && value.decision ? value.decision : undefined;
  const planRaw = harnessWorkPlan(value.plan);
  const plan = planRaw ? { ...(planRaw.planId ? { planId: planRaw.planId } : {}), ...(planRaw.state ? { state: planRaw.state } : {}), steps: planRaw.steps } : undefined;
  const tools = Array.isArray(value.tools) ? value.tools.flatMap((item) => {
    if (!transportRecord(item) || !harnessId(item.callId)) return [];
    return [{ callId: item.callId, status: harnessToolStatus(item.status), ...harnessActivityLabel(item.label), ...harnessWorkStepId(item.workStepId) } satisfies AgentChatHistoryTool];
  }) : [];
  if (durationMs === undefined && decision === undefined && !plan && tools.length === 0) return undefined;
  return { ...(durationMs !== undefined ? { durationMs } : {}), ...(decision ? { decision } : {}), ...(plan ? { plan } : {}), tools };
}

/**
 * @internal A turn's body: the JSON alone, or — when files travel with it — a form holding that
 * JSON as `request` and each file as `file:<attachment id>`. The gateway stores the files itself;
 * the browser never learns where, or what they are called once stored.
 */
function harnessTurnBody(json: string, files: ReadonlyMap<string, File> | undefined): string | FormData {
  if (!files || files.size === 0) return json;
  const form = new FormData();
  form.append("request", json);
  for (const [id, file] of files) form.append(`file:${id}`, file, file.name);
  return form;
}

/** @internal Maps the history endpoint's payload to widget messages, dropping anything malformed. */
function harnessHistoryMessages(payload: unknown, sessionId: string): readonly AgentChatHistoryMessage[] {
  const values = Array.isArray(payload) ? payload : transportRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  return values.filter(transportRecord).flatMap((value) => {
    if ((value.role !== "user" && value.role !== "assistant" && value.role !== "error") || typeof value.content !== "string") return [];
    const approval = value.role === "assistant" ? harnessApprovalChallenge(value.approval, sessionId) : undefined;
    const interaction = value.role === "assistant" ? harnessHumanInteractionChallenge(value.interaction, sessionId) : undefined;
    const status = typeof value.status === "string" && HISTORY_STATUSES.has(value.status) ? value.status as AgentChatHistoryStatus : undefined;
    const work = value.role === "assistant" ? harnessHistoryWork(value.work) : undefined;
    const continuesTurnId = typeof value.continuesTurnId === "string" && value.continuesTurnId ? value.continuesTurnId : undefined;
    const failure = status === "failed" && transportRecord(value.failure) && harnessId(value.failure.code) ? { code: value.failure.code } : undefined;
    return [{
      role: value.role,
      content: approval ? "" : value.content,
      ...(transportRecord(value.work) && Array.isArray(value.work.timeline) ? { timeline: harnessHistoryTimeline(value.work.timeline) ?? [] } : {}),
      attachments: harnessHistoryAttachments(value.attachments),
      ...(typeof value.at === "string" ? { at: value.at } : {}),
      ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
      ...(status ? { status } : {}),
      ...(failure ? { failure } : {}),
      ...(value.role === "assistant" ? { narrations: harnessHistoryNarrations(value) } : {}),
      ...(work ? { work } : {}),
      ...(continuesTurnId ? { continuesTurnId } : {}),
      ...(value.ui === undefined ? {} : { ui: value.ui }),
      ...(approval ? { approval } : {}),
      ...(interaction ? { interaction } : {}),
    } satisfies AgentChatHistoryMessage];
  });
}

/** @internal The JSON body of a turn request; the same text is re-posted on every retry, `requestId` included. */
function harnessTurnJson(request: AgentChatTurnRequest): string {
  const wireContent = request.replyTo
    ? `[Trả lời tin nhắn của ${request.replyTo.author}]\n> ${request.replyTo.content.slice(0, 4000).replaceAll("\n", "\n> ")}\n\n${request.content}`
    : request.content;
  return JSON.stringify({
    content: wireContent,
    sessionId: request.sessionId,
    requestId: request.requestId,
    ...(request.attachments.length > 0 ? { attachments: request.attachments } : {}),
    ...(request.replyTo ? { replyTo: request.replyTo } : {}),
    ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    ...(request.agentContext ? { agentContext: request.agentContext } : {}),
  });
}
