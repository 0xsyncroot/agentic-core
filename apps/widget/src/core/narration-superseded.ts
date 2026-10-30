/**
 * @internal Which narration each chat bubble tells, so one the runtime later supersedes can leave the chat.
 *
 * The runtime says, as structure, when a step that told a sentence ran without progress and the stuck sentence
 * before it leaves the chat (`assistant-narration-superseded`); the widget only follows it. A progressing sentence never makes one
 * leave. Their words are never compared. A reload shows the same, because the history leaves superseded ones out.
 */
const narrationIds = new WeakMap<HTMLElement, string>();

/**
 * @internal A narration's chat bubble: the element given or a new one, holding `content` once there is any. A draft the review
 * sent back is never shown, live or reloaded: its text (e.g. a closing question the review removed) would mislead.
 */
function narrationBubble(content: string, element: HTMLElement = document.createElement("div"), draft = false): HTMLElement {
  element.className = "acw-bubble acw-markdown";
  element.dataset.messageKind = "narration";
  if (draft) { markDraftNarration(element); element.hidden = true; }
  if (content) element.innerHTML = renderMarkdown(content);
  return element;
}

/** @internal Remembers the narration a live bubble tells. */
function tagNarration(element: HTMLElement, narrationId: string): void {
  narrationIds.set(element, narrationId);
}

/** @internal The runtime superseded `narrationId`: it leaves the chat and `committed`, wherever it stood. */
function dropSupersededNarration(committed: Array<{ readonly content: string; readonly element: HTMLElement }>, narrationId: string): void {
  const index = committed.findIndex((narration) => narrationIds.get(narration.element) === narrationId);
  if (index < 0) return;
  committed[index]!.element.remove();
  committed.splice(index, 1);
}
