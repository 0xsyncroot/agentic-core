import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * The panel's layout in a real browser: the stub DOM has no layout, no hit-testing and no
 * MutationObserver, so what the panel's width, its header's ellipsis and the docked strip depend on
 * is only proven here.
 */

const LONG_SUBTITLE = "Agent đồng hành kế toán lương: tính lương, phụ cấp, kiểm tra sai lệch, tiết kiệm thời gian";

let browser: Browser;
/** Draws the page's classic scrollbar, which headless Chromium otherwise hides. */
let scrolling: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  scrolling = await chromium.launch({ args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] });
});
after(async () => { await browser?.close(); await scrolling?.close(); });

async function open(options: Record<string, unknown>, width = 1600, head = "", on = browser): Promise<Page> {
  const page = await on.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html lang="vi"><head>${head}</head><body style="margin:0"><main id="app" style="height:100vh">app</main></body></html>`);
  // tsx wraps named functions in `__name(...)`; the functions handed to page.evaluate run in the
  // browser, where that helper does not exist.
  await page.evaluate("window.__name = (target) => target;");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => {
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): unknown } }).AgentChat;
    (window as unknown as { widget: unknown }).widget = api.create({
      persistSession: false, storageKey: `layout-${Math.random()}`, startOpen: true, agentName: "Example Assistant",
      transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
      ...options,
    });
  }, options);
  await page.waitForTimeout(400);
  return page;
}

/** Left and right edges of the widget's parts, wherever its host puts them (shadow root or not). */
function edges(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector("[data-agentic-chat]")!;
    const scope: ParentNode = host.shadowRoot ?? document;
    const box = (selector: string) => {
      const element = scope.querySelector(selector) as HTMLElement | null;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, clipped: element.scrollWidth > element.clientWidth };
    };
    return {
      panel: box(".acw-panel")!, header: box(".acw-header")!, subtitle: box(".acw-subtitle")!, close: box(".acw-close")!,
      conversation: box(".acw-conversation")!, footer: box(".acw-footer")!,
    };
  });
}

for (const mode of ["docked", "floating"] as const) {
  test(`${mode}: a long subtitle ends in an ellipsis inside the panel, and every row keeps the panel's width`, async () => {
    const page = await open({ mode, subtitle: LONG_SUBTITLE });
    try {
      const at = await edges(page);
      for (const part of ["header", "conversation", "footer"] as const) {
        assert.ok(at[part].right <= at.panel.right + 0.5, `${part} ends at ${at[part].right}, past the panel's ${at.panel.right}`);
      }
      assert.ok(at.close.right <= at.panel.right, "the close button stays inside the panel");
      assert.ok(at.subtitle.right <= at.close.left, "the subtitle stops before the header's buttons");
      assert.equal(at.subtitle.clipped, true, "the subtitle is cut, which the stylesheet ends with an ellipsis");
    } finally { await page.close(); }
  });
}

test("docked: a full-screen popup opened after docking stops at the panel's edge, and gets its width back when the panel closes", async () => {
  const page = await open({ mode: "docked", dockedPageMinWidth: 800 });
  try {
    const margin = await page.evaluate(() => getComputedStyle(document.body).marginRight);
    assert.equal(margin, "410px");
    // A popup like Agentic's: fixed, inset 0, its own layer, added after the panel docked.
    await page.evaluate(() => {
      const popup = document.createElement("div");
      popup.id = "popup";
      popup.style.cssText = "position: fixed; inset: 0; z-index: 9999; background: #fff;";
      popup.innerHTML = `<button id="close-popup" style="position:absolute; top:8px; right:8px">X</button>`;
      document.body.append(popup);
    });
    await page.waitForTimeout(100);
    const yielded = await page.evaluate(() => ({
      right: document.getElementById("popup")!.getBoundingClientRect().right,
      close: document.getElementById("close-popup")!.getBoundingClientRect().right,
    }));
    assert.equal(yielded.right, 1600 - 410, "the popup gives up the panel's strip, as the body does");
    assert.ok(yielded.close <= 1600 - 410, "its close button is beside the panel, not under it");
    // A control pinned to the screen's edge is not the page's layer to move.
    const edge = await page.evaluate(async () => {
      const drawer = document.createElement("div");
      drawer.style.cssText = "position: fixed; top: 300px; right: 0; width: 56px; height: 200px; z-index: 10001;";
      document.body.append(drawer);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return drawer.getBoundingClientRect().right;
    });
    assert.equal(edge, 1600, "the edge drawer stays on the screen's edge");
    await page.evaluate(() => (window as unknown as { widget: { close(): void } }).widget.close());
    await page.waitForTimeout(100);
    const restored = await page.evaluate(() => ({
      right: document.getElementById("popup")!.getBoundingClientRect().right,
      style: document.getElementById("popup")!.style.cssText,
    }));
    assert.equal(restored.right, 1600, "closing the panel hands the popup its whole width back");
    assert.doesNotMatch(restored.style, /max-width/, "and leaves none of the panel's values on it");
  } finally { await page.close(); }
});

test("docked: a body the page sizes to the window (a host application's `body, html { width: 100% }`) still gives up the panel's strip", async () => {
  // Agentic's shared stylesheet on a host application; the app is a flex column filling the body.
  const head = `<style>body, html { width: 100%; } body { display: flex; box-sizing: border-box; overflow: hidden; } #app { flex: 1; min-width: 0; }</style>`;
  const page = await open({ mode: "docked", dockedPageMinWidth: 800 }, 1600, head);
  try {
    const docked = await page.evaluate(() => document.getElementById("app")!.getBoundingClientRect().right);
    assert.equal(docked, 1600 - 410, "the app ends where the panel begins");
    await page.evaluate(() => (window as unknown as { widget: { close(): void } }).widget.close());
    await page.waitForTimeout(100);
    const restored = await page.evaluate(() => ({ right: document.getElementById("app")!.getBoundingClientRect().right, style: document.body.style.cssText }));
    assert.equal(restored.right, 1600, "closing the panel hands the app its whole width back");
    assert.doesNotMatch(restored.style, /max-width|margin-right/, "and leaves none of the panel's values on the body");
  } finally { await page.close(); }
});

test("docked: the host's listed controls go under the panel, its edge drawer stays over it, and both get their layers back", async () => {
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, dockedCovers: [".guide", "::not-a-selector"] });
  try {
    // Agentic's onboarding button (z 9999, bottom-right) and its edge drawer (z 10001), added after the panel docked.
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `
        <div class="guide" style="position: fixed; right: 16px; bottom: 16px; width: 272px; height: 32px; z-index: 9999;">Hướng dẫn</div>
        <div class="drawer" style="position: fixed; right: 0; top: 400px; width: 56px; height: 172px; z-index: 10001;"></div>`);
    });
    await page.waitForTimeout(100);
    const top = (selector: string) => page.evaluate((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit?.closest("[data-agentic-chat]") ? "panel" : hit?.className;
    }, selector);
    assert.equal(await top(".guide"), "panel", "the chat lies over the onboarding button");
    assert.equal(await top(".drawer"), "drawer", "the edge drawer stays over the chat");
    // A page that rewrites the button's style (a re-render) does not bring it back over the chat.
    await page.evaluate(() => { (document.querySelector(".guide") as HTMLElement).style.cssText = "position: fixed; right: 16px; bottom: 16px; width: 272px; height: 32px; z-index: 9999;"; });
    await page.waitForTimeout(100);
    assert.equal(await top(".guide"), "panel", "a re-rendered button goes under again");
    await page.evaluate(() => (window as unknown as { widget: { close(): void } }).widget.close());
    await page.waitForTimeout(100);
    const layer = await page.evaluate(() => (document.querySelector(".guide") as HTMLElement).style.zIndex);
    assert.equal(layer, "9999", "closing the panel gives the button its own layer back");
  } finally { await page.close(); }
});

test("docked: a host callout placed against the strip moves to the page's bottom corner beside the panel, and back when it closes", async () => {
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, dockedMoves: [".callout"] });
  try {
    // Agentic's "Tóm tắt bảng lương": fixed, top layer, placed by its own script against Example Assistant's icon at the screen's edge.
    const placed = "left: 1200px; top: 268px; visibility: visible;";
    await page.evaluate((placed) => {
      document.body.insertAdjacentHTML("beforeend", `<section class="callout" style="${placed}">Tóm tắt</section>`);
      const style = document.createElement("style");
      style.textContent = ".callout { position: fixed; width: 388px; height: 212px; z-index: 2147483001; }";
      document.head.append(style);
    }, placed);
    await page.waitForTimeout(100);
    const box = () => page.evaluate(() => { const r = document.querySelector(".callout")!.getBoundingClientRect(); return { right: r.right, bottom: r.bottom, left: r.left }; });
    assert.deepEqual(await box(), { right: 1600 - 410 - 16, bottom: 900 - 40, left: 1600 - 410 - 16 - 388 }, "beside the panel, in the page's bottom corner");
    // Agentic's callout places itself again whenever its style changes; inline values set against it were
    // rewritten in every frame. The panel's rules leave its style alone: nothing to answer, nothing rewritten.
    const rewrites = await page.evaluate(async (placed) => {
      const callout = document.querySelector(".callout") as HTMLElement;
      let count = 0;
      new MutationObserver(() => { count++; if (callout.getAttribute("style") !== placed) callout.setAttribute("style", placed); })
        .observe(callout, { attributes: true, attributeFilter: ["style"] });
      callout.setAttribute("style", placed);
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return count;
    }, placed);
    assert.ok(rewrites <= 1, `the host's placement and the panel's do not fight (${rewrites} rewrites)`);
    assert.equal((await box()).right, 1600 - 410 - 16, "a placement the host writes again does not put it over the chat");
    await page.evaluate(() => (window as unknown as { widget: { close(): void } }).widget.close());
    await page.waitForTimeout(100);
    const style = await page.evaluate(() => (document.querySelector(".callout") as HTMLElement).style.cssText);
    assert.equal((await box()).left, 1200, "closing the panel gives the callout the host's placement back");
    assert.doesNotMatch(style, /bottom|right|important/, "and leaves none of the panel's values on it");
  } finally { await page.close(); }
});

/**
 * A host card the host names in `dockedMoves`, placed the way Agentic's "Tóm tắt bảng lương" places itself: fixed,
 * the top layer, inline offsets against Example Assistant's icon in the app's edge drawer (right 12px, its own bottom).
 */
const HOST_PLACED = "right: 12px; bottom: 400px; visibility: visible;";
async function hostCard(page: Page): Promise<void> {
  await page.evaluate((placed) => {
    document.body.insertAdjacentHTML("beforeend", `<section class="callout" style="${placed}">Tóm tắt</section>`);
    const style = document.createElement("style");
    style.textContent = ".callout { position: fixed; width: 388px; height: 212px; z-index: 2147483001; }";
    document.head.append(style);
  }, HOST_PLACED);
  await page.waitForTimeout(50);
}
const boxOf = (page: Page, which: "card" | "panel" | "ours") => page.evaluate((which) => {
  const scope = document.querySelector("[data-agentic-chat]")!.shadowRoot!;
  const element = which === "card" ? document.querySelector(".callout") : scope.querySelector(which === "panel" ? ".acw-panel" : ".acw-callout");
  if (!element || (element as HTMLElement).hidden) return null;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}, which);
const widgetCall = (page: Page, source: string) => page.evaluate(`(() => { const widget = window.widget; return ${source}; })()`);

test("docked over the page (a window too narrow to push): the host card moves beside the panel, follows its edge, and goes back when it closes", async () => {
  // 1000 - 340 (the panel at its narrowest) = 660px, under the page's 800: the panel lies over the page.
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, dockedMoves: [".callout"], dockedCovers: [".guide"] }, 1000);
  try {
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).marginRight), "0px", "over the page, the body keeps its width");
    await hostCard(page);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
      `<div class="guide" style="position: fixed; right: 16px; bottom: 16px; width: 272px; height: 32px; z-index: 9999;">Hướng dẫn</div>`));
    await page.waitForTimeout(50);
    const panel = (await boxOf(page, "panel"))!;
    assert.equal(panel.left, 1000 - 410, "the panel runs from the window's right edge");
    assert.deepEqual(await boxOf(page, "card"), { left: 1000 - 410 - 16 - 388, top: 900 - 40 - 212, right: 1000 - 410 - 16, bottom: 900 - 40 },
      "beside the panel on the page's side, in the page's bottom corner, as the widget's own card stands");
    // Over the page the panel keeps the widget's top layer: the host's covered button is already under it and keeps its own layer.
    const guide = await page.evaluate(() => {
      const element = document.querySelector(".guide")!;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { panel: Boolean(hit?.closest("[data-agentic-chat]")), layer: getComputedStyle(element).zIndex };
    });
    assert.deepEqual(guide, { panel: true, layer: "9999" }, "the chat lies over the button, and the button keeps its layer under the page's menus");
    // The panel's edge moved outward by the keyboard: the card moves with it.
    await page.evaluate(() => {
      const handle = document.querySelector("[data-agentic-chat]")!.shadowRoot!.querySelector(".acw-resize-handle")!;
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await page.waitForTimeout(50);
    assert.equal((await boxOf(page, "card"))!.right, 1000 - 426 - 16, "a wider panel takes the card along");
    await widgetCall(page, "widget.close()");
    await page.waitForTimeout(50);
    assert.deepEqual(await boxOf(page, "card"), { left: 1000 - 12 - 388, top: 900 - 400 - 212, right: 1000 - 12, bottom: 900 - 400 }, "closed, the card is where the host put it");
    assert.equal(await page.evaluate(() => (document.querySelector(".callout") as HTMLElement).style.cssText), HOST_PLACED.trim(), "and carries none of the panel's values");
  } finally { await page.close(); }
});

test("floating: the host card stands beside the panel, aligned with its bottom, through a window resize and a switch to docked and back", async () => {
  const page = await open({ mode: "floating", dockedPageMinWidth: 800, dockedMoves: [".callout"] }, 1600);
  try {
    await hostCard(page);
    // The floating panel: 410px wide, 18px from the window's right and bottom edges.
    assert.deepEqual(await boxOf(page, "card"), { left: 1600 - 18 - 410 - 16 - 388, top: 900 - 18 - 212, right: 1600 - 18 - 410 - 16, bottom: 900 - 18 });
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.waitForTimeout(100);
    assert.deepEqual(await boxOf(page, "card"), { left: 1400 - 18 - 410 - 16 - 388, top: 800 - 18 - 212, right: 1400 - 18 - 410 - 16, bottom: 800 - 18 }, "a resized window re-places it");
    await widgetCall(page, "widget.setMode('docked')");
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).marginRight), "410px", "docked at 1400px, the panel pushes the page");
    assert.deepEqual(await boxOf(page, "card"), { left: 1400 - 410 - 16 - 388, top: 800 - 40 - 212, right: 1400 - 410 - 16, bottom: 800 - 40 }, "pushed, the page's bottom corner");
    await widgetCall(page, "widget.setMode('floating')");
    await page.waitForTimeout(400);
    assert.equal((await boxOf(page, "card"))!.right, 1400 - 18 - 410 - 16, "floating again, beside the floating panel");
    await widgetCall(page, "widget.close()");
    await page.waitForTimeout(50);
    assert.equal((await boxOf(page, "card"))!.right, 1400 - 12, "closed, back where the host put it");
    await widgetCall(page, "widget.open()");
    await page.waitForTimeout(400);
    assert.equal((await boxOf(page, "card"))!.right, 1400 - 18 - 410 - 16, "opened again, beside the panel again");
  } finally { await page.close(); }
});

test("a panel on the left takes the host card to its right; a compact panel leaves the card where the host put it", async () => {
  const page = await open({ mode: "docked", position: "left", dockedPageMinWidth: 800, dockedMoves: [".callout"] }, 1000);
  try {
    await hostCard(page);
    assert.deepEqual(await boxOf(page, "card"), { left: 410 + 16, top: 900 - 40 - 212, right: 410 + 16 + 388, bottom: 900 - 40 }, "beside the panel, on the page's side");
    await widgetCall(page, "widget.setCompactMode(true)");
    await page.waitForTimeout(50);
    assert.equal(await boxOf(page, "panel"), null, "the panel stepped aside");
    assert.equal((await boxOf(page, "card"))!.right, 1000 - 12, "nothing stands beside a compact panel: the card is the host's again");
    await widgetCall(page, "widget.setCompactMode(false)");
    await page.waitForTimeout(400);
    assert.equal((await boxOf(page, "card"))!.left, 410 + 16, "back beside the panel when it returns");
  } finally { await page.close(); }
});

test("the widget's own card and a moved host card both shown beside the panel: the host's stands on the widget's, never over it", async () => {
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, dockedMoves: [".callout"] }, 1600);
  try {
    await hostCard(page);
    await widgetCall(page, "widget.showCallout({ id: 'summary', title: 'Tóm tắt', markdown: '- Dòng **một**\\n- Dòng hai' })");
    await page.waitForTimeout(250);
    const ours = (await boxOf(page, "ours"))!;
    const card = (await boxOf(page, "card"))!;
    assert.equal(ours.bottom, 900 - 40, "the widget's card keeps the page's bottom corner");
    assert.equal(card.right, ours.right, "both line up on the panel's side");
    // 16px above, give or take the subpixel the card's whole-pixel height leaves out.
    assert.ok(card.bottom < ours.top && Math.abs(ours.top - card.bottom - 16) <= 1, `the host's card stands 16px above the widget's (${card.bottom} under ${ours.top})`);
    await widgetCall(page, "widget.hideCallout()");
    await page.waitForTimeout(50);
    assert.equal((await boxOf(page, "card"))!.bottom, 900 - 40, "the widget's card gone, the host's takes the corner");
  } finally { await page.close(); }
});

test("a page with a classic scrollbar: the widget's card and the host card keep 16px from the panel, pushed and over the page", async () => {
  // The scrollbar takes 15px of the window; fixed offsets are measured from its inner edge.
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, dockedMoves: [".callout"] }, 1600, "<style>html { overflow-y: scroll; }</style>", scrolling);
  try {
    assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 15, "the page shows a classic scrollbar");
    await hostCard(page);
    await widgetCall(page, "widget.showCallout({ id: 'summary', title: 'Tóm tắt', markdown: '- Dòng **một**\\n- Dòng hai' })");
    await page.waitForTimeout(250);
    const gaps = async () => {
      const panel = (await boxOf(page, "panel"))!;
      return { ours: panel.left - (await boxOf(page, "ours"))!.right, card: panel.left - (await boxOf(page, "card"))!.right };
    };
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).marginRight), "410px", "1585px pushes the page");
    assert.deepEqual(await gaps(), { ours: 16, card: 16 }, "pushed, both cards 16px from the panel");
    await page.setViewportSize({ width: 1000, height: 900 });
    // Over the page the panel slides in again (180ms); its box is final when that ends.
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).marginRight), "0px", "985px puts the panel over the page");
    assert.deepEqual(await gaps(), { ours: 16, card: 16 }, "over the page, both cards 16px from the panel");
  } finally { await page.close(); }
});

test("a window narrower than the host card beside the panel keeps the card inside the window, narrowed, and never over the panel", async () => {
  // 760px: the panel lies over the page from 350px; 350 - 2 × 16 = 318px is left for a 388px card.
  const page = await open({ mode: "docked", dockedPageMinWidth: 800, dockedMoves: [".callout"] }, 760);
  try {
    await hostCard(page);
    assert.deepEqual(await boxOf(page, "card"), { left: 16, top: 900 - 40 - 212, right: 760 - 410 - 16, bottom: 900 - 40 }, "docked over the page");
    await widgetCall(page, "widget.setMode('floating')");
    await page.waitForTimeout(400);
    const panel = (await boxOf(page, "panel"))!;
    assert.deepEqual(await boxOf(page, "card"), { left: 16, top: 900 - 18 - 212, right: panel.left - 16, bottom: 900 - 18 }, "floating");
  } finally { await page.close(); }
});
