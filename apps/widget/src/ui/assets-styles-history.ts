/** @internal Conversation navigation, shared across products. */
const WIDGET_STYLES_HISTORY = `
  .acw-header-menu { width: 252px; padding: 8px; border-radius: 12px; right: 48px; top: 58px; box-shadow: 0 6px 24px #10182824; }
  .acw-header-menu button { min-height: 44px; gap: 12px; padding: 10px 12px; font-size: 15px; color: #344054; }
  .acw-header-menu svg { color: #667085; }
  .acw-session-browser { position: relative; z-index: 6; grid-row: 2; min-height: 0; display: flex; flex-direction: column; background: #fff;  overflow: hidden; }
  .acw-panel[data-browser="history"] { grid-template-rows: 66px minmax(0, 1fr); }
  .acw-panel[data-browser="history"] > .acw-conversation, .acw-panel[data-browser="history"] > .acw-footer { display: none; }
  .acw-session-browser[hidden], .acw-message-search[hidden] { display: none; }
  .acw-browser-heading { display: flex; align-items: center; gap: 8px; min-height: 56px; flex-shrink: 0; padding: 10px 12px; }
  .acw-browser-heading button, .acw-message-search button { border: 0; background: transparent; color: #475467; cursor: pointer; border-radius: 6px; min-width: 30px; height: 32px; font-size: 20px; }
  .acw-browser-heading button { display: grid; place-items: center; padding: 0; }
  .acw-browser-heading strong { font-size: 16px; }
  .acw-session-filter { display: flex; align-items: center; gap: 8px; min-height: 34px; flex-shrink: 0; margin: 0 16px 10px; padding: 0 8px; border: 1px solid var(--acw-border); border-radius: 8px; background: #f3f4f6; }
  .acw-session-filter:focus-within { border-color: var(--acw-primary); }
  .acw-session-filter svg { flex: 0 0 16px; color: #98a2b3; }
  .acw-session-filter input { min-width: 0; width: 100%; height: 32px; border: 0; outline: 0; padding: 0; background: transparent; font: inherit; font-size: 14px; color: var(--acw-text); }
  .acw-session-filter input::placeholder { color: #8b929c; }
  .acw-session-group { margin: 0 0 10px; }
  .acw-session-heading { margin: 0; min-height: 36px; display: flex; align-items: center; padding: 6px 12px; color: #8b929c; font-size: 14px; font-weight: 500; line-height: 1.5; }
  .acw-session-list { flex: 1; overflow-y: auto; min-height: 0; padding: 8px 12px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #cfd5df transparent; }
  .acw-session-entry { display: flex; flex-direction: column; gap: 0; position: relative; width: 100%; text-align: left; border: 0; border-radius: 8px; padding: 10px 12px; background: #fff; cursor: pointer; color: #344054; }
  .acw-session-entry strong { font-weight: 400; font-size: 14px; line-height: 1.5; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acw-session-entry time { font-size: 12px; color: #667085; }
  .acw-session-entry:hover, .acw-session-entry[aria-current="true"], .acw-session-entry:focus-visible { background: #f2f4ff; }
  .acw-session-entry[aria-current="true"] { box-shadow: inset 3px 0 0 var(--acw-primary); }
  .acw-browser-status { margin: 8px 20px; color: #667085; font-size: 13px; line-height: 1.5; }
  .acw-browser-status:empty { display: none; }
  .acw-sessions-retry, .acw-history-retry { margin: 8px 20px 16px; padding: 10px 16px; border: 1px solid var(--acw-border); background: #fff; border-radius: 8px; color: #344054; cursor: pointer; }
  .acw-panel[data-search="true"] { grid-template-rows: 66px 48px minmax(0, 1fr) auto; }
  .acw-message-search { grid-row: 2; min-width: 0; min-height: 48px; display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--acw-border); background: #fafbff; }
  .acw-panel[data-search="true"] > .acw-conversation { grid-row: 3; }
  .acw-panel[data-search="true"] > .acw-footer { grid-row: 4; }
  .acw-message-search button { flex: 0 0 30px; padding: 0; display: grid; place-items: center; }
  .acw-message-search button:hover, .acw-browser-heading button:hover { background: #eaecf0; }
  .acw-message-search > svg { flex: 0 0 16px; color: #98a2b3; }
  .acw-message-search input { width: 0; flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 8px 4px; font: inherit; font-size: 13px; }
  .acw-message-search span { font-size: 12px; color: #667085; white-space: nowrap; }
  .acw-message-search input::-webkit-search-cancel-button { display: none; }
  .acw-session-placeholder { display: flex; flex-direction: column; gap: 12px; padding: 16px 12px; }
  .acw-session-placeholder .acw-skeleton-line { display: block; width: 80%; height: 14px; }
  .acw-session-placeholder .acw-skeleton-line + .acw-skeleton-line { width: 38%; height: 11px; }
  .acw-history-empty { margin: 24px 12px; text-align: center; color: var(--acw-muted); }
  @media (prefers-reduced-motion: reduce) { .acw-session-placeholder .acw-skeleton-line { animation: none; } }
  .acw-search-match { outline: 2px solid #e9b949; outline-offset: 3px; border-radius: 6px; }
  .acw-session-browser button:focus-visible, .acw-message-search button:focus-visible { outline: 2px solid var(--acw-primary); outline-offset: -2px; }
`;
