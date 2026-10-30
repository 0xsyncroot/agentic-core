/** @internal Host-declared toggles in the header menu and their inline confirmation (ui/header-menu-toggles.ts). */
const WIDGET_STYLES_MENU = `
  .acw-header-menu .acw-menu-toggle { justify-content: space-between; }
  .acw-header-menu .acw-menu-toggle[hidden] { display: none; }
  .acw-menu-toggle[aria-disabled="true"] { opacity: .55; cursor: not-allowed; }
  .acw-menu-toggle-copy { display: grid; gap: 1px; min-width: 0; }
  .acw-menu-toggle-copy small { color: #667085; font-size: 11px; line-height: 1.35; }
  .acw-menu-toggle-mark { position: relative; flex: 0 0 auto; width: 30px; height: 18px; border-radius: 9px; background: #d0d5dd; }
  .acw-menu-toggle-mark::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .acw-menu-toggle[aria-checked="true"] .acw-menu-toggle-mark { background: var(--acw-primary); }
  .acw-menu-toggle[aria-checked="true"] .acw-menu-toggle-mark::after { transform: translateX(12px); }
  .acw-menu-confirm { position: absolute; z-index: 8; top: 52px; left: 12px; right: 12px; display: grid; gap: 6px; padding: 12px; border: 1px solid #e4e7ec; border-radius: 10px; background: #fff; color: #344054; box-shadow: 0 10px 28px rgba(16,24,40,.16); font-size: 12.5px; }
  .acw-menu-confirm p { margin: 0; line-height: 1.45; }
  .acw-menu-confirm div { display: flex; justify-content: flex-end; gap: 8px; }
  .acw-menu-confirm button { min-height: 32px; padding: 0 14px; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; color: #344054; font: inherit; cursor: pointer; }
  .acw-menu-confirm .acw-menu-confirm-accept { border-color: var(--acw-primary); background: var(--acw-primary); color: #fff; }
`;
