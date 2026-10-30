/**
 * @internal The host's card beside the assistant (ui/callout.ts). Joined after the other chunks in
 * ui/assets.ts. It wears the AI's blue→violet signature (--acw-ai-text-*, see :host) like the greeting.
 */
const WIDGET_STYLES_CALLOUT = `
  .acw-callout {
    --acw-callout-from: color-mix(in srgb, var(--acw-ai-text-from) 14%, #fff);
    --acw-callout-to: color-mix(in srgb, var(--acw-ai-text-to) 26%, #fff);
    position: fixed; z-index: 1; width: min(388px, calc(100vw - 32px)); padding: 16px; border-radius: 16px;
    background: linear-gradient(180deg, var(--acw-callout-from), var(--acw-callout-to));
    color: #1f1f1f; box-shadow: 0 12px 32px color-mix(in srgb, var(--acw-ai-text-from) 22%, transparent), 0 1px 3px #1018281f;
    font-family: Inter, Roboto, Helvetica, Arial, sans-serif; animation: acw-callout-in .16s ease-out;
  }
  .acw-callout-title { margin: 0 28px 10px 0; font-size: 18px; font-weight: 600; line-height: 1.35; color: #1f1f1f; }
  .acw-callout-body {
    padding: 12px 16px; border: 1px solid transparent; border-radius: 12px; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere;
    background: linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, var(--acw-ai-text-from), var(--acw-ai-text-to)) border-box;
  }
  .acw-callout-body :is(p, ul, ol) { margin: 0; }
  .acw-callout-body * + :is(p, ul, ol) { margin-top: 8px; }
  .acw-callout-body :is(ul, ol) { padding-left: 20px; }
  .acw-callout-body strong { font-weight: 700; }
  .acw-callout-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  /* Buttons do not inherit the font on their own: without font: inherit the label fell back to the browser's button font. */
  .acw-callout-action {
    height: 40px; padding: 0 20px; border: 1px solid #d0d5dd; border-radius: 10px; background: #fff; color: #1f1f1f;
    font: inherit; font-size: 16px; font-weight: 400; line-height: 1; cursor: pointer;
  }
  .acw-callout-action[data-primary="true"] { border-color: transparent; background: linear-gradient(90deg, var(--acw-ai-text-from), var(--acw-ai-text-to)); color: #fff; }
  .acw-callout-action:focus-visible, .acw-callout-close:focus-visible { outline: 2px solid var(--acw-ai-text-from); outline-offset: 2px; }
  .acw-callout-close {
    position: absolute; top: 12px; right: 12px; display: grid; width: 28px; height: 28px; place-items: center; padding: 0;
    border: 0; border-radius: 50%; background: transparent; color: #475467; cursor: pointer;
  }
  .acw-callout-close:hover { background: #ffffffb3; }
  /* A square turned 45 degrees: half of it shows beyond the card, pointing at the launcher. */
  .acw-callout-tail {
    position: absolute; left: var(--acw-callout-tail-x, 50%); display: none; width: 16px; height: 16px; margin-left: -8px; border-radius: 3px;
  }
  .acw-callout[data-tail="down"] .acw-callout-tail { display: block; bottom: -7px; transform: rotate(45deg); background: var(--acw-callout-to); }
  .acw-callout[data-tail="up"] .acw-callout-tail { display: block; top: -7px; transform: rotate(45deg); background: var(--acw-callout-from); }
  @keyframes acw-callout-in { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { .acw-callout { animation: none; } }
`;
