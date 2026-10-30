/** @internal Styles of the widget's notices: the connection banner (ui/connection-banner.ts) and the composer's attachment notice. */
const WIDGET_STYLES_LINK = `
  .acw-link-banner { display: flex; align-items: center; gap: 10px; margin: 0 12px 8px; padding: 8px 12px; border: 1px solid #f5c26b; border-radius: 10px; background: #fff7e6; color: #7a4b00; font-size: 12.5px; }
  .acw-link-banner[data-state="offline"] { border-color: #f1a9a0; background: #fdeceb; color: #8a1f14; }
  .acw-link-banner[hidden], .acw-link-retry[hidden] { display: none; }
  .acw-attachment-notice { grid-column: 1 / -1; margin: 0; padding: 5px 8px; border-radius: 8px; background: #fff1f2; color: #b42318; font-size: 11.5px; line-height: 1.4; white-space: pre-line; overflow-wrap: anywhere; }
  .acw-link-retry { margin-left: auto; padding: 3px 10px; border: 1px solid currentColor; border-radius: 8px; background: transparent; font-size: 12.5px; cursor: pointer; }
`;
