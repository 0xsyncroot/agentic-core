/**
 * @internal Markdown tables in an answer, and the full-size table view (ui/table-viewer.ts).
 *
 * The bubble breaks text anywhere (`overflow-wrap: anywhere`), which is right for a long path in a
 * sentence and wrong in a table: it lets every column shrink to one character, so figures split
 * at their grouping marks and short headers stack a syllable per line. Inside a table words stay
 * whole; figures and single tokens stay on one line (classes set by shared/markdown-table.ts from
 * what the column holds); prose keeps a readable minimum width; and whatever is still too wide
 * scrolls inside the table's own frame, never the conversation. Colours come from the theme's
 * tokens where one exists, so the view follows the panel it opens from.
 */
const WIDGET_STYLES_TABLE = `
  .acw-markdown .acw-table-block { margin: 8px 0 11px; }
  .acw-table-tools { display: flex; justify-content: flex-end; margin: 0 0 4px; }
  .acw-table-expand { display: grid; width: 26px; height: 24px; place-items: center; padding: 0; border: 1px solid var(--acw-border); border-radius: 6px; background: var(--acw-surface); color: var(--acw-muted); cursor: pointer; }
  .acw-table-expand:hover { border-color: #c8d0dc; background: #f2f4f7; color: var(--acw-text); }
  .acw-table-expand svg { width: 15px; height: 15px; }
  .acw-compact-message .acw-table-tools { display: none; }
  /* Edge shadows say there is more to the side: the two "local" washes travel with the content and
     cover the two fixed shadows exactly when that edge is reached (no script, no scroll listener). */
  .acw-markdown .acw-table {
    overflow-x: auto; border: 1px solid #e4e7ec; border-radius: 8px; overscroll-behavior-x: contain; scrollbar-width: thin; scrollbar-color: #cfd5df transparent;
    background: linear-gradient(to right, var(--acw-surface) 40%, transparent) left / 28px 100% no-repeat local, linear-gradient(to left, var(--acw-surface) 40%, transparent) right / 28px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(16, 24, 40, .16), transparent) left / 12px 100% no-repeat scroll, radial-gradient(farthest-side at 100% 50%, rgba(16, 24, 40, .16), transparent) right / 12px 100% no-repeat scroll;
  }
  .acw-markdown table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.4; overflow-wrap: normal; word-break: normal; }
  .acw-markdown th, .acw-markdown td { padding: 6px 8px; border-bottom: 1px solid #eef1f5; text-align: left; vertical-align: top; }
  .acw-markdown th { background: #f8fafc; color: #475467; font-weight: 650; }
  .acw-markdown tbody tr:last-child td { border-bottom: 0; }
  /* A figure column is as wide as its widest figure (width: 1% asks for no more), right-aligned in tabular digits. */
  .acw-markdown .acw-cell-figure { width: 1%; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .acw-markdown .acw-cell-nowrap { white-space: nowrap; }
  /* A phrase wraps between words but never to one word a line; a header phrase gets room for about two words a line. */
  .acw-markdown .acw-cell-phrase { min-width: 6em; } .acw-markdown th.acw-cell-phrase { min-width: 8em; }
  .acw-markdown .acw-cell-text { min-width: 11em; overflow-wrap: break-word; }
  .acw-markdown .acw-cell-end { text-align: right; }
  .acw-markdown .acw-cell-center { text-align: center; }
  .acw-table-modal { position: absolute; z-index: 30; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(16, 24, 40, .46); }
  .acw-table-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr); width: fit-content; min-width: min(380px, 100%); max-width: min(1200px, 100%); max-height: 100%; overflow: hidden; border: 1px solid var(--acw-border); border-radius: 14px; background: var(--acw-surface); color: var(--acw-text); box-shadow: 0 22px 70px rgba(17, 24, 39, .3); animation: acw-enter .16s ease-out; }
  .acw-table-dialog:focus { outline: 0; }
  .acw-table-head { display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--acw-border); }
  .acw-table-head strong { font-size: 15px; white-space: nowrap; }
  .acw-table-meta { margin-right: auto; color: var(--acw-muted); font-size: 12px; white-space: nowrap; }
  .acw-table-copy { display: inline-flex; height: 32px; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--acw-border); border-radius: 8px; background: var(--acw-surface); color: var(--acw-text); font-size: 13px; white-space: nowrap; cursor: pointer; }
  .acw-table-copy[data-copy-state="success"] { border-color: color-mix(in srgb, var(--acw-success) 45%, #fff); color: var(--acw-success); }
  .acw-table-copy[data-copy-state="failed"] { border-color: #fecaca; color: #b42318; }
  .acw-table-close { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--acw-muted); cursor: pointer; }
  .acw-table-copy:hover, .acw-table-close:hover { background: #f2f4f7; color: var(--acw-text); }
  .acw-table-expand:focus-visible, .acw-table-copy:focus-visible, .acw-table-close:focus-visible { outline: 2px solid var(--acw-primary); outline-offset: 1px; }
  .acw-table-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #cfd5df transparent; }
  .acw-table-body:focus-visible { outline: 2px solid var(--acw-primary); outline-offset: -2px; }
  /* Pinned while the rows scroll; a collapsed border would scroll away, so the rule under it is a shadow. */
  .acw-table-body th { position: sticky; z-index: 1; top: 0; box-shadow: inset 0 -1px 0 #e4e7ec; }
  /* Room to spare (a page, not a side panel's frame): a larger table, prose at a longer measure. */
  @media (min-width: 720px) {
    .acw-table-body table { font-size: 13.5px; line-height: 1.45; }
    .acw-table-body th, .acw-table-body td { padding: 8px 12px; }
    .acw-table-body .acw-cell-phrase { min-width: 8em; }
    .acw-table-body .acw-cell-text { min-width: 16em; }
  }
  @media (max-width: 520px) { .acw-table-modal { padding: 12px; } .acw-table-head { padding-left: 12px; } }
  @media (max-width: 400px) { .acw-table-head strong { display: none; } }
  @media (prefers-reduced-motion: reduce) { .acw-table-dialog { animation: none; } }
  @media (forced-colors: active) { .acw-table-body th { box-shadow: none; border-bottom: 1px solid CanvasText; } }
`;
