import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/** Host-declared toggles in the header "…" menu and the header badge, in a real browser. */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

const CONFIRM = { title: "Turn on?", message: "It will act without asking.", confirmLabel: "Turn on", cancelLabel: "Cancel" };

/** `reply` is what onMenuToggle resolves to: true, false, or "throw". */
async function open(reply: boolean | "throw", extra: Record<string, unknown> = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html><body style="margin:0"><main>app</main></body></html>`);
  await page.evaluate("window.__name = (target) => target; window.__log = [];");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(([reply, extra]) => {
    const log = (window as unknown as { __log: unknown[] }).__log;
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): unknown } }).AgentChat;
    (window as unknown as { widget: unknown }).widget = api.create({
      persistSession: false, storageKey: `menu-${Math.random()}`, agentName: "Agent", startOpen: true,
      transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
      menuToggles: [{ id: "full", label: "Full access", description: "No questions asked", checked: false, confirmOn: (extra as { confirm?: unknown }).confirm }],
      onMenuToggle: (event: unknown) => { log.push(event); if (reply === "throw") throw new Error("down"); return Promise.resolve(reply); },
    });
  }, [reply, extra] as const);
  await page.waitForTimeout(100);
  return page;
}

const root = (page: Page) => page.locator("[data-agentic-chat]");
const item = (page: Page) => page.locator("[data-agentic-chat] >> css=.acw-menu-toggle");
const openMenu = (page: Page) => page.locator("[data-agentic-chat] >> css=.acw-more").click();
const checked = (page: Page) => item(page).getAttribute("aria-checked");
const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: unknown[] }).__log);

test("renders a menuitemcheckbox with the label, description and aria-checked", async () => {
  const page = await open(true);
  await openMenu(page);
  assert.equal(await item(page).getAttribute("role"), "menuitemcheckbox");
  assert.equal(await checked(page), "false");
  assert.match(await item(page).innerText(), /Full access\s+No questions asked/u);
  assert.equal(await root(page).count(), 1);
  await page.close();
});

test("without confirmOn the click calls onMenuToggle and keeps the state", async () => {
  const page = await open(true);
  await openMenu(page);
  await item(page).click();
  await page.waitForTimeout(50);
  assert.equal(await checked(page), "true");
  assert.deepEqual((await log(page) as Array<{ id: string; checked: boolean }>).map(({ id, checked }) => [id, checked]), [["full", true]]);
  await page.close();
});

test("confirmOn asks first; cancel keeps it off and never calls the host", async () => {
  const page = await open(true, { confirm: CONFIRM });
  await openMenu(page);
  await item(page).click();
  assert.equal(await page.locator("[data-agentic-chat] >> css=.acw-menu-confirm").innerText().then((text) => text.includes("It will act without asking.")), true);
  assert.equal(await checked(page), "false");
  await page.locator("[data-agentic-chat] >> css=.acw-menu-confirm-cancel").click();
  assert.equal(await page.locator("[data-agentic-chat] >> css=.acw-menu-confirm").count(), 0);
  assert.equal(await checked(page), "false");
  assert.deepEqual(await log(page), []);
  await page.close();
});

test("confirming turns it on, and turning it off never asks", async () => {
  const page = await open(true, { confirm: CONFIRM });
  await openMenu(page);
  await item(page).click();
  await page.locator("[data-agentic-chat] >> css=.acw-menu-confirm-accept").click();
  await page.waitForTimeout(50);
  assert.equal(await checked(page), "true");
  await openMenu(page);
  await item(page).click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator("[data-agentic-chat] >> css=.acw-menu-confirm").count(), 0);
  assert.equal(await checked(page), "false");
  assert.equal((await log(page)).length, 2);
  await page.close();
});

for (const reply of [false, "throw"] as const) {
  test(`onMenuToggle ${reply === false ? "returning false" : "throwing"} puts the toggle back`, async () => {
    const page = await open(reply);
    await openMenu(page);
    await item(page).click();
    await page.waitForTimeout(80);
    assert.equal(await checked(page), "false");
    assert.equal((await log(page)).length, 1);
    await page.close();
  });
}

test("setMenuToggle sets state without calling the host; unknown ids are ignored; visible hides", async () => {
  const page = await open(true);
  await page.evaluate(() => (window as unknown as { widget: { setMenuToggle(id: string, s: unknown): void } }).widget.setMenuToggle("full", { checked: true }));
  assert.equal(await checked(page), "true");
  await page.evaluate(() => (window as unknown as { widget: { setMenuToggle(id: string, s: unknown): void } }).widget.setMenuToggle("nope", { checked: false }));
  assert.equal(await checked(page), "true");
  assert.deepEqual(await log(page), []);
  await page.evaluate(() => (window as unknown as { widget: { setMenuToggle(id: string, s: unknown): void } }).widget.setMenuToggle("full", { visible: false }));
  await openMenu(page);
  assert.equal(await item(page).isVisible(), false);
  await page.close();
});

test("setBadge shows a label and null removes it", async () => {
  const page = await open(true);
  const badge = page.locator("[data-agentic-chat] >> css=.acw-badge");
  assert.equal(await badge.isVisible(), false);
  await page.evaluate(() => (window as unknown as { widget: { setBadge(l: string | null, t?: string): void } }).widget.setBadge("Full", "Standing"));
  assert.equal(await badge.isVisible(), true);
  assert.equal(await badge.innerText(), "Full");
  assert.equal(await badge.getAttribute("title"), "Standing");
  await page.evaluate(() => (window as unknown as { widget: { setBadge(l: string | null): void } }).widget.setBadge(null));
  assert.equal(await badge.isVisible(), false);
  await page.close();
});
