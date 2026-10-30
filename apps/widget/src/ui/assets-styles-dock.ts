/**
 * @internal The docked panel standing beside the page (ui/dock-layout.ts), the greeting being typed
 * (ui/welcome-typing.ts) and the composer while a turn runs (ui/send-queue.ts). Joined after the other
 * chunks in ui/assets.ts, so these win at equal specificity.
 */
const WIDGET_STYLES_DOCK = `
  /* Beside the page, not over it: the full height of the window, a rule on the inner edge, no floating shadow. */
  .acw-root[data-dock="push"] .acw-panel { max-width: none; border-left: 1px solid var(--acw-border); box-shadow: none; animation: none; }
  .acw-root[data-dock="push"][data-position="left"] .acw-panel { border-right: 1px solid var(--acw-border); border-left: 0; }
  /* The host's edge controls float over this margin of the conversation (dockedEdgeInset), never over a card's buttons. */
  .acw-root[data-dock="push"] .acw-conversation { padding-right: calc(16px + var(--acw-dock-inset, 0px)); }
  .acw-root[data-dock="push"][data-position="left"] .acw-conversation { padding-right: 16px; padding-left: calc(16px + var(--acw-dock-inset, 0px)); }
  /* The inner edge is the handle that widens the chat and narrows the page: a full-height line under the pointer. */
  .acw-root[data-dock="push"] .acw-resize-handle::after { top: 0; bottom: 0; }
  .acw-root[data-dock="push"] .acw-panel[data-resizing="true"] { user-select: none; }
  /* The caret that follows the greeting while it is being typed, in the greeting's own violet. */
  .acw-welcome-message[data-typing="true"]::after {
    content: ""; display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: -0.15em;
    background: var(--acw-ai-text-to); animation: acw-caret 1s steps(1, end) infinite;
  }
  @keyframes acw-caret { 50% { opacity: 0; } }
  /* The suggestions sit right on the composer, as close as its own inner padding. */
  .acw-conversation:has(> .acw-welcome:not([hidden])) { padding-bottom: 0; }
  /* The suggestion row held and dragged sideways (ui/welcome-typing.ts): the hand closes, no text is selected. */
  .acw-suggestions[data-dragging="true"] { cursor: grabbing; user-select: none; -webkit-user-select: none; }
  .acw-suggestions[data-dragging="true"] > .acw-suggestion { cursor: grabbing; }
  /* A message waiting for the running turn to finish (ui/send-queue.ts): faded, with the note under it. */
  .acw-user[data-queued="true"] :is(.acw-bubble, .acw-user-attachments) { opacity: .7; }
  .acw-user-read { align-self: flex-end; margin-top: 2px; color: var(--acw-muted); font-size: 11px; line-height: 1.4; text-align: right; }
  .acw-user-queued { align-self: flex-end; max-width: 86%; margin-top: 4px; color: var(--acw-muted); font-size: 12px; line-height: 1.4; text-align: right; }
  /* While a turn runs the button is Stop, until something is written or attached: then it sends. */
  .acw-send[data-pending="true"][data-draft="true"] .acw-send-icon { display: block; }
  .acw-send[data-pending="true"][data-draft="true"] .acw-stop-icon { display: none; }
`;
