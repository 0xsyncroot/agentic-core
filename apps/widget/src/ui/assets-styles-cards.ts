/**
 * @internal Second half of the isolated widget stylesheet — split from ui/assets.ts purely to keep
 * every file under the source line limit (builder rule 6); `WIDGET_STYLES` in assets.ts joins
 * `WIDGET_STYLES_A` (ui/assets-styles.ts) with this one back into one sheet, in this same order.
 */
const WIDGET_STYLES_B = `
  /* layout/style only, never paint: paint containment hard-clips anything drawn outside this box's
     own edge, and a Vietnamese tone mark (the ngã on "ĩ" in "nghĩ") sits tall enough above the line's
     ascent to poke past that edge when the live line is the first thing in the body — paint clipped
     the top of the mark flat instead of just skipping paint outside the (much larger) real bounds. */
  .acw-thinking-body { contain: layout style; }
  /* Stands in the answer bubble while an answer is written or reviewed. Quiet ink and no box: it is status, and it must not read as part of the answer. */
  .acw-draft-note { display: flex; min-height: 21px; align-items: center; gap: 8px; color: #667085; font-size: 12.5px; }
  .acw-typing { display: inline-flex; align-items: center; gap: 3px; }
  .acw-typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--acw-primary); animation: acw-pulse 1.2s ease-in-out infinite; }
  .acw-typing i:nth-child(2) { animation-delay: .16s; }
  .acw-typing i:nth-child(3) { animation-delay: .32s; }

  .acw-rich { display: flex; width: calc(100% - 35px); min-width: 0; flex-direction: column; gap: 8px; margin: 9px 0 0 35px; }
  .acw-rich:empty { display: none; }
  .acw-approval { display: grid; gap: 7px; padding: 12px 13px; border: 1px solid #d9e0eb; border-radius: 10px; background: #f8fafc; }
  .acw-approval[data-resolved="true"] { border-color: #cce8dc; background: #f5fbf8; }
  .acw-approval-title { color: #101828; font-size: 13.5px; font-weight: 700; }
  /* Both sentences carry the decision — what will happen and what it risks — so both read at the
     same dark ink and size. A lighter second rule here used to win the cascade on .acw-approval-risk
     alone and quietly faded the risk sentence back down, which is the one line that most needs to be read. */
  .acw-approval-description, .acw-approval-risk { margin: 0; color: #1d2939; font-size: 12.5px; line-height: 1.5; }
  .acw-approval-fields { display: grid; grid-template-columns: minmax(90px, auto) 1fr; gap: 4px 8px; margin: 0; font-size: 11.5px; }
  .acw-approval-fields dt { color: #475467; }
  .acw-approval-fields dd { margin: 0; color: #1d2939; font-weight: 600; overflow-wrap: anywhere; white-space: pre-line; }
  .acw-approval-status { color: #59647a; font-size: 11px; }
  .acw-approval[data-superseded] { opacity: .62; }
  .acw-approval-target { margin: 0; color: #1d2939; font-size: 11.5px; font-weight: 700; }
  .acw-approval-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 3px; }
  /* Shared by class, not by ".acw-approval-actions button": the confirm button for a multi-question
     interaction renders inside its summary tab, not inside this row, and must still look the same. */
  .acw-approval-deny, .acw-approval-approve { min-height: 31px; padding: 6px 11px; border-radius: 7px; font-size: 11.5px; font-weight: 650; cursor: pointer; }
  .acw-approval-deny { border: 1px solid #cfd6e2; background: #fff; color: #344054; }
  .acw-approval-approve { border: 1px solid var(--acw-primary); background: var(--acw-primary); color: #fff; }
  .acw-approval-deny:hover:not(:disabled), .acw-approval-approve:hover:not(:disabled) { filter: brightness(.96); }
  .acw-approval-deny:disabled, .acw-approval-approve:disabled { opacity: .55; cursor: not-allowed; }
  .acw-interaction-form { display: grid; gap: 10px; margin-top: 4px; }
  .acw-interaction-field { display: grid; gap: 8px; color: #344054; font-size: 11.5px; font-weight: 600; }
  .acw-interaction-question { color: #101828; font-size: 12.5px; font-weight: 650; line-height: 1.4; }
  /* A caution is a footnote, quieter than the sentence saying what is asked. Under a box to type
     into it waits, hidden, until that box is first clicked (see freeTextNotice). */
  .acw-interaction-notice { margin: 0; color: #667085; font-size: 11px; line-height: 1.45; }
  .acw-interaction-field .acw-interaction-notice { margin-top: -3px; }
  .acw-interaction-notice[hidden] { display: none; }
  .acw-interaction-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 10px; padding-top: 9px; border-top: 1px solid #e8ecf2; }
  .acw-interaction-footer .acw-approval-status { flex: 1 1 120px; min-width: 0; }
  .acw-interaction-footer .acw-approval-actions { margin-top: 0; }
  .acw-approval-actions > [hidden] { display: none; }
  .acw-interaction-field small { color: #667085; font-weight: 400; line-height: 1.4; }
  .acw-interaction-field input:not([type="checkbox"]), .acw-interaction-field textarea {
    width: 100%; min-height: 34px; box-sizing: border-box; border: 1px solid #cfd6e2; border-radius: 7px;
    padding: 7px 9px; background: #fff; color: #172033; font: inherit; font-weight: 400;
  }
  .acw-interaction-field textarea { resize: vertical; min-height: 70px; }
  .acw-interaction-field input:focus, .acw-interaction-field textarea:focus {
    outline: 2px solid color-mix(in srgb, var(--acw-primary) 20%, transparent); border-color: var(--acw-primary);
  }
  .acw-interaction-url { display: block; max-height: 64px; overflow: auto; overflow-wrap: anywhere; padding: 7px 9px;
    border: 1px solid #e2e7ef; border-radius: 7px; background: #fff; color: #344054; font-size: 10.5px; }
  /* Choice buttons: an answer is a tap, not typing into a dropdown, and the selected one stays
     visibly marked once picked since the field itself may already be scrolled out of view. */
  .acw-interaction-choices { display: grid; gap: 6px; margin-top: 2px; }
  .acw-interaction-choice-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .acw-choice-button { min-height: 31px; padding: 6px 12px; border: 1px solid #cfd6e2; border-radius: 999px;
    background: #fff; color: #344054; font-size: 11.5px; font-weight: 600; cursor: pointer; }
  .acw-choice-button:hover:not(:disabled) { border-color: var(--acw-primary); }
  .acw-choice-button[data-selected="true"] { border-color: var(--acw-primary);
    background: color-mix(in srgb, var(--acw-primary) 12%, #fff); color: var(--acw-primary); font-weight: 700; }
  .acw-choice-button:disabled { opacity: .55; cursor: not-allowed; }
  /* The one-line reason a labelled choice exists, under its title inside the same button. */
  .acw-choice-button { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
  .acw-choice-desc { color: #8791a3; font-weight: 400; }
  .acw-choice-button[data-selected="true"] .acw-choice-desc { color: color-mix(in srgb, var(--acw-primary) 70%, #8791a3); }
  /* A question's answers are a list of full-width rows with a radio (or, for several answers, a
     checkbox) in front: long labels such as a name plus its code wrap inside their own row
     instead of pushing pills of uneven height around. A free-text field's quick picks live
     outside .acw-interaction-choices and stay compact chips. */
  .acw-interaction-choices .acw-interaction-choice-list { display: grid; gap: 6px; }
  .acw-interaction-choices .acw-choice-button { display: grid; width: 100%; min-height: 38px; box-sizing: border-box; grid-template-columns: 16px minmax(0, 1fr);
    align-items: center; gap: 1px 10px; padding: 8px 12px; border: 1px solid #d9dfe8; border-radius: 9px; background: #fff; color: #1d2939; font-size: 12.5px; font-weight: 500; line-height: 1.35; }
  .acw-interaction-choices .acw-choice-button > * { grid-column: 2; min-width: 0; overflow-wrap: break-word; }
  .acw-interaction-choices .acw-choice-desc { font-size: 11px; }
  .acw-interaction-choices .acw-choice-button::before { content: ""; grid-column: 1; grid-row: 1 / span 2; width: 16px; height: 16px;
    box-sizing: border-box; border: 1.5px solid #98a2b3; border-radius: 50%; background: #fff; }
  .acw-interaction-choices .acw-choice-button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--acw-primary) 55%, #d9dfe8); background: #fbfcfe; }
  .acw-interaction-choices .acw-choice-button:focus-visible { outline: 2px solid color-mix(in srgb, var(--acw-primary) 30%, transparent); outline-offset: 1px; }
  .acw-interaction-choices .acw-choice-button[data-selected="true"] { border-color: var(--acw-primary); background: color-mix(in srgb, var(--acw-primary) 6%, #fff); color: #101828; font-weight: 600; }
  .acw-interaction-choices .acw-choice-button[data-selected="true"]::before { border-color: var(--acw-primary);
    background: var(--acw-primary); box-shadow: inset 0 0 0 3px #fff; }
  .acw-interaction-choices[data-multi="true"] .acw-choice-button::before { border-radius: 4px; }
  .acw-interaction-choices[data-multi="true"] .acw-choice-button[data-selected="true"]::before { box-shadow: none; }
  .acw-interaction-choices[data-multi="true"] .acw-choice-button[data-selected="true"]::after { content: ""; grid-column: 1; grid-row: 1 / span 2;
    justify-self: center; width: 4px; height: 8px; margin-top: -2px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
  /* "Khác…" is the way out of the list, not one more answer in it. */
  .acw-interaction-choices .acw-choice-button[data-other="true"]:not([data-selected="true"]) { border-style: dashed; background: transparent; }
  .acw-interaction-error { display: block; margin-top: 2px; color: #d92d20; font-weight: 400; }
  .acw-interaction-error:empty, .acw-interaction-error[hidden] { display: none; }
  /* The review tab's stand-in for a required question nobody answered yet: clickable, not just
     coloured, since it is also how the accountant gets back to that tab. */
  .acw-interaction-unanswered { border: 0; background: transparent; padding: 0; color: #b54708; font-size: 12px; font-weight: 500;
    text-align: left; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .acw-interaction-pager { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 11px; color: #667085; }
  .acw-interaction-pager-nav { border: 1px solid #cfd6e2; background: #fff; color: #344054; border-radius: 6px;
    padding: 4px 9px; font-size: 11px; cursor: pointer; }
  .acw-interaction-pager-nav:disabled { opacity: .4; cursor: not-allowed; }
  /* Only rendered once pagination hides some choices from view; confirms a pick made on another
     page without the accountant having to page back to see it highlighted again. */
  .acw-interaction-selected-hint { display: block; margin-top: 2px; color: #475467; font-weight: 400; }
  .acw-interaction-next { justify-self: start; border: 1px solid var(--acw-primary); background: #fff; color: var(--acw-primary);
    border-radius: 7px; padding: 6px 11px; font-size: 11.5px; font-weight: 650; cursor: pointer; margin-top: 2px; }
  .acw-interaction-next:hover { filter: brightness(.97); }
  /* One tab per question, plus a final summary tab: clicking any of them always works, a
     single-choice/boolean answer also advances on its own (see #renderHumanInteraction). Drawn
     as quiet underlined steps, never as filled buttons: the card's only filled button is the one
     that sends. A long question title shrinks with an ellipsis; "Xem lại" never does. */
  .acw-interaction-tabs { display: flex; gap: 16px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid #e4e8ef; }
  .acw-interaction-tabs::-webkit-scrollbar { display: none; }
  .acw-interaction-tab { flex: 0 1 auto; min-width: 0; margin: 0 0 -1px; padding: 6px 0 7px; border: 0; border-bottom: 2px solid transparent;
    border-radius: 0; background: transparent; color: #667085; font-size: 11.5px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .acw-interaction-tab:hover:not(:disabled) { color: #344054; }
  .acw-interaction-tab:focus-visible { outline: 2px solid color-mix(in srgb, var(--acw-primary) 30%, transparent); outline-offset: -2px; }
  .acw-interaction-tab[data-active="true"] { border-bottom-color: var(--acw-primary); color: var(--acw-primary); }
  .acw-interaction-tab[data-answered="true"]::before { content: "✓ "; color: #0b9f6c; }
  .acw-interaction-tab[data-summary="true"] { flex: 0 0 auto; }
  .acw-interaction-panels { margin-top: 12px; }
  .acw-interaction-summary-panel { display: grid; gap: 10px; }
  /* Label over value, one answer per block: a long question beside a short answer squeezed the
     answer into a sliver and broke codes such as "SHCB008" mid-word. */
  .acw-interaction-summary { display: grid; grid-template-columns: minmax(0, 1fr); margin: 0; padding: 0 12px;
    border: 1px solid #e2e7ef; border-radius: 9px; background: #fff; }
  .acw-interaction-summary dt { padding-top: 8px; color: #667085; font-size: 11px; font-weight: 500; line-height: 1.4; }
  .acw-interaction-summary dd { margin: 2px 0 0; padding-bottom: 8px; color: #101828; font-size: 12.5px; font-weight: 600; line-height: 1.4; overflow-wrap: break-word; }
  .acw-interaction-summary dd + dt { border-top: 1px solid #eef1f5; }
  .acw-ui-actions { display: flex; flex-wrap: wrap; gap: 7px; }
  .acw-ui-button { min-height: 31px; padding: 6px 11px; border: 1px solid #cfd6e2; border-radius: 7px; background: #fff; color: #344054; font-size: 11.5px; font-weight: 600; cursor: pointer; }
  .acw-ui-button[data-variant="primary"] { border-color: #0b9f6c; background: #0b9f6c; color: #fff; }
  .acw-ui-button[data-variant="ghost"] { border-color: transparent; background: transparent; color: var(--acw-primary); }
  .acw-ui-button:hover:not(:disabled) { filter: brightness(.96); }
  .acw-ui-button:disabled { opacity: .55; cursor: not-allowed; }
  .acw-task-card { width: 100%; overflow: hidden; border: 1.5px solid #cdeee2; border-radius: 9px; background: #fbfffd; box-shadow: 0 2px 8px rgba(16,185,129,.06); }
  .acw-card-header { display: flex; align-items: center; gap: 7px; padding: 8px 9px 6px; }
  .acw-card-icon { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 6px; background: #0aaa67; color: #fff; font-size: 12px; font-weight: 750; }
  .acw-card-title { min-width: 0; flex: 1; color: #17201d; font-size: 12px; font-weight: 700; }
  .acw-card-count { color: #344054; font-size: 10.5px; font-weight: 650; }
  .acw-card-progress { height: 5px; margin: 0 9px 7px; overflow: hidden; border-radius: 5px; background: #e4e7ec; }
  .acw-card-progress > span { display: block; height: 100%; border-radius: inherit; background: #0b9f6c; transition: width .2s; }
  .acw-step-list { margin: 0; padding: 0 9px 7px; list-style: none; }
  .acw-step { position: relative; color: #344054; font-size: 10.5px; }
  .acw-step-list > .acw-step:not(:last-child)::before { content: ""; position: absolute; top: 17px; bottom: -4px; left: 6px; width: 1px; background: #65d4ac; }
  .acw-step-row { position: relative; display: grid; min-height: 27px; grid-template-columns: 15px minmax(0,1fr) 16px; align-items: center; column-gap: 6px; }
  .acw-step-dot { z-index: 1; display: grid; width: 13px; height: 13px; place-items: center; border: 1.5px dashed #98a2b3; border-radius: 50%; background: #fff; color: #0b9f6c; font-size: 8px; line-height: 1; }
  .acw-step[data-status="completed"] > .acw-step-row > .acw-step-dot, .acw-step[data-status="active"] > .acw-step-row > .acw-step-dot { border-style: solid; border-color: #0b9f6c; }
  .acw-step[data-status="completed"] > .acw-step-row > .acw-step-dot::after { content: "✓"; }
  .acw-step[data-status="active"] > .acw-step-row > .acw-step-dot::after { content: "▶"; margin-left: 1px; font-size: 6px; }
  .acw-step[data-status="failed"] > .acw-step-row > .acw-step-dot { border-style: solid; border-color: #ef4444; color: #ef4444; }
  .acw-step[data-status="failed"] > .acw-step-row > .acw-step-dot::after { content: "!"; }
  .acw-step[data-link="true"]:not([data-status="failed"]) > .acw-step-row > .acw-step-dot { border-style: solid; border-color: #0b9f6c; }
  .acw-step[data-link="true"]:not([data-status="failed"]) > .acw-step-row > .acw-step-dot::after { content: "▶"; margin-left: 1px; font-size: 6px; }
  .acw-step-label { min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
  .acw-step-toggle, .acw-step-link { display: grid; width: 16px; height: 20px; padding: 0; place-items: center; justify-self: end; border: 0; border-radius: 4px; background: transparent; text-decoration: none; cursor: pointer; transition: color .15s; }
  .acw-step-toggle { color: #667085; }
  .acw-step-link { color: #0b9f6c; }
  .acw-step-toggle:hover, .acw-step-link:hover { background: transparent; color: #087a55; }
  .acw-step-toggle:focus-visible, .acw-step-link:focus-visible { outline: 1px solid #78d9b6; outline-offset: 1px; background: transparent; color: #087a55; }
  .acw-step-toggle .acw-chevron { width: 14px; height: 14px; margin: 0; transform: rotate(0); }
  .acw-step-toggle[aria-expanded="true"] .acw-chevron { transform: rotate(180deg); }
  .acw-step-link svg { width: 14px; height: 14px; }
  .acw-step-trailing { width: 16px; height: 1px; }
  .acw-step-children { position: relative; margin: 0 0 0 6px; padding: 0 0 0 15px; list-style: none; }
  .acw-step-children::before { content: ""; position: absolute; top: -14px; bottom: 14px; left: 0; width: 1px; background: #65d4ac; }
  .acw-step-children > .acw-step > .acw-step-row::before { content: ""; position: absolute; top: 50%; left: -15px; width: 15px; border-top: 1px solid #65d4ac; }
  .acw-card-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 7px 8px; border-top: 1px solid #dff3eb; background: #eefaf5; }
  .acw-info-card { width: 100%; border: 1px solid #e0e5ed; border-radius: 8px; background: #fafbfc; }
  .acw-info-card summary { display: flex; align-items: center; gap: 7px; padding: 8px 10px; list-style: none; color: #344054; font-size: 11.5px; font-weight: 650; cursor: pointer; }
  .acw-info-card summary::-webkit-details-marker { display: none; }
  .acw-info-body { padding: 0 10px 9px; color: #475467; font-size: 11.5px; }
  .acw-ui-markdown { color: #344054; font-size: 12px; }
  .acw-message-actions { display: flex; min-height: 25px; align-items: center; gap: 2px; margin: 5px 0 0 35px; }
  .acw-message-actions:empty { display: none; }
  .acw-action { position: relative; display: grid; width: 25px; height: 25px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: #667085; font-size: 13px; cursor: pointer; }
  .acw-action svg { width: 16px; height: 16px; fill: none; stroke: currentColor; }
  .acw-action:hover, .acw-action[data-selected="true"] { background: #f2f4f7; color: var(--acw-primary); }
  .acw-action[data-copy-state]::after { content: attr(data-copy-label); position: absolute; z-index: 8; bottom: calc(100% + 5px); left: 50%; width: max-content; padding: 4px 7px; border-radius: 5px; background: #344054; color: #fff; font-size: 9.5px; font-weight: 500; line-height: 1.2; pointer-events: none; transform: translateX(-50%); }
  .acw-footer { position: relative; padding: 10px 16px 14px; background: linear-gradient(0deg, #fff 78%, rgba(255,255,255,0)); }
  /* The way back down once the user has scrolled up to read. Shown only while they are away,
     and it carries a dot once something new has landed below the fold. */
  .acw-jump { position: absolute; z-index: 6; top: -38px; left: 50%; display: grid; width: 30px; height: 30px; padding: 0; place-items: center; border: 1px solid #e0e5ed; border-radius: 50%; background: #fff; color: #344054; box-shadow: 0 4px 14px rgba(16,24,40,.14); cursor: pointer; transform: translateX(-50%); }
  .acw-jump[hidden] { display: none; }
  .acw-jump:hover, .acw-jump:focus-visible { outline: 0; background: #f2f4f7; color: var(--acw-primary); }
  .acw-jump svg { width: 18px; height: 18px; }
  .acw-jump[data-fresh="true"]::after { content: ""; position: absolute; top: 1px; right: 1px; width: 8px; height: 8px; border: 1.5px solid #fff; border-radius: 50%; background: var(--acw-primary); }
  .acw-attachment-menu { position: absolute; z-index: 9; bottom: calc(100% - 5px); left: 16px; display: grid; width: min(292px, calc(100% - 32px)); padding: 5px; border: 1px solid #e1e5ec; border-radius: 9px; background: #fff; box-shadow: 0 8px 26px rgba(16,24,40,.18); }
  .acw-attachment-menu button { display: grid; min-height: 38px; grid-template-columns: 20px minmax(0,1fr) auto; align-items: center; gap: 9px; padding: 7px 9px; border: 0; border-radius: 6px; background: transparent; color: #475467; font-size: 12px; text-align: left; cursor: pointer; }
  .acw-attachment-menu button:hover, .acw-attachment-menu button:focus-visible { outline: 0; background: #f2f4f7; color: #344054; }
  .acw-attachment-menu svg { width: 20px; height: 20px; }
  .acw-attachment-menu kbd { color: #667085; font: 10.5px/1.2 Inter, Roboto, Helvetica, Arial, sans-serif; white-space: nowrap; }
  .acw-reply-preview { display: flex; min-height: 29px; align-items: center; justify-content: space-between; gap: 10px; padding: 0 3px 6px; color: #667085; font-size: 11.5px; }
  .acw-reply-preview strong { color: #172033; font-weight: 650; }
  .acw-reply-close { display: grid; width: 25px; height: 25px; flex: 0 0 auto; padding: 0; place-items: center; border: 0; border-radius: 5px; background: transparent; color: #344054; cursor: pointer; }
  .acw-reply-close:hover, .acw-reply-close:focus-visible { outline: 0; background: #f2f4f7; color: #d92d20; }
  .acw-reply-close svg { width: 20px; height: 20px; }
  .acw-attachment-tray { display: flex; min-width: 0; grid-column: 1 / -1; gap: 7px; overflow-x: auto; padding: 1px 1px 2px; scrollbar-width: thin; }
  .acw-attachment-chip { position: relative; display: flex; min-width: 112px; max-width: 174px; height: 48px; flex: 0 0 auto; align-items: center; gap: 7px; padding: 5px 25px 5px 5px; border: 1px solid #d8dee8; border-radius: 9px; background: #fff; }
  .acw-attachment-thumb { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 6px; background: var(--acw-primary-soft); color: var(--acw-primary); font-size: 9px; font-weight: 700; text-transform: uppercase; }
  .acw-attachment-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .acw-attachment-meta { min-width: 0; }
  .acw-attachment-name { display: block; overflow: hidden; color: #344054; font-size: 10.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .acw-attachment-size { display: block; color: #667085; font-size: 9px; }
  .acw-attachment-remove { position: absolute; top: 3px; right: 3px; display: grid; width: 19px; height: 19px; padding: 0; place-items: center; border: 0; border-radius: 50%; background: transparent; color: #667085; font-size: 16px; line-height: 1; cursor: pointer; }
  .acw-attachment-remove:hover, .acw-attachment-remove:focus-visible { outline: 0; background: #f2f4f7; color: #d92d20; }
  .acw-attachment-chip[data-kind="image"] { width: 80px; min-width: 80px; max-width: 80px; height: 80px; padding: 3px; }
  .acw-attachment-chip[data-kind="image"] .acw-attachment-thumb { width: 100%; height: 100%; border-radius: 6px; }
  .acw-attachment-chip[data-kind="image"] .acw-attachment-meta { display: none; }
  .acw-attachment-chip[data-kind="image"] .acw-attachment-remove { top: -5px; right: -5px; border: 1px solid #e1e5ec; background: #fff; box-shadow: 0 1px 4px rgba(16,24,40,.16); }
  .acw-composer { display: grid; min-height: 56px; grid-template-columns: 34px minmax(0,1fr) 36px; align-items: end; column-gap: 7px; row-gap: 5px; padding: 7px 7px 7px 9px; border: 1.5px solid transparent; border-radius: 18px; background: linear-gradient(#fff,#fff) padding-box, linear-gradient(110deg,var(--acw-primary),var(--acw-accent)) border-box; }
  .acw-composer:focus-within { box-shadow: 0 0 0 3px color-mix(in srgb, var(--acw-primary) 8%, transparent); }
  .acw-composer[data-dragging="true"] { background: linear-gradient(var(--acw-primary-soft),var(--acw-primary-soft)) padding-box, linear-gradient(110deg,var(--acw-primary),var(--acw-accent)) border-box; box-shadow: 0 0 0 3px color-mix(in srgb, var(--acw-primary) 10%, transparent); }
  .acw-composer textarea { width: 100%; min-width: 0; min-height: 39px; max-height: 130px; resize: none; border: 0; outline: 0; padding: 9px 2px 5px; background: transparent; color: #1d2939; font-size: 15px; line-height: 1.45; }
  .acw-composer textarea::placeholder { color: #98a2b3; }
  .acw-attach { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border: 0; border-radius: 50%; background: #f2f4f7; color: #667085; cursor: pointer; }
  .acw-attach svg { width: 20px; height: 20px; }
  .acw-attach:disabled { opacity: .5; cursor: not-allowed; }
  .acw-send { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border: 0; border-radius: 50%; background: linear-gradient(135deg,var(--acw-primary),var(--acw-accent)); color: #fff; cursor: pointer; }
  .acw-send-icon { width: 20px; height: 20px; transform: translate(1px,-1px); }
  .acw-stop-icon { display: none; width: 13px; height: 13px; border-radius: 3px; background: currentColor; }
  .acw-send[data-pending="true"] .acw-send-icon { display: none; }
  .acw-send[data-pending="true"] .acw-stop-icon { display: block; }
  .acw-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .acw-markdown > :first-child { margin-top: 0; }
  .acw-markdown > :last-child { margin-bottom: 0; }
  .acw-markdown p { margin: 0 0 9px; }
  .acw-markdown h1, .acw-markdown h2, .acw-markdown h3, .acw-markdown h4, .acw-markdown h5, .acw-markdown h6 { margin: 13px 0 7px; color: #101828; line-height: 1.3; }
  .acw-markdown h1 { font-size: 19px; } .acw-markdown h2 { font-size: 17px; } .acw-markdown h3 { font-size: 15px; }
  .acw-markdown h4 { font-size: 15px; font-weight: 600; } .acw-markdown h5, .acw-markdown h6 { font-size: 14px; font-weight: 600; }
  .acw-markdown ul, .acw-markdown ol { margin: 7px 0 10px; padding-left: 20px; }
  .acw-markdown li { margin: 4px 0; }
  .acw-markdown blockquote { margin: 8px 0; padding: 5px 9px; border-left: 3px solid var(--acw-primary-line); background: #f8fafc; color: #475467; }
  .acw-markdown hr { height: 0; margin: 12px 0; border: 0; border-top: 1px solid var(--acw-border); }
  .acw-markdown code { padding: 1px 4px; border-radius: 4px; background: #eef1f5; font-family: inherit; font-size: 13px; line-height: 1.5; }
  .acw-markdown pre { overflow-x: auto; margin: 8px 0; padding: 10px; border-radius: 8px; background: #20242a; color: #f8fafc; }
  .acw-markdown pre code { padding: 0; background: transparent; color: inherit; font-family: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", "Noto Sans Mono", "Courier New", monospace; }
  .acw-markdown a { color: var(--acw-primary); text-decoration: underline; text-underline-offset: 2px; }
  @keyframes acw-enter { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  @keyframes acw-enter-docked { from { opacity: 0; transform: translateX(12px); } }
  @keyframes acw-spin { to { transform: rotate(360deg); } }
  @keyframes acw-skeleton-in { to { opacity: 1; } }
  @keyframes acw-skeleton-sweep { to { background-position: -300% 0; } }
  @keyframes acw-text-sweep { to { background-position: -300% 0; } }
  /* Plain opacity, nothing else: the one animatable property no browser that can animate at
     all gets wrong, so this is the floor every "thinking" label stands on before the nicer
     gradient sweep above is even asked whether it can run. */
  @keyframes acw-thinking-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
  @keyframes acw-pulse { 0%, 100% { opacity: .28; transform: scale(.82); } 50% { opacity: 1; transform: scale(1); } }
  @media (max-width: 520px) {
    .acw-panel { inset: 0 !important; width: 100% !important; max-width: none; height: 100%; min-height: 0; border: 0; border-radius: 0; }
    .acw-resize-handle { display: none; }
    .acw-launcher { right: 14px; bottom: 14px; }
    .acw-root[data-position="left"] .acw-launcher { right: auto; left: 14px; }
    .acw-conversation { padding-right: 13px; padding-left: 13px; }
    .acw-footer { padding-right: 10px; padding-left: 10px; }
    .acw-attachment-menu { right: 10px; left: 10px; width: auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
    /* A halted spinner would otherwise freeze as a ring with one side missing, and these
       users lose the only cue for which step is running. Weight alone is too quiet next to a
       column of identical rings, so the running step also gets a filled core: unmistakable at
       a glance, and it moves nothing. */
    .acw-thinking-item[data-state="active"] > .acw-thinking-dot {
      border-top-color: var(--acw-primary);
      border-right-color: var(--acw-primary);
      background: radial-gradient(circle at center, var(--acw-primary) 0 2.5px, #fff 2.5px);
    }
    .acw-thinking-item[data-state="active"] { font-weight: 600; }
    /* A swept gradient halted at .01ms lands on an arbitrary slice of itself. A flat block says
       the same thing — content is coming — and moves nothing. */
    .acw-skeleton-avatar, .acw-skeleton-line, .acw-skeleton-bubble { background: #eef1f6; }
    /* A halted sweep leaves the label on an arbitrary slice of its own gradient, and a halted
       pulse can leave the dot at 28% opacity. Both go back to plain, legible paint. */
    .acw-thinking-item[data-state="active"] > span:last-child {
      background: none; -webkit-text-fill-color: #101828; color: #101828;
    }
    .acw-work[data-state="active"] .acw-work-label {
      background: none; -webkit-text-fill-color: #374151; color: #374151;
    }
    .acw-live-line[data-state="active"] .acw-live-label {
      background: none; -webkit-text-fill-color: #374151; color: #374151;
    }
    .acw-typing i { opacity: .7; transform: none; }
  }
`;
