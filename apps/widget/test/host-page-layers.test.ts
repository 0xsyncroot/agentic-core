import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Pointer input on the widget is not pointer input to the host page, in a real browser.
 *
 * Host apps close their transient layers (row menus, dropdowns, popovers) from a bubble-phase listener on `document`
 * when a press lands outside the layer. A press inside the widget's shadow root must not reach that listener: a layer
 * an approved press is about to use stays open while the user answers the card in the chat.
 */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

/** A page with one menu per closer event, each closed by a press outside it, and one widget docked on the right. */
async function open(touch = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: touch });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html><body style="margin:0"><main style="width:500px">
    <div id="menu-mousedown">menu</div><div id="menu-pointerdown">menu</div><div id="menu-click">menu</div>
    <p id="page-text">page</p></main></body></html>`);
  await page.evaluate(() => {
    const scope = window as unknown as { __name: (target: unknown) => unknown; seen: string[] };
    scope.__name = (target) => target;
    scope.seen = [];
    for (const type of ["mousedown", "pointerdown", "click"]) {
      const menu = document.getElementById(`menu-${type}`)!;
      menu.dataset.open = "true";
      document.addEventListener(type, (event) => { if (!menu.contains(event.target as Node)) menu.dataset.open = "false"; });
    }
    for (const type of ["agentic-chat:open", "agentic-chat:message", "dblclick", "contextmenu", "auxclick", "touchstart", "touchend"]) {
      document.addEventListener(type, () => scope.seen.push(type));
    }
    window.addEventListener("keydown", (event) => { if (event.ctrlKey && event.altKey) scope.seen.push(`keydown:${event.code}`); });
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): { send(text: string): Promise<void> } } }).AgentChat;
    const widget = api.create({
      persistSession: false, storageKey: `layers-${Math.random()}`, agentName: "Agent", startOpen: true,
      transport: {
        checkConnection: () => ({ status: "ok" }), loadHistory: () => [], loadSessions: () => ({ sessions: [] }),
        send: async () => ({ content: "Xong." }),
      },
    });
    return widget.send("chào");
  });
  await page.locator("[data-agentic-chat] >> css=textarea").waitFor();
  return page;
}

const openMenus = (page: Page) => page.evaluate(() =>
  ["mousedown", "pointerdown", "click"].filter((type) => document.getElementById(`menu-${type}`)!.dataset.open === "true"));
const reopen = (page: Page) => page.evaluate(() => {
  for (const type of ["mousedown", "pointerdown", "click"]) document.getElementById(`menu-${type}`)!.dataset.open = "true";
});
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
const hidden = (page: Page, selector: string) => page.evaluate((css) =>
  document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector<HTMLElement>(css)!.hidden, selector);

test("a press inside the widget leaves every page menu open, whichever event the page closes it on", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=textarea").click();
  assert.deepEqual(await openMenus(page), ["mousedown", "pointerdown", "click"], "clicking the chat box closes nothing on the page");
  await page.locator("[data-agentic-chat] >> css=textarea").dblclick();
  await page.locator("[data-agentic-chat] >> css=textarea").click({ button: "right" });
  assert.deepEqual(await openMenus(page), ["mousedown", "pointerdown", "click"], "nor a double or a right click");
  assert.deepEqual((await seen(page)).filter((type) => !type.startsWith("agentic-chat:")), [], "no press event of the widget reached the page");
  await page.close();
});

test("a press on the page still closes the page's menus", async () => {
  const page = await open();
  await page.locator("#page-text").click();
  assert.deepEqual(await openMenus(page), [], "the page's own outside-press rule is untouched");
  await page.close();
});

test("the widget's own surfaces still react to presses inside it", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=.acw-more").click();
  assert.equal(await hidden(page, ".acw-header-menu"), false, "the header menu opens");
  await page.locator("[data-agentic-chat] >> css=textarea").click();
  assert.equal(await hidden(page, ".acw-header-menu"), true, "and closes on a press elsewhere in the widget");
  await reopen(page);
  assert.deepEqual(await openMenus(page), ["mousedown", "pointerdown", "click"]);
  await page.close();
});

test("the widget's events and keys still reach the page", async () => {
  const page = await open();
  await page.locator("[data-agentic-chat] >> css=textarea").fill("thêm");
  await page.locator("[data-agentic-chat] >> css=textarea").press("Enter");
  await page.locator("[data-agentic-chat] >> css=textarea").press("Control+Alt+KeyQ");
  const events = await seen(page);
  assert.ok(events.includes("agentic-chat:message"), "the public events the widget dispatches on its host still bubble");
  assert.ok(events.includes("keydown:KeyQ"), "keys pressed in the chat box still reach the window");
  await page.close();
});

test("a drag the page began still ends when the button is let go over the widget", async () => {
  const page = await open();
  await page.evaluate(() => {
    const scope = window as unknown as { releases: string[] };
    scope.releases = [];
    for (const type of ["mouseup", "pointerup"]) document.addEventListener(type, () => scope.releases.push(type));
  });
  const input = await page.locator("[data-agentic-chat] >> css=textarea").boundingBox();
  const text = await page.locator("#page-text").boundingBox();
  await page.mouse.move(text!.x + 5, text!.y + 5);
  await page.mouse.down();
  await page.mouse.move(input!.x + 20, input!.y + 10, { steps: 10 });
  await page.mouse.up();
  assert.deepEqual((await page.evaluate(() => (window as unknown as { releases: string[] }).releases)).sort(), ["mouseup", "pointerup"],
    "the page hears the release of the press it saw");
  await page.mouse.down();
  await page.mouse.up();
  assert.equal((await page.evaluate(() => (window as unknown as { releases: string[] }).releases)).length, 2,
    "a press and release both inside the widget stay the widget's");
  await page.close();
});

test("a tap inside the widget leaves the page menus open and sends no touch to the page", async () => {
  const page = await open(true);
  await page.locator("[data-agentic-chat] >> css=textarea").tap();
  assert.deepEqual(await openMenus(page), ["mousedown", "pointerdown", "click"]);
  assert.deepEqual((await seen(page)).filter((type) => type.startsWith("touch")), [], "touchstart and touchend stay the widget's");
  await page.locator("#page-text").tap();
  assert.deepEqual(await openMenus(page), [], "a tap on the page still closes them");
  await page.close();
});
