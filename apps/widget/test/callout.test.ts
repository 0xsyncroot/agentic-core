import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * The callout card in a real browser: where it stands relative to the launcher and the panel is
 * layout arithmetic, which the stub DOM cannot show.
 */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

const CARD = { id: "summary", title: "Tóm tắt", markdown: "- Dòng **một**\n- Dòng hai", actions: [{ id: "go", label: "Đi", primary: true }] };

async function open(options: Record<string, unknown> = {}, size = { width: 1600, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport: size });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html lang="vi"><body style="margin:0"><main id="app" style="height:100vh">app</main></body></html>`);
  await page.evaluate("window.__name = (target) => target; window.__log = [];");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => {
    const log = (window as unknown as { __log: unknown[] }).__log;
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): unknown } }).AgentChat;
    (window as unknown as { widget: unknown }).widget = api.create({
      persistSession: false, storageKey: `callout-${Math.random()}`, agentName: "Example Assistant",
      labels: { calloutClose: "Đóng" },
      transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
      onCalloutAction: (event: unknown) => { log.push({ action: event }); },
      onCalloutDismiss: (event: unknown) => { log.push({ dismiss: event }); },
      ...options,
    });
    document.querySelector("[data-agentic-chat]")!.addEventListener("agentic-chat:callout-action", (event) => log.push({ domAction: (event as CustomEvent).detail }));
    document.querySelector("[data-agentic-chat]")!.addEventListener("agentic-chat:callout-dismiss", (event) => log.push({ domDismiss: (event as CustomEvent).detail }));
  }, options);
  await page.waitForTimeout(100);
  return page;
}

/** Shows a card and waits out its 160ms entrance, which moves it a few pixels while it plays. */
async function show(page: Page, card: Record<string, unknown> = CARD): Promise<void> {
  await page.evaluate((card) => (window as unknown as { widget: { showCallout(card: unknown): void } }).widget.showCallout(card), card);
  await page.waitForTimeout(250);
}
const call = (page: Page, source: string) => page.evaluate(`(() => { const widget = window.widget; return ${source}; })()`);

/** Boxes of the card, the launcher and the panel, and whether the card is displayed. */
function boxes(page: Page) {
  return page.evaluate(() => {
    const scope = document.querySelector("[data-agentic-chat]")!.shadowRoot!;
    const box = (selector: string) => {
      const element = scope.querySelector(selector) as HTMLElement | null;
      if (!element || element.hidden) return null;
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };
    const card = scope.querySelector(".acw-callout") as HTMLElement | null;
    return { card: box(".acw-callout"), launcher: box(".acw-launcher"), panel: box(".acw-panel"), tail: card?.dataset.tail, shown: !!card && !card.hidden };
  });
}

const near = (actual: number | undefined, expected: number, message: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= 1, `${message}: ${actual} is not ${expected}`);

test("closed with a launcher: right edges line up, 12px above it, tail down at its centre", async () => {
  const page = await open();
  try {
    await show(page);
    const at = await boxes(page);
    assert.ok(at.card && at.launcher);
    near(at.card.right, at.launcher.right, "right edge");
    near(at.card.bottom, at.launcher.top - 12, "gap above the launcher");
    assert.equal(at.tail, "down");
    const tailX = await page.evaluate(() => {
      const scope = document.querySelector("[data-agentic-chat]")!.shadowRoot!;
      const rect = (scope.querySelector(".acw-callout-tail") as HTMLElement).getBoundingClientRect();
      return (rect.left + rect.right) / 2;
    });
    near(tailX, (at.launcher.left + at.launcher.right) / 2, "tail at the launcher's centre");
    assert.equal(await page.evaluate(() => document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout")!.getAttribute("role")), "region");
  } finally { await page.close(); }
});

test("closed, launcher dragged to the top: the card goes below it with the tail up", async () => {
  const page = await open();
  try {
    const launcher = (await boxes(page)).launcher!;
    const x = (launcher.left + launcher.right) / 2, y = (launcher.top + launcher.bottom) / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, 60, { steps: 5 });
    await page.mouse.up();
    // Off the launcher, whose hover lift would otherwise move it by 2px under the measurement.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    await show(page);
    const at = await boxes(page);
    assert.ok(at.card && at.launcher);
    near(at.card.top, at.launcher.bottom + 12, "gap below the launcher");
    assert.equal(at.tail, "up");
    // The card follows the launcher when it is dragged again while the card shows.
    await page.mouse.move(at.launcher.left + 29, at.launcher.top + 29);
    await page.mouse.down();
    await page.mouse.move(at.launcher.left + 29 - 200, at.launcher.top + 29 + 20, { steps: 5 });
    await page.mouse.up();
    const moved = await boxes(page);
    near(moved.card!.right, moved.launcher!.right, "right edge after the second drag");
  } finally { await page.close(); }
});

test("closed with no launcher: 16px from the right and bottom, no tail", async () => {
  const page = await open({ showLauncher: false });
  try {
    await show(page);
    const at = await boxes(page);
    assert.ok(at.card);
    near(at.card.right, 1600 - 16, "right");
    near(at.card.bottom, 900 - 16, "bottom");
    assert.equal(at.tail, "none");
  } finally { await page.close(); }
});

test("docked push: beside the page's corner next to the panel, 16px from it and 40px from the bottom", async () => {
  const page = await open({ mode: "docked", startOpen: true });
  try {
    await show(page);
    await page.waitForTimeout(300);
    const at = await boxes(page);
    assert.ok(at.card && at.panel);
    near(at.card.right, at.panel.left - 16, "right edge 16px left of the panel");
    near(at.card.bottom, 900 - 40, "40px from the bottom");
    assert.equal(at.tail, "none");
  } finally { await page.close(); }
});

test("docked overlay (a window too narrow to push): 40px from the bottom although the panel runs to it", async () => {
  const page = await open({ mode: "docked", startOpen: true, dockedPageMinWidth: 1200 }, { width: 1440, height: 900 });
  try {
    await show(page);
    await page.waitForTimeout(300);
    const at = await boxes(page);
    assert.ok(at.card && at.panel);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).marginRight), "0px", "overlay: the page is not pushed");
    near(at.panel.bottom, 900, "the panel runs to the bottom");
    near(at.card.bottom, 900 - 40, "40px from the bottom");
    near(at.card.right, at.panel.left - 16, "16px left of the panel");
  } finally { await page.close(); }
});

for (const [name, options] of [["docked overlay layout", { mode: "docked", dockLayout: "overlay" }], ["floating", { mode: "floating" }]] as const) {
  test(`${name}: left of the panel with the bottoms aligned`, async () => {
    const page = await open({ ...options, startOpen: true });
    try {
      await show(page);
      await page.waitForTimeout(300);
      const at = await boxes(page);
      assert.ok(at.card && at.panel);
      near(at.card.right, at.panel.left - 16, "right edge 16px left of the panel");
      if (options.mode === "docked") near(at.card.bottom, 900 - 40, "docked: 40px from the bottom");
      else near(at.card.bottom, at.panel.bottom, "bottoms aligned");
    } finally { await page.close(); }
  });
}

test("a window with no room beside the open panel hides the card, and closing the panel brings it back", async () => {
  const page = await open({ mode: "floating" }, { width: 700, height: 900 });
  try {
    await show(page);
    assert.equal((await boxes(page)).shown, true, "above the launcher while closed");
    await call(page, "widget.open()");
    await page.waitForTimeout(300);
    assert.equal((await boxes(page)).shown, false, "panel.left is under card width + 32");
    assert.equal(await call(page, "widget.getCalloutId()"), "summary", "hidden for lack of room is not hideCallout");
    await call(page, "widget.close()");
    assert.equal((await boxes(page)).shown, true);
    // Growing the window makes room while the panel is open.
    await call(page, "widget.open()");
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(100);
    assert.equal((await boxes(page)).shown, true);
  } finally { await page.close(); }
});

test("compact status hides the card until compact ends", async () => {
  const page = await open({ mode: "floating", startOpen: true });
  try {
    await show(page);
    await call(page, "widget.setCompactMode(true)");
    assert.equal((await boxes(page)).shown, false);
    await call(page, "widget.setCompactMode(false)");
    await page.waitForTimeout(300);
    assert.equal((await boxes(page)).shown, true);
  } finally { await page.close(); }
});

test("the same id updates in place and keeps the node; another id replaces it", async () => {
  const page = await open();
  try {
    await show(page);
    await page.evaluate(() => { (window as unknown as { node: Element }).node = document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout")!; });
    await show(page, { ...CARD, title: "Mới", markdown: "- **hai**" });
    const same = await page.evaluate(() => {
      const node = document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout")!;
      return { kept: node === (window as unknown as { node: Element }).node, title: node.querySelector(".acw-callout-title")!.textContent, label: node.getAttribute("aria-label"), strong: node.querySelectorAll("strong").length };
    });
    assert.deepEqual(same, { kept: true, title: "Mới", label: "Mới", strong: 1 });
    await show(page, { ...CARD, id: "other" });
    const other = await page.evaluate(() => ({
      kept: document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout") === (window as unknown as { node: Element }).node,
      count: document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelectorAll(".acw-callout").length,
    }));
    assert.deepEqual(other, { kept: false, count: 1 });
    assert.equal(await call(page, "widget.getCalloutId()"), "other");
  } finally { await page.close(); }
});

test("an action runs onCalloutAction inside the click, then raises the DOM event", async () => {
  const page = await open();
  try {
    await show(page);
    const result = await page.evaluate(() => {
      const button = document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout-action") as HTMLButtonElement;
      const log = (window as unknown as { __log: unknown[] }).__log;
      button.click();
      // `click()` returns after its handlers ran: whatever is logged by now ran synchronously.
      return JSON.parse(JSON.stringify(log));
    });
    assert.deepEqual(result, [{ action: { id: "summary", actionId: "go" } }, { domAction: { id: "summary", actionId: "go" } }]);
    assert.equal(await call(page, "widget.getCalloutId()"), "summary", "the host decides whether the card stays");
  } finally { await page.close(); }
});

test("the close button hides the card and calls onCalloutDismiss", async () => {
  const page = await open();
  try {
    await show(page);
    const label = await page.evaluate(() => document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout-close")!.getAttribute("aria-label"));
    assert.equal(label, "Đóng");
    await page.evaluate(() => (document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout-close") as HTMLButtonElement).click());
    assert.equal(await call(page, "widget.getCalloutId()"), undefined);
    assert.equal((await boxes(page)).card, null);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __log: unknown[] }).__log), [{ dismiss: { id: "summary" } }, { domDismiss: { id: "summary" } }]);
    // dismissible: false has no close button.
    await show(page, { ...CARD, dismissible: false });
    assert.equal(await page.evaluate(() => document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-callout-close")), null);
  } finally { await page.close(); }
});

test("hideCallout removes the card; an id that is not shown changes nothing", async () => {
  const page = await open();
  try {
    await show(page);
    await call(page, `widget.hideCallout("other")`);
    assert.equal(await call(page, "widget.getCalloutId()"), "summary");
    await call(page, "widget.hideCallout()");
    assert.equal(await call(page, "widget.getCalloutId()"), undefined);
    assert.equal((await boxes(page)).card, null);
    await show(page);
    await call(page, `widget.hideCallout("summary")`);
    assert.equal(await call(page, "widget.getCalloutId()"), undefined);
    await show(page);
    await call(page, "widget.destroy()");
    assert.equal(await page.evaluate(() => document.querySelector("[data-agentic-chat]")), null);
  } finally { await page.close(); }
});

test("an in-place update keeps keyboard focus: the same action, else the primary one, else the close button", async () => {
  const page = await open();
  const focused = () => page.evaluate(() => {
    const active = document.querySelector("[data-agentic-chat]")!.shadowRoot!.activeElement as HTMLElement | null;
    return active ? (active.dataset.actionId ?? active.className) : null;
  });
  const focus = (selector: string) => page.evaluate((selector) => (document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(selector) as HTMLElement).focus(), selector);
  const two = { ...CARD, actions: [{ id: "later", label: "Sau" }, { id: "go", label: "Đi", primary: true }] };
  try {
    await show(page, two);
    await focus(`[data-action-id="later"]`);
    await show(page, { ...two, markdown: "- **mới**" });
    assert.equal(await focused(), "later", "same actions: the same button");
    await show(page, { ...CARD, actions: [{ id: "x", label: "X" }, { id: "y", label: "Y", primary: true }] });
    assert.equal(await focused(), "y", "action gone: the primary one");
    await show(page, { ...CARD, actions: [] });
    assert.equal(await focused(), "acw-callout-close", "no actions left: the close button");
    await show(page, two);
    await focus(".acw-callout-close");
    await show(page, { ...two, markdown: "- **lại**" });
    assert.equal(await focused(), "acw-callout-close", "the close button keeps focus, not the primary action");
    await show(page, { ...two, actions: [{ id: "z", label: "Z", primary: true }] });
    assert.equal(await focused(), "acw-callout-close", "also when the actions change");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await show(page, { ...two, title: "Khác" });
    assert.equal(await focused(), null, "focus elsewhere is not pulled into the card");
  } finally { await page.close(); }
});
