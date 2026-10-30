/**
 * @internal First half of the isolated widget stylesheet — split from ui/assets.ts purely to keep
 * every file under the source line limit (builder rule 6); `WIDGET_STYLES` in assets.ts joins this
 * with `WIDGET_STYLES_B` (ui/assets-styles-cards.ts) back into one sheet, in this same order.
 */
const WIDGET_STYLES_A = `
  :host {
    --acw-primary: #2563eb;
    --acw-accent: #c026ff;
    /* Every brand-coloured surface below is derived from the two colours above, so a host's
       primaryColor / accentColor recolours the whole widget. Name no brand hue literally. */
    --acw-primary-soft: color-mix(in srgb, var(--acw-primary) 7%, #fff);
    --acw-primary-line: color-mix(in srgb, var(--acw-primary) 45%, #fff);
    --acw-brand-text: color-mix(in srgb, var(--acw-primary) 75%, var(--acw-accent));
    /* The one exception: the compact status frame wears the AI's own sky→violet signature on every
       host, as in the design reference (blue→violet on the green payroll screen), so primaryColor
       does not reach it. A host restyles it through these five. */
    --acw-ai-cyan: #cdeef9;
    --acw-ai-sky: #c6def9;
    --acw-ai-violet: #dfa8fe;
    --acw-ai-line-start: #5b8def;
    --acw-ai-line-end: #a16efa;
    /* Use the same blue-to-violet accent for the assistant name and greeting across hosts. */
    --acw-ai-text-from: #1482ff; --acw-ai-text-to: #cf11ff;
    --acw-success: #16a36a;
    --acw-text: #172033;
    --acw-muted: #667085;
    --acw-border: #e3e7ef;
    --acw-surface: #ffffff;
    color-scheme: light;
    font-family: Inter, Roboto, Helvetica, Arial, sans-serif !important;
    font-synthesis: none;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, textarea { font: inherit; }
  button { color: inherit; }
  [hidden] { display: none !important; }
  .acw-root { position: fixed; z-index: 2147483000; inset: 0; pointer-events: none; color: var(--acw-text); font-size: 14px; line-height: 1.45; }
  .acw-root > * { pointer-events: auto; }
  .acw-launcher {
    position: absolute; right: 20px; bottom: 20px; display: grid; width: 58px; height: 58px; place-items: center;
    overflow: hidden; padding: 0; border: 0; border-radius: 50%; background: linear-gradient(135deg, var(--acw-primary), var(--acw-accent));
    color: #fff; box-shadow: 0 12px 32px color-mix(in srgb, var(--acw-primary) 28%, transparent); cursor: pointer; transition: transform .18s, box-shadow .18s;
  }
  .acw-root[data-position="left"] .acw-launcher { right: auto; left: 20px; }
  .acw-launcher:hover { transform: translateY(-2px); box-shadow: 0 15px 36px color-mix(in srgb, var(--acw-primary) 34%, transparent); }
  /* The children are decoration and must not be hit targets: a logo <img> under the pointer
     starts a native image drag, which cancels the pointer sequence the launcher is following. */
  .acw-launcher > * { pointer-events: none; }
  .acw-launcher[data-draggable="true"] { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  /* After :hover on purpose: same specificity, and the lift must not fight the drag. */
  .acw-launcher[data-dragging="true"] { cursor: grabbing; transform: none; transition: none; box-shadow: 0 15px 36px color-mix(in srgb, var(--acw-primary) 34%, transparent); }
  .acw-launcher-avatar { display: grid; width: 48px; height: 48px; place-items: center; overflow: hidden; border-radius: 50%; background: rgba(255,255,255,.18); font-size: 16px; font-weight: 750; }
  .acw-launcher-avatar img { width: 100%; height: 100%; object-fit: cover; }
  /* A picture fills the launcher: inside the gradient it showed a ring around the face. Initials keep their inset disc. */
  .acw-launcher-avatar:has(img) { width: 100%; height: 100%; background: transparent; }
  .acw-launcher-close { display: none; font-size: 30px; font-weight: 300; line-height: 1; }
  /* Sized against .acw-root, never the viewport: a host may give the widget's element a smaller
     box (inset + transform, as an extension panel does under its own toolbar), and a panel as tall
     as the viewport then pushed the composer out of sight. On an ordinary page the root is the viewport. One column at the panel's width: an auto one grew to a long nowrap subtitle. */
  .acw-panel {
    position: absolute; right: 18px; bottom: 18px; display: grid; width: 410px; max-width: calc(100% - 24px); height: min(720px, calc(100% - 36px));
    min-height: 480px; grid-template-rows: 66px minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); overflow: hidden; border: 1px solid rgba(209, 214, 224, .92);
    border-radius: 18px; background: var(--acw-surface); box-shadow: 0 22px 70px rgba(17, 24, 39, .22); animation: acw-enter .18s ease-out;
  }
  .acw-root[data-position="left"] .acw-panel { right: auto; left: 18px; }
  .acw-root[data-mode="docked"] .acw-panel { top: 0; right: 0; bottom: 0; height: 100%; min-height: 0; border-top: 0; border-right: 0; border-bottom: 0; border-radius: 0; box-shadow: -12px 0 42px rgba(17,24,39,.16); animation-name: acw-enter-docked; }
  .acw-root[data-mode="docked"][data-position="left"] .acw-panel { right: auto; left: 0; border-right: 1px solid rgba(209,214,224,.92); border-left: 0; box-shadow: 12px 0 42px rgba(17,24,39,.16); }
  .acw-resize-handle { position: absolute; z-index: 3; top: 0; bottom: 0; left: 0; width: 8px; outline: 0; cursor: ew-resize; touch-action: none; }
  .acw-root[data-position="left"] .acw-resize-handle { right: 0; left: auto; }
  .acw-resize-handle::after { content: ""; position: absolute; top: 42%; bottom: 42%; left: 2px; width: 2px; border-radius: 2px; background: transparent; transition: background .15s; }
  .acw-root[data-position="left"] .acw-resize-handle::after { right: 2px; left: auto; }
  .acw-resize-handle:hover::after, .acw-resize-handle:focus-visible::after, .acw-panel[data-resizing="true"] .acw-resize-handle::after { background: var(--acw-primary); }
  .acw-header { position: relative; display: flex; align-items: center; gap: 9px; padding: 0 14px; border-bottom: 1px solid var(--acw-border); background: rgba(255,255,255,.96); }
  .acw-header-avatar, .acw-message-avatar, .acw-welcome-avatar { display: grid; place-items: center; flex: 0 0 auto; overflow: hidden; background: linear-gradient(135deg, var(--acw-primary-soft), #ecfdf5); color: var(--acw-primary); font-weight: 750; }
  .acw-header-avatar { width: 34px; height: 34px; border-radius: 50%; }
  .acw-header-avatar img, .acw-message-avatar img, .acw-welcome-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .acw-header-copy { min-width: 0; flex: 1; }
  .acw-title-line { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .acw-agent-name { overflow: hidden; color: var(--acw-ai-text-from); background: linear-gradient(to bottom right, var(--acw-ai-text-from), var(--acw-ai-text-to)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-size: 16px; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
  .acw-badge { padding: 1px 6px; border: 1px solid var(--acw-primary-line); border-radius: 4px; color: var(--acw-primary); font-size: 10px; line-height: 1.4; }
  .acw-subtitle { display: block; overflow: hidden; margin-top: 1px; color: #667085; font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
  .acw-connection { display: none; width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #f59e0b; }
  .acw-connection[data-state="online"] { background: var(--acw-success); }
  .acw-connection[data-state="offline"] { background: #ef4444; }
  /* The header's actions are one family: same 32px target, same 20px glyph drawn at 1.5px, 4px apart. */
  .acw-menu-mode, .acw-more, .acw-close { display: grid; width: 32px; height: 32px; flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #475467; cursor: pointer; }
  :is(.acw-menu-mode, .acw-more, .acw-close) svg { width: 20px; height: 20px; }
  :is(.acw-menu-mode, .acw-more, .acw-close):not([hidden]) ~ :is(.acw-more, .acw-close) { margin-left: -5px; }
  .acw-menu-mode:hover, .acw-more:hover, .acw-more[aria-expanded="true"], .acw-close:hover { background: #f2f4f7; color: #1f2937; }
  .acw-header-menu { position: absolute; z-index: 7; top: 52px; right: 42px; display: grid; width: 224px; overflow: hidden; padding: 5px; border: 1px solid #e4e7ec; border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(16,24,40,.16); }
  .acw-header-menu button { display: flex; min-height: 38px; align-items: center; gap: 10px; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: #344054; font-size: 12.5px; text-align: left; cursor: pointer; }
  .acw-header-menu button:hover, .acw-header-menu button:focus-visible { outline: 0; background: #f2f4f7; color: var(--acw-primary); }
  .acw-header-menu svg { width: 20px; height: 20px; flex: 0 0 auto; }
  .acw-conversation { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 16px 16px 24px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #cfd5df transparent; }
  /* Safari has no standard scrollbar properties, so the pseudo-elements give it the same thin
     bar. Chrome and Firefox ignore them once scrollbar-width is set, which is the intent. */
  .acw-conversation::-webkit-scrollbar { width: 6px; }
  .acw-conversation::-webkit-scrollbar-track { background: transparent; }
  .acw-conversation::-webkit-scrollbar-thumb { border-radius: 999px; background: #d0d5dd; }
  .acw-conversation:hover::-webkit-scrollbar-thumb { background: #b8c0cc; }
  .acw-welcome { display: flex; width: 100%; min-width: 0; min-height: 100%; flex-direction: column; align-items: center; justify-content: center; padding: 24px 0 0; text-align: center; }
  .acw-welcome[hidden] { display: none; }
  /* Shown while the conversation history is being fetched.

     It opens at zero opacity and fades in on a delay, so a history that arrives quickly is
     never announced by a flash of placeholder — the skeleton is only ever seen by someone who
     would otherwise have been looking at an empty panel. Removing it before the delay elapses
     costs nothing, which is why this is a CSS delay and not a timer the widget has to own. */
  .acw-skeleton { display: flex; flex-direction: column; gap: 14px; opacity: 0; animation: acw-skeleton-in .18s ease .15s forwards; }
  .acw-skeleton-row { display: flex; gap: 8px; align-items: flex-start; }
  .acw-skeleton-row[data-from="user"] { justify-content: flex-end; }
  .acw-skeleton-avatar { width: 28px; height: 28px; flex: 0 0 auto; border-radius: 50%; }
  .acw-skeleton-block { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; gap: 7px; }
  .acw-skeleton-line { height: 11px; border-radius: 6px; }
  .acw-skeleton-line:nth-child(2) { width: 92%; }
  .acw-skeleton-line:nth-child(3) { width: 64%; }
  .acw-skeleton-bubble { width: 46%; height: 34px; border-radius: 14px 14px 4px 14px; }
  .acw-skeleton-avatar, .acw-skeleton-line, .acw-skeleton-bubble {
    background: linear-gradient(100deg, #eef1f6 30%, #f7f9fc 50%, #eef1f6 70%) 0 0 / 300% 100%;
    animation: acw-skeleton-sweep 1.25s linear infinite;
  }
  .acw-welcome-avatar { width: 116px; height: 116px; margin: auto 0 16px; border-radius: 28px; background: transparent; color: var(--acw-primary); font-size: 30px; }
  .acw-welcome-avatar img { object-fit: contain; }
  .acw-welcome h2 { margin: 0; color: #1f1f1f; font-size: 15px; font-weight: 400; line-height: 1.333; }
  .acw-welcome-message { min-height: 1.467em; margin: 2px 0 auto; color: var(--acw-ai-text-from); background: linear-gradient(to bottom right, var(--acw-ai-text-from), var(--acw-ai-text-to)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-size: 15px; font-weight: 600; line-height: 1.467; }
  .acw-suggestions { display: flex; width: 100%; min-width: 0; max-width: 100%; flex-wrap: nowrap; justify-content: flex-start; margin-top: 24px; gap: 8px; overflow-x: auto; overflow-y: hidden; padding: 2px 0; scrollbar-width: none; overscroll-behavior-x: contain; }
  .acw-suggestions::-webkit-scrollbar { display: none; }
  .acw-suggestion { flex: 0 0 auto; min-width: 0; max-width: none; min-height: 28px; padding: 4px 10px; border: 1px solid #e4e7ec; border-radius: 12px; background: #fff; color: #6b7280; font-size: 13px; font-weight: 400; line-height: 20px; white-space: nowrap; cursor: pointer; transition: color .15s, border-color .15s; }
  .acw-suggestion:hover, .acw-suggestion:focus-visible { outline: 0; border-color: #c7cdd6; color: #374151; }
  .acw-day { width: fit-content; margin: 2px auto 24px; padding: 3px 8px; background: #f4f6f8; color: #344054; font-size: 11px; }
  .acw-message { margin: 0 0 18px; }
  .acw-user { display: flex; flex-direction: column; align-items: flex-end; }
  .acw-user-time { margin: 0 1px 4px; color: #7a8190; font-size: 11px; }
  .acw-user .acw-bubble { max-width: 88%; padding: 11px 13px; overflow-wrap: anywhere; border-radius: 15px 15px 4px 15px; background: var(--acw-primary); color: #fff; font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
  .acw-user-attachments { display: flex; max-width: 88%; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-bottom: 6px; }
  .acw-user-attachment { display: flex; min-width: 150px; max-width: 240px; align-items: center; gap: 8px; padding: 7px; border: 1px solid #dbe3ef; border-radius: 11px; background: #fff; color: #344054; text-align: left; }
  .acw-user-attachment img { width: 56px; height: 56px; flex: 0 0 auto; border-radius: 7px; object-fit: cover; }
  .acw-user-attachment-icon { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: 8px; background: var(--acw-primary-soft); color: var(--acw-primary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .acw-user-attachment-copy { min-width: 0; }
  .acw-user-attachment-name { display: block; overflow: hidden; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .acw-user-attachment-size { color: #667085; font-size: 9.5px; }
  .acw-user-undelivered { align-self: flex-end; max-width: 86%; margin-top: 4px; color: #b42318; font-size: 11px; line-height: 1.4; text-align: right; }
  .acw-assistant-meta { display: flex; align-items: center; gap: 7px; margin: 0 0 7px; color: #667085; font-size: 11.5px; }
  .acw-message-avatar { width: 28px; height: 28px; border-radius: 50%; font-size: 10px; }
  .acw-assistant-name { color: #475467; font-weight: 600; }
  /* What the agent writes — answers, its plan, its narration — reads at 15px; the account of its work at 13px. */
  .acw-assistant .acw-bubble { margin-left: 35px; overflow-wrap: anywhere; color: #111827; font-size: 15px; line-height: 1.5; }
  .acw-assistant.acw-error .acw-bubble { padding: 9px 11px; border: 1px solid #fecaca; border-radius: 9px; background: #fff1f2; color: #b42318; }
  /* The account of a turn's work: borderless, muted lines in the order things happened, above the
     answer. While the turn runs there is no heading at all; once it ends, everything here folds
     under one summary line with a chevron, and a click opens it again. */
  .acw-thinking { margin: 0 0 6px 35px; color: var(--acw-muted); }
  .acw-thinking > summary { display: inline-flex; align-items: center; gap: 2px; min-height: 24px; list-style: none; color: #374151; font-size: 13px; line-height: 20px; cursor: pointer; user-select: none; }
  .acw-thinking > summary::-webkit-details-marker { display: none; }
  .acw-thinking:not([data-complete="true"]) > summary { display: none; }
  .acw-thinking[data-empty="true"] > summary { cursor: default; }
  .acw-thinking[data-empty="true"] > summary > .acw-chevron { display: none; }
  .acw-chevron { width: 16px; height: 16px; margin-left: auto; flex: 0 0 auto; color: #667085; transform: rotate(-90deg); transition: transform .15s; }
  details[open] > summary > .acw-chevron { transform: rotate(0); }
  .acw-thinking > summary > .acw-chevron, .acw-work > summary > .acw-chevron { width: 14px; height: 14px; margin-left: 0; color: currentColor; }
  .acw-thinking[data-complete="true"][open] > .acw-thinking-body { padding-top: 6px; }
  .acw-thinking[data-folding="true"] > .acw-thinking-body { overflow: hidden; }
  /* Folded from the first frame of the fold, not from its last. */
  .acw-thinking[data-folding="true"] > summary > .acw-chevron { transform: rotate(-90deg); }
  .acw-timeline { display: flex; flex-direction: column; gap: 8px; }
  .acw-timeline:empty { display: none; }
  /* Narration is the agent speaking, so it is ordinary chat text, not status ink. */
  .acw-assistant .acw-timeline > .acw-bubble { margin-left: 0; }
  /* A kept draft says so quietly above its text; the words come from the data-draft-label attribute. */
  /* Once, above the text: repeated under it as well, two drafts in a row showed the label twice back to back. */
  .acw-bubble[data-kind="draft"]::before { content: attr(data-draft-label); display: block; margin-bottom: 4px; color: var(--acw-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  .acw-assistant.acw-error .acw-timeline > .acw-bubble { padding: 0; border: 0; background: transparent; color: #111827; }

  /* One line per stretch of work: a small glyph and a phrase, no box. It opens onto its entries. */
  .acw-work { color: #374151; font-size: 13px; line-height: 20px; }
  .acw-work > summary { display: flex; min-height: 22px; align-items: center; gap: 7px; list-style: none; cursor: pointer; user-select: none; }
  .acw-work > summary::-webkit-details-marker { display: none; }
  /* A line with nothing more to show is plain text: no chevron, nothing to click. */
  div.acw-work { display: flex; min-height: 22px; align-items: center; gap: 7px; }
  /* While the turn runs: the plan told as one sentence of chat text, and one line saying what is happening now. */
  .acw-assistant .acw-thinking-body > .acw-plan-sentence { margin: 0 0 6px; overflow-wrap: anywhere; color: #111827; font-size: 15px; line-height: 1.5; }
  /* What a finished step found: the agent's own words, so chat text like its narration. */
  .acw-timeline > .acw-step-note { overflow-wrap: anywhere; color: #111827; font-size: 15px; line-height: 1.5; }
  /* In the checklist it is its step's result: under the step, in the checklist's own size. */
  .acw-thinking:is([data-complete="true"], [data-detail="open"]) .acw-timeline > .acw-step-note { margin: -4px 0 4px 23px; color: #374151; font-size: 13px; line-height: 20px; }
  .acw-live-line { display: flex; min-width: 0; min-height: 24px; align-items: center; gap: 7px; margin-top: 4px; color: #374151; font-size: 13px; line-height: 20px; }
  /* Running, the line is the one thing on screen saying the agent is at work, so it reads at body size and
     weight: at 13px in muted ink its shimmer was easy to miss, where the assistants people compare it
     with show a larger, darker line with a clear band of light moving across it. */
  .acw-live-line[data-state="active"] { color: #374151; font-size: 13px; font-weight: 400; }
  .acw-live-line .acw-work-icon:empty { display: none; }
  /* The chevron that opens the checklist while the turn still runs; the whole line is its target. */
  .acw-live-line:has(> .acw-live-toggle:not([hidden])) { cursor: pointer; }
  .acw-live-toggle { display: inline-grid; width: 18px; height: 18px; margin-left: -3px; padding: 0; place-items: center; border: 0; border-radius: 4px; background: none; color: #98a2b3; cursor: pointer; }
  .acw-live-toggle > .acw-chevron { width: 14px; height: 14px; margin-left: 0; color: currentColor; }
  .acw-live-line[data-detail="open"] > .acw-live-toggle > .acw-chevron { transform: rotate(0); }
  .acw-live-toggle:focus-visible { outline: 2px solid var(--acw-primary); outline-offset: 1px; }
  /* The latest call for the step above it, in the quiet ink of a detail. */
  .acw-call-line { display: flex; min-width: 0; min-height: 22px; align-items: center; gap: 7px; margin-top: 4px; color: #374151; font-size: 13px; line-height: 20px; }
  .acw-call-line .acw-work-icon { color: #98a2b3; }
  /* An activity line is one line: what does not fit ends in an ellipsis. */
  .acw-call-line > .acw-live-label, .acw-live-line .acw-live-label, .acw-work-label, .acw-thinking-item > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acw-call-line[data-state="error"], .acw-call-line[data-state="error"] .acw-work-icon { color: #b42318; }
  .acw-call-line .acw-work-icon:empty { display: none; }
  .acw-timeline:not(:empty) + .acw-live-line { margin-top: 8px; }
  /* A step not yet done — running, or waiting on the user's decision — in a quieter ink than finished work. */
  .acw-live-line[data-icon="waiting"] .acw-work-icon { color: #98a2b3; }
  /* Folded, the account opens onto the plan checklist: the steps this turn reached, ✓ done or ○ where it
     stopped, on one connecting line, each with the tool work done inside it. */
  .acw-check-step { color: #374151; font-size: 13px; line-height: 20px; }
  .acw-check-body { display: flex; min-width: 0; flex-direction: column; }
  .acw-check-label { overflow-wrap: anywhere; }
  .acw-check-step:is([data-state="active"], [data-state="paused"]) .acw-check-label { color: #1f2937; font-weight: 600; }
  .acw-check-work { display: flex; flex-direction: column; gap: 2px; margin: 3px 0 4px; font-weight: 400; }
  .acw-check-work:empty { display: none; }
  .acw-timeline > .acw-check-step:has(+ .acw-check-step)::before { bottom: -11px; }
  .acw-timeline > .acw-check-step:not(:has(+ .acw-check-step))::before { content: none; }
  .acw-work-icon { display: grid; width: 15px; height: 15px; flex: 0 0 auto; place-items: center; }
  .acw-work-label { min-width: 0; }
  .acw-work[data-state="error"] { color: #b42318; }
  .acw-work[data-state="partial"] .acw-work-icon { color: #b54708; }
  .acw-work-steps { display: flex; flex-direction: column; margin: 4px 0 2px 4px; padding: 0; list-style: none; }
  .acw-thinking-item { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 7px; min-height: 27px; align-items: start; color: #374151; font-size: 13px; line-height: 20px; }
  .acw-thinking-item:not(:last-child)::before { content: ""; position: absolute; top: 14px; bottom: -3px; left: 6px; width: 1px; background: var(--acw-primary-line); }
  .acw-thinking-dot { z-index: 1; display: grid; width: 13px; height: 13px; margin-top: 1px; place-items: center; border: 2px solid var(--acw-primary-line); border-radius: 50%; background: #fff; color: #fff; font-size: 8px; line-height: 1; }
  /* A visible half-ring; each state affects only its own dot, never nested tool rows. */
  .acw-thinking-item[data-state="active"] > .acw-thinking-dot {
    border-color: var(--acw-primary); border-top-color: transparent; border-right-color: transparent;
    animation: acw-spin .7s linear infinite;
  }
  .acw-thinking-item[data-state="active"] { color: #1f2937; font-weight: 600; }
  /* Running work pulses while waiting for the business system.
     The supports block replaces this baseline with a text sweep when clipping is available;
     browsers without clipping still show readable, animated words. */
  .acw-thinking-item[data-state="active"] > span:last-child,
  .acw-work[data-state="active"] .acw-work-label,
  .acw-call-line:is([data-state="active"], [data-state="thinking"]) .acw-live-label,
  .acw-live-line[data-state="active"] .acw-live-label {
    animation: acw-thinking-pulse 1.7s ease-in-out infinite;
  }
  /* Keep the readable baseline unless text clipping supports the transparent fill. */
  @supports ((background-clip: text) or (-webkit-background-clip: text)) {
    .acw-thinking-item[data-state="active"] > span:last-child,
    .acw-work[data-state="active"] .acw-work-label,
    .acw-call-line:is([data-state="active"], [data-state="thinking"]) .acw-live-label,
    .acw-live-line[data-state="active"] .acw-live-label {
      background: linear-gradient(100deg, #1d2939 38%, #9db0c8 50%, #1d2939 62%) 0 0 / 300% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
      will-change: background-position;
      animation: acw-text-sweep 1.9s linear infinite;
    }
    /* The timeline's own lines sweep in their muted ink: they are status, not the answer. */
    .acw-work[data-state="active"] .acw-work-label,
    .acw-call-line:is([data-state="active"], [data-state="thinking"]) .acw-live-label {
      background-image: linear-gradient(100deg, #374151 40%, #9ca3af 50%, #374151 60%);
    }
    /* "Đang suy nghĩ" is the one thing on screen saying the agent is alive, so it runs a touch
       slower than the others and its own light passes wide enough to always be mid-sweep
       somewhere in the sentence. The band itself stays close to the resting ink rather than
       reaching toward white: a faint pass across muted gray, the same restrained sheen other
       assistants use, not a bright flash. The compact bubble's step line sweeps its own way
       (assets.ts), since it is the one line shown over the host page on any machine. */
    .acw-live-line[data-state="active"] .acw-live-label {
      background-image: linear-gradient(100deg, #374151 25%, #9ca3af 50%, #374151 75%);
      animation-duration: 2.2s;
    }
  }
  /* Paused work keeps its colour and weight; only an explicitly completed step gets a check. */
  .acw-thinking-item[data-state="paused"] { font-weight: 600; }
  .acw-thinking-item[data-state="paused"] > .acw-thinking-dot { border-color: var(--acw-primary); background: #fff; }
  .acw-thinking-item[data-state="paused"]:not(:last-child)::before { background: #dfe4ec; }
  .acw-thinking-item[data-state="done"] > .acw-thinking-dot { border-color: var(--acw-primary); background: var(--acw-primary); }
  .acw-thinking-item[data-state="done"] > .acw-thinking-dot::after { content: "✓"; }
  .acw-thinking-item[data-state="partial"] > .acw-thinking-dot { border-color: #f59e0b; background: #f59e0b; }
  .acw-thinking-item[data-state="partial"] > .acw-thinking-dot::after { content: "!"; }
  .acw-thinking-item[data-state="error"] { color: #b42318; }
  .acw-thinking-item[data-state="error"] > .acw-thinking-dot { border-color: #d92d20; background: #d92d20; }
  .acw-thinking-item[data-state="error"] > .acw-thinking-dot::after { content: "✕"; }
  /* Not-yet and never-happened differ by form, not by a lightness step: both must stay above
     the 4.5:1 contrast floor at 11.5px, so neither may be lightened to signal its state. */
  .acw-thinking-item[data-state="pending"] { color: #667085; }
  .acw-thinking-item[data-state="pending"] > .acw-thinking-dot { border-color: #c8d2e0; }
  .acw-thinking-item[data-state="skipped"] { color: #667085; }
  .acw-thinking-item[data-state="skipped"] > span:last-child { text-decoration: line-through; text-decoration-color: #c8d2e0; }
  .acw-thinking-item[data-state="skipped"] > .acw-thinking-dot { border-style: dashed; border-color: #c8d2e0; background: #fff; }
  .acw-thinking-item[data-state="pending"]:not(:last-child)::before,
  .acw-thinking-item[data-state="skipped"]:not(:last-child)::before { background: #dfe4ec; }
  /* A tool call the runtime says never really ran (cancelled, or never started): a dash, not a
     strikethrough — the call was never claimed to have happened, so there is nothing to cross out. */
  .acw-thinking-item[data-state="muted"] { color: #98a2b3; }
  .acw-thinking-item[data-state="muted"] > .acw-thinking-dot { border-color: #c8d2e0; background: #fff; } .acw-thinking-item[data-state="muted"] > .acw-thinking-dot::after { content: "–"; }
  .acw-thinking-item[data-state="muted"]:not(:last-child)::before { background: #dfe4ec; }
  /* Markdown lists that nest (tables: ui/assets-styles-table.ts): each outranks the base rule in the second half by specificity, not by order. */
  .acw-markdown li > ul, .acw-markdown li > ol { margin: 3px 0 5px; } .acw-markdown .acw-list-inner { margin-top: 0; padding-left: 40px; }
`;
