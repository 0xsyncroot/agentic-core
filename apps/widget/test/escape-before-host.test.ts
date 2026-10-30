import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Escape on a host page that takes the key first, in a real browser.
 *
 * A host app's shortcut library may listen for keydown on `document` in the capture phase and stop
 * Escape there, so the event never reaches a listener inside the widget's shadow root. The host
 * here does exactly that, registered before the widget as such an app's scripts are.
 */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

const TABLE = ["Kết quả:", "", "| Nhóm | Số người |", "|---|---|", "| Phụ cấp | 4 |"].join("\n");

/** A page whose own document-capture listener stops Escape, with `widgets` widgets on it, each with a table answer. */
async function open(widgets = 1): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html><body style="margin:0"><main>app <input id="page-input" aria-label="Tìm"></main></body></html>`);
  await page.evaluate(() => {
    const scope = window as unknown as { __name: (target: unknown) => unknown; hostEscapes: number };
    scope.__name = (target) => target;
    scope.hostEscapes = 0;
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      scope.hostEscapes += 1;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(([count, content]) => {
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): { send(text: string): Promise<void> } } }).AgentChat;
    const created = Array.from({ length: count }, (_, index) => api.create({
      persistSession: false, storageKey: `escape-${index}-${Math.random()}`, agentName: "Agent", startOpen: true,
      transport: {
        checkConnection: () => ({ status: "ok" }), loadHistory: () => [], loadSessions: () => ({ sessions: [] }),
        send: async () => ({ content }),
      },
    }));
    (window as unknown as { widgets: unknown[] }).widgets = created;
    return Promise.all(created.map((widget) => widget.send("đối chiếu")));
  }, [widgets, TABLE] as const);
  await page.locator("[data-agentic-chat] >> css=.acw-table-expand").first().waitFor();
  return page;
}

const hostEscapes = (page: Page) => page.evaluate(() => (window as unknown as { hostEscapes: number }).hostEscapes);
/** Whether the element matching `selector` in widget `index` is hidden. */
const hidden = (page: Page, selector: string, index = 0) => page.evaluate(([at, css]) =>
  document.querySelectorAll("[data-agentic-chat]")[at]!.shadowRoot!.querySelector<HTMLElement>(css)!.hidden, [index, selector] as const);
/** The class of what has focus inside widget `index`, or "" when focus is not in it. */
const focusedClass = (page: Page, index = 0) => page.evaluate((at) =>
  document.querySelectorAll("[data-agentic-chat]")[at]!.shadowRoot!.activeElement?.className ?? "", index);
/** A click delivered to the element itself: two widgets overlap, and a pointer click lands on the top one. */
const clickIn = (page: Page, selector: string, index = 0) => page.evaluate(([at, css]) =>
  document.querySelectorAll("[data-agentic-chat]")[at]!.shadowRoot!.querySelector<HTMLElement>(css)!.click(), [index, selector] as const);

test("the full-size table closes on Escape before the host's capture listener sees it, and focus goes back to its button", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=.acw-table-expand").click();
  assert.equal(await hidden(page, ".acw-table-modal"), false, "the view is open");
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-table-modal"), true, "Escape closes the view");
  assert.equal(await hostEscapes(page), 0, "the host's own Escape handler never ran: the chat keeps its table's key");
  assert.equal(await focusedClass(page), "acw-table-expand", "focus is back on the button that opened it");
  await page.close();
});

test("the header menu, the message search and the history close on Escape the host stops", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=.acw-more").click();
  assert.equal(await hidden(page, ".acw-header-menu"), false);
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-header-menu"), true, "the menu closes");
  assert.equal(await focusedClass(page), "acw-more", "and gives focus back to its button");

  await page.locator("[data-agentic-chat] >> css=.acw-more").click();
  await page.locator("[data-agentic-chat] >> css=.acw-menu-search").click();
  assert.equal(await hidden(page, ".acw-message-search"), false, "search is open, its box focused");
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-message-search"), true, "search closes");

  await page.locator("[data-agentic-chat] >> css=.acw-more").click();
  await page.locator("[data-agentic-chat] >> css=.acw-menu-history").click();
  assert.equal(await hidden(page, ".acw-session-browser"), false, "the history is open, its filter focused");
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-session-browser"), true, "the history closes");
  assert.equal(await hostEscapes(page), 0, "none of the three reached the host");
  await page.close();
});

test("Escape pressed on the page is the page's: the open table stays, and the host gets its key", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=.acw-table-expand").click();
  await page.locator("#page-input").focus();
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-table-modal"), false, "focus on a page control: the table is not the widget's to close");
  assert.equal(await hostEscapes(page), 1, "and the host handled its own key");
  await page.close();
});

test("an Escape that ends an IME composition closes nothing", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=.acw-table-expand").click();
  await page.evaluate(() => {
    const close = document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-table-close")!;
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, composed: true, cancelable: true }));
  });
  assert.equal(await hidden(page, ".acw-table-modal"), false, "the key cancelled the composition, not the view");
  await page.close();
});

test("two widgets on one page: Escape closes only the surface of the widget it was pressed in", async () => {
  const page = await open(2);
  await clickIn(page, ".acw-table-expand", 0);
  await clickIn(page, ".acw-table-expand", 1);
  assert.deepEqual([await hidden(page, ".acw-table-modal", 0), await hidden(page, ".acw-table-modal", 1)], [false, false]);
  assert.equal(await focusedClass(page, 1), "acw-table-close", "focus is in the second widget's view");
  await page.keyboard.press("Escape");
  assert.deepEqual([await hidden(page, ".acw-table-modal", 0), await hidden(page, ".acw-table-modal", 1)], [false, true],
    "the second closes, the first stays open");
  await page.evaluate(() => document.querySelectorAll("[data-agentic-chat]")[0]!.shadowRoot!.querySelector<HTMLElement>(".acw-table-close")!.focus());
  await page.keyboard.press("Escape");
  assert.equal(await hidden(page, ".acw-table-modal", 0), true, "then the first, once the key is pressed in it");
  assert.equal(await hostEscapes(page), 0);
  await page.close();
});
