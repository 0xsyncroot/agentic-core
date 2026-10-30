import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

/**
 * How an answer's code and rules are drawn, in a real browser, read back through the fonts the
 * browser actually used (CDP `CSS.getPlatformFontsForNode`), not the CSS that asked for them.
 *
 * Inline code holding a Vietnamese button name, `Phân bổ nguồn`, must not show "Phân bổ̉": a monospace
 * stack that falls to DejaVu Sans Mono on Linux has no "ổ" (U+1ED5), so the letter is drawn as o + two
 * combining marks and the hook slides off, though the text itself is NFC.
 * Inline code uses the answer's own font; a fenced block keeps a monospace stack that covers
 * Vietnamese before the generic one. A glyph count above the character count is that decomposition.
 */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

const LABEL = "Phân bổ nguồn";
const ANSWER = [`Bấm \`${LABEL}\` để tiếp.`, "", "---", "", "```", LABEL, "```"].join("\n");

async function open(): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html><body style="margin:0"><main>app</main></body></html>`);
  await page.evaluate("window.__name = (target) => target;");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((content) => {
    const api = (window as unknown as { AgentChat: { create(options: Record<string, unknown>): { send(text: string): Promise<void> } } }).AgentChat;
    return api.create({
      persistSession: false, storageKey: `fonts-${Math.random()}`, agentName: "Agent", startOpen: true,
      transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: async () => ({ content }) },
    }).send("Hướng dẫn");
  }, ANSWER);
  await page.locator("[data-agentic-chat] >> css=.acw-assistant .acw-markdown pre").waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  return { page, cdp };
}

/** The fonts the browser drew the direct text of the answer's `selector` with. */
async function fontsOf(cdp: CDPSession, selector: string): Promise<readonly { familyName: string; glyphCount: number }[]> {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector("[data-agentic-chat]").shadowRoot.querySelector(${JSON.stringify(`.acw-assistant .acw-markdown ${selector}`)})`,
  });
  assert.ok(result.objectId, `${selector} is in the answer`);
  const { nodeId } = await cdp.send("DOM.requestNode", { objectId: result.objectId });
  return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
}

test("inline code is drawn in the paragraph's own font, one glyph per Vietnamese letter", async () => {
  const { page, cdp } = await open();
  const paragraph = await fontsOf(cdp, "p");
  const code = await fontsOf(cdp, "p > code");
  assert.deepEqual(code.map((font) => font.familyName), [paragraph[0]?.familyName], `the label's font is the paragraph's (${JSON.stringify(code)})`);
  assert.equal(code[0]?.glyphCount, [...LABEL].length, "no letter is decomposed into a base and combining marks");
  await page.close();
});

test("a fenced block stays monospace in a font that has the Vietnamese letters", async () => {
  const { page, cdp } = await open();
  const block = await fontsOf(cdp, "pre > code");
  assert.equal(block.length, 1, `one font for the whole block (${JSON.stringify(block)})`);
  assert.equal(block[0]?.glyphCount, [...LABEL].length, `one glyph per letter in ${block[0]?.familyName}`);
  const monospace = await page.locator("[data-agentic-chat] >> css=.acw-assistant .acw-markdown pre > code").evaluate((node) => {
    const probe = (text: string) => { const range = document.createRange(); range.selectNodeContents(node); node.textContent = text; return range.getBoundingClientRect().width; };
    const label = node.textContent ?? "";
    const widths = [probe("iiii"), probe("MMMM")];
    node.textContent = label;
    return widths[0] === widths[1];
  });
  assert.equal(monospace, true, "and every letter is as wide as every other");
  await page.close();
});

test("a thematic break is drawn as a rule", async () => {
  const { page } = await open();
  const rule = page.locator("[data-agentic-chat] >> css=.acw-assistant .acw-markdown hr");
  assert.equal(await rule.count(), 1);
  const border = await rule.evaluate((node) => { const style = getComputedStyle(node); return [style.borderTopStyle, style.borderTopWidth]; });
  assert.deepEqual(border, ["solid", "1px"]);
  await page.close();
});
