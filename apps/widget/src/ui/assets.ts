/// <reference path="./assets-styles-callout.ts" />
/// <reference path="./assets-styles-connection.ts" />
/// <reference path="./assets-styles-history.ts" />
/// <reference path="./assets-styles.ts" />
/// <reference path="./assets-styles-cards.ts" />
/// <reference path="./assets-styles-table.ts" />
/// <reference path="./assets-styles-dock.ts" />
/// <reference path="./assets-styles-menu.ts" />

/** @internal Shadow DOM template. */
const WIDGET_TEMPLATE = `
  <div class="acw-root" data-position="right">
    <div class="acw-compact-status" data-agent-overlay hidden>
      <div class="acw-compact-copy" role="status" aria-live="polite"><span class="acw-compact-message" hidden></span><span class="acw-compact-label"></span></div>
      <button class="acw-compact-stop" type="button" aria-label="Dừng xử lý" title="Dừng xử lý"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg></button>
    </div>
    <button class="acw-launcher" type="button" aria-label="Mở trợ lý" aria-expanded="false">
      <span class="acw-launcher-avatar" aria-hidden="true"></span>
      <span class="acw-launcher-close" aria-hidden="true">
        <svg width="24" height="24" fill="none" viewBox="0 0 20 20"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.25" d="M15 5 5 15M5 5l10 10"></path></svg>
      </span>
    </button>
    <section class="acw-panel" aria-label="Trợ lý AI" hidden>
      <div class="acw-resize-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Thay đổi chiều rộng khung chat"></div>
      <header class="acw-header">
        <div class="acw-header-avatar" aria-hidden="true"></div>
        <div class="acw-header-copy">
          <div class="acw-title-line">
            <strong class="acw-agent-name"></strong>
            <span class="acw-badge" hidden></span>
          </div>
          <span class="acw-subtitle"></span>
        </div>
        <span class="acw-connection" title="Trạng thái kết nối" aria-label="Đang kết nối"></span>
        <button class="acw-menu-mode" type="button" hidden><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.25" width="14" height="11.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12.25 4.25v11.5" stroke="currentColor" stroke-width="1.5"/></svg><span class="acw-menu-mode-label" hidden></span></button>
        <button class="acw-more" type="button" aria-label="Thêm tùy chọn" title="Thêm tùy chọn" aria-haspopup="menu" aria-expanded="false">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.75" cy="10" r="1.35" fill="currentColor"/><circle cx="10" cy="10" r="1.35" fill="currentColor"/><circle cx="15.25" cy="10" r="1.35" fill="currentColor"/></svg>
        </button>
        <button class="acw-close" type="button" aria-label="Đóng trợ lý" title="Đóng trợ lý">
          <svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M14.5 5.5l-9 9m0-9 9 9"></path></svg>
        </button>
        <div class="acw-header-menu" role="menu" hidden>
          <button class="acw-menu-search" type="button" role="menuitem"><svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m17.5 17.5-5-5m-10-4.167a5.834 5.834 0 1 0 11.667 0 5.834 5.834 0 0 0-11.667 0"></path></svg><span>Tìm kiếm tin nhắn</span></button>
          <button class="acw-menu-history" type="button" role="menuitem"><svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 6.667V10l1.667 1.667m-9.125-2.5a7.5 7.5 0 1 1 .416 3.333m-.416 4.167V12.5h4.166"></path></svg><span>Lịch sử trò chuyện</span></button>
          <button class="acw-menu-new" type="button" role="menuitem"><svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.834 5.833H5A1.667 1.667 0 0 0 3.334 7.5V15A1.667 1.667 0 0 0 5 16.667h7.5A1.667 1.667 0 0 0 14.167 15v-.833m-.833-10 2.5 2.5m1.154-1.18a1.75 1.75 0 0 0-2.475-2.474L7.5 10v2.5H10z"></path></svg><span>Tạo phiên chat mới</span></button>
        </div>
      </header>
      <main class="acw-conversation"></main>
      <footer class="acw-footer">
        <button class="acw-jump" type="button" hidden aria-label="Xuống cuối cuộc trò chuyện" title="Xuống cuối cuộc trò chuyện">
          <svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 4.167v11.666M5 10.833l5 5 5-5"></path></svg>
        </button>
        <div class="acw-attachment-menu" role="menu" aria-label="Đính kèm" hidden>
          <button class="acw-capture-chat" type="button" role="menuitem">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.667 2.5H5A2.5 2.5 0 0 0 2.5 5v1.667M13.333 2.5H15A2.5 2.5 0 0 1 17.5 5v1.667M6.667 17.5H5A2.5 2.5 0 0 1 2.5 15v-1.667m10.833 4.167H15a2.5 2.5 0 0 0 2.5-2.5v-1.667M10 6.667v6.666M6.667 10h6.666" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 2"/></svg>
            <span>Chụp màn hình Chat</span><kbd>Ctrl+Alt+S</kbd>
          </button>
          <button class="acw-capture-screen" type="button" role="menuitem">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.667 2.5H5A2.5 2.5 0 0 0 2.5 5v1.667M13.333 2.5H15A2.5 2.5 0 0 1 17.5 5v1.667M6.667 17.5H5A2.5 2.5 0 0 1 2.5 15v-1.667m10.833 4.167H15a2.5 2.5 0 0 0 2.5-2.5v-1.667" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 2"/></svg>
            <span>Chụp màn hình khác</span><kbd>Ctrl+Alt+A</kbd>
          </button>
          <button class="acw-pick-file" type="button" role="menuitem">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="7" r="1.5" stroke="currentColor" stroke-width="1.4"/><path d="m4.5 15 4-4 2.5 2.5 1.5-1.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>Ảnh/Tệp đính kèm</span>
          </button>
        </div>
        <div class="acw-reply-preview" hidden>
          <span>Đang trả lời <strong class="acw-reply-author"></strong></span>
          <button class="acw-reply-close" type="button" aria-label="Hủy trả lời" title="Hủy trả lời">
            <svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.25" d="M15 5 5 15M5 5l10 10"></path></svg>
          </button>
        </div>
        <form class="acw-composer">
          <div class="acw-attachment-tray" aria-live="polite" hidden></div>
          <p class="acw-attachment-notice" role="status" aria-live="polite" hidden></p>
          <button class="acw-attach" type="button" aria-label="Đính kèm" title="Đính kèm" aria-haspopup="menu" aria-expanded="false" hidden>
            <svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 4.167v11.666M4.167 10h11.666"></path></svg>
          </button>
          <input class="acw-file-input" type="file" multiple hidden>
          <label class="acw-sr-only" for="acw-input">Nội dung yêu cầu</label>
          <textarea id="acw-input" rows="1" maxlength="32000"></textarea>
          <button class="acw-send" type="submit" aria-label="Gửi yêu cầu">
            <svg class="acw-send-icon" width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="m17.41 1.672.087-.005.109.006.075.014.102.029.09.038.083.048.075.055.068.063.043.05.069.096.043.08a.9.9 0 0 1 .075.263l.004.088a1 1 0 0 1-.02.184l-.029.102-5.443 15.065a1.292 1.292 0 0 1-2.282.13l-.054-.106-2.793-5.585-5.559-2.78a1.29 1.29 0 0 1-.748-1.05L1.4 8.333c0-.466.25-.893.7-1.141l.118-.059 15.014-5.421.088-.025z"></path></svg>
            <span class="acw-stop-icon" aria-hidden="true"></span>
          </button>
        </form>
      </footer>
    </section>
  </div>
`;

/**
 * @internal Isolated widget stylesheet, assembled from its two chunks — ui/assets-styles.ts
 * (`WIDGET_STYLES_A`) and ui/assets-styles-cards.ts (`WIDGET_STYLES_B`) — split purely to keep
 * every file under the source line limit (builder rule 6). The compact avatar rules follow the
 * base styles; this is still the one sheet the shadow root ever sees.
 */
const WIDGET_STYLES = WIDGET_STYLES_A + WIDGET_STYLES_B + WIDGET_STYLES_HISTORY + WIDGET_STYLES_LINK + WIDGET_STYLES_TABLE + WIDGET_STYLES_DOCK + WIDGET_STYLES_CALLOUT + WIDGET_STYLES_MENU + `
  /* The AI's own sky→violet frame (--acw-ai-*, see :host) around a white card (::before), with
     the tail (::after) in the frame's lower tone so it reads as one shape pointing at the avatar.
     Measured off the design reference; it sits on the launcher's own inset, so the tail lands on
     the avatar's centre. */
  .acw-compact-status {
    --acw-compact-tail: color-mix(in srgb, color-mix(in srgb, var(--acw-ai-violet), var(--acw-ai-sky)) 75%, #fff);
    --acw-compact-wash: color-mix(in srgb, var(--acw-ai-sky) 30%, #fff);
    position: absolute; right: 20px; bottom: 90px; isolation: isolate; width: 372px; max-width: calc(100% - 28px); display: flex; align-items: flex-start; gap: 10px; padding: 26px 24px 26px 28px;
    background:
      radial-gradient(70% 75% at 40% 108%, var(--acw-ai-violet), transparent 100%),
      radial-gradient(60% 110% at 72% 30%, var(--acw-ai-sky), transparent 100%),
      linear-gradient(175deg, color-mix(in srgb, var(--acw-ai-cyan) 25%, #fff), color-mix(in srgb, var(--acw-ai-cyan) 45%, #fff) 45%, color-mix(in srgb, var(--acw-compact-tail) 70%, #fff));
    color: var(--acw-text); border-radius: 14px; box-shadow: 0 10px 28px color-mix(in srgb, var(--acw-ai-violet) 30%, transparent), 0 1px 3px #1018280f; font-size: 13px; line-height: 1.55;
  }
  .acw-compact-status::before { content: ""; position: absolute; z-index: -1; inset: 14px; border: 1px solid transparent; border-radius: 9px; background: linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, var(--acw-ai-line-start), var(--acw-compact-wash) 30%, var(--acw-compact-wash) 64%, var(--acw-ai-line-end)) border-box; }
  .acw-compact-status::after { content: ""; position: absolute; bottom: -7px; right: 21px; width: 16px; height: 8px; background: var(--acw-compact-tail); clip-path: polygon(0 0, 100% 0, 50% 100%); }
  .acw-compact-copy { flex: 1; min-width: 0; }
  .acw-compact-message, .acw-compact-label { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; overflow-wrap: anywhere; }
  .acw-compact-message :is(p, ul, ol, blockquote, pre, table) { margin: 0; }
  .acw-compact-message :is(ul, ol) { padding-left: 18px; }
  .acw-compact-message strong { font-weight: 700; }
  /* The step line stays under what the agent said, one line, sweeping like the panel's live line
     (assets-styles.ts): the words alone sat still and read as a finished message. */
  .acw-compact-message:not([hidden]) + .acw-compact-label { margin-top: 6px; font-size: 12px; -webkit-line-clamp: 1; }
  /* Ringed square, the stop sign every chat uses: a bare grey square read as a checkbox. */
  .acw-compact-stop { position: relative; display: grid; place-items: center; flex-shrink: 0; width: 22px; height: 22px; margin-top: 1px; padding: 0; border: 1.5px solid var(--acw-border); border-radius: 50%; background: #fff; color: var(--acw-muted); cursor: pointer; transition: border-color .15s, color .15s; }
  .acw-compact-stop svg { width: 12px; height: 12px; }
  /* An arc running round the stop ring for as long as the turn runs: the bubble only exists then. */
  .acw-compact-stop::before { content: ""; position: absolute; inset: -1.5px; border: 1.5px solid transparent; border-top-color: var(--acw-ai-line-start); border-right-color: var(--acw-ai-line-end); border-radius: 50%; animation: acw-spin .9s linear infinite; }
  .acw-compact-stop:hover, .acw-compact-stop:focus-visible { outline: 0; border-color: var(--acw-muted); color: var(--acw-text); }
  .acw-root[data-position="left"] .acw-compact-status { right: auto; left: 20px; }
  .acw-root[data-position="left"] .acw-compact-status::after { right: auto; left: 21px; }
  /* The avatar alone, edge to edge: a ring around an avatar that has its own ring drew two. */
  .acw-root[data-compact="true"] .acw-launcher { box-shadow: 0 6px 18px #1018281f; }
  .acw-root[data-compact="true"] .acw-launcher-avatar { width: 100%; height: 100%; }
  /* The step line is solid ink, always. Nothing is drawn over the words and nothing is clipped into
     them: a light band passing over them (screen blend) washed the glyphs out at the moment it
     crossed, and a gradient clipped into the glyphs became a grey block on machines that run no
     animation. The only motion is the whole line easing between full and 72% strength, which
     leaves every word readable at every instant and is simply still when animations are off. */
  .acw-compact-label { color: #5b6879; animation: acw-compact-breathe 2.4s ease-in-out infinite; }
  @keyframes acw-compact-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .72; } }
  /* A halted arc reads as a broken ring. The label simply stays at full strength. */
  @media (prefers-reduced-motion: reduce) { .acw-compact-stop::before { display: none; } .acw-compact-label { animation: none; } }
  /* A finished account, opened, must not read as the answer: a rule down its left edge and narration
     in the muted ink at 13px. The rule is the cue, not the colour; while the turn runs it stays chat. */
  .acw-thinking[data-complete="true"] > .acw-thinking-body { padding-left: 12px; border-left: 2px solid #d0d5dd; }
  .acw-assistant .acw-thinking[data-complete="true"] .acw-timeline > .acw-bubble { color: #475467; font-size: 13px; }
  @media (forced-colors: active) { .acw-thinking[data-complete="true"] > .acw-thinking-body { border-left-color: CanvasText; } }
  @media (max-width: 520px) {
    .acw-compact-status { right: 14px; bottom: 84px; }
    .acw-root[data-position="left"] .acw-compact-status { left: 14px; }
  }
`;
