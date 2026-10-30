import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { StubNode, createStubDom } from "./dom-stub.js";

/**
 * Where a Markdown link in an answer opens, through the built bundle.
 *
 * A link into the page the widget is embedded in navigates that page in place, so the user stays in the host application
 * and the widget comes back with it; any other link opens a new tab. The case it exists for: an answer ending with a link
 * to the record the agent has just created in the host application.
 */

const ORIGIN = "https://app.example";

async function mount(content: string): Promise<{ answer: StubNode }> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    Element: StubNode,
    location: { origin: ORIGIN, href: `${ORIGIN}/app/`, assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): { send(content: string): Promise<void> } };
  const widget = api.create({
    persistSession: false, startOpen: true,
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: async () => ({ content }) },
  });
  const sampler = setInterval(() => dom.stepFrame(), 1);
  try { await widget.send("tạo xong chưa"); } finally { clearInterval(sampler); }
  dom.flushFrames();
  const row = dom.body.querySelectorAll(".acw-assistant").at(-1);
  const answer = row?.querySelectorAll(".acw-bubble").find((node) => !node.hidden);
  assert.ok(answer, "the reply has an answer bubble");
  return { answer };
}

test("a link into the host page opens in the same tab; a link elsewhere keeps a new tab", async () => {
  const { answer } = await mount([
    "Đã tạo xong. [Mở bản ghi Tháng 9/2026](https://app.example/v2/popup/record/ae0a6a73-7b95)",
    "Tham khảo [hướng dẫn](https://docs.example/guide).",
  ].join("\n\n"));
  const html = answer.innerHTML;
  assert.match(html, /<a href="https:\/\/app\.example\/v2\/popup\/record\/ae0a6a73-7b95">Mở bản ghi Tháng 9\/2026<\/a>/u,
    "same origin: no target, so the click navigates the host page");
  assert.match(html, /<a href="https:\/\/docs\.example\/guide" target="_blank" rel="noopener noreferrer">hướng dẫn<\/a>/u);
  assert.doesNotMatch(html, /\]\(|\[Mở/u, "the Markdown link is rendered, never shown as raw markup");
});

test("a link's label and address stay text: markup in either never reaches the page", async () => {
  const { answer } = await mount("[<b>Mở</b> \"x\"](https://app.example/a?b=1&c=<i>)");
  const html = answer.innerHTML;
  assert.doesNotMatch(html, /<b>|<i>/u);
  assert.match(html, /<a href="https:\/\/app\.example\/a\?b=1&amp;c=&lt;i&gt;">&lt;b&gt;Mở&lt;\/b&gt; (&quot;|")x(&quot;|")<\/a>/u);
});
