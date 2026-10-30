/** @internal Every label resolved to a concrete value; `planSentence` stays optional (its default is "no sentence"). */
type ResolvedLabels = Required<Omit<AgentChatLabels, "planSentence">> & Pick<AgentChatLabels, "planSentence">;

/**
 * @internal Fills in the neutral default for every label a host did not supply.
 *
 * This is the only place the widget's own English copy lives. A host that wants a business
 * sentence — Sample App's Vietnamese greeting for a dead connection, its "Em sẽ …" plan template —
 * passes `labels`; nothing here guesses one on its behalf.
 */
function resolveLabels(labels: AgentChatLabels | undefined): ResolvedLabels {
  return {
    ...(labels?.planSentence ? { planSentence: labels.planSentence } : {}),
    emptyAnswer: labels?.emptyAnswer?.trim() || "The assistant did not return an answer.",
    transportError: labels?.transportError?.trim() || "Something went wrong reaching the assistant. Please try again.",
    inProgress: labels?.inProgress?.trim() || "Working…",
    thinking: labels?.thinking?.trim() || "Thinking…",
    awaitingUser: labels?.awaitingUser?.trim() || "Waiting for your response…",
    interjectionRefused: labels?.interjectionRefused?.trim()
      || "That message did not reach the current request. Send it again once the assistant has finished.",
    interjectionRead: labels?.interjectionRead?.trim() || "Read",
    connectionLost: labels?.connectionLost?.trim() || "Connection to the assistant lost — reconnecting…",
    connectionGaveUp: labels?.connectionGaveUp?.trim() || "Could not reconnect to the assistant.",
    connectionRetry: labels?.connectionRetry?.trim() || "Retry",
    connectionWaiting: labels?.connectionWaiting?.trim() || "Waiting for the connection to send…",
    turnInterrupted: labels?.turnInterrupted?.trim() || "This request was interrupted. Please send it again.",
    calloutClose: labels?.calloutClose?.trim() || "Close",
    queued: labels?.queued?.trim() || "Queued — sent as soon as the assistant finishes the current request.",
  };
}

/**
 * @internal Takes the gateway's own words for the labels the host page did not supply.
 *
 * A product states its voice once, in its runtime answer, so a page that embeds the widget without
 * being handed `labels` still speaks the product's language instead of the neutral defaults above.
 * What the host did pass stays: the page is closer to the user than the gateway is.
 */
function applyGatewayLabels(labels: ResolvedLabels, host: AgentChatLabels | undefined, runtime: unknown): void {
  const offered = transportRecord(runtime) && transportRecord(runtime.labels) ? runtime.labels : undefined;
  if (!offered) return;
  const target = labels as { -readonly [Name in keyof ResolvedLabels]: ResolvedLabels[Name] };
  for (const name of ["emptyAnswer", "transportError", "inProgress", "thinking", "awaitingUser", "interjectionRefused", "interjectionRead", "connectionLost", "connectionGaveUp", "connectionRetry", "connectionWaiting", "turnInterrupted"] as const) {
    const text = offered[name];
    if (host?.[name]?.trim() || typeof text !== "string" || !text.trim() || text.length > 300) continue;
    target[name] = text.trim();
  }
}

/** @internal Shown above an answer the review sent back and the turn kept on screen while it works on. */
const DRAFT_NARRATION_LABEL = "Bản nháp — đang rà soát và hoàn thiện";

/** @internal The label is a CSS pseudo-element reading this attribute, so it survives the text being replaced as it streams. */
function markDraftNarration(element: HTMLElement): void {
  element.dataset.kind = "draft";
  element.dataset.draftLabel = DRAFT_NARRATION_LABEL;
}
