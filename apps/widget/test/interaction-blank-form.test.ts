import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * A form of optional questions cannot be sent with none of them answered, in a real browser.
 *
 * Sent blank, such a form arrives as `{"action":"accept","values":{}}` and the agent reads it as an
 * answer ("no adjustment needed") that nobody gave. Skipping is what "Bỏ qua" is for; "Gửi" waits
 * for at least one answer and the status line says so.
 */

let browser: Browser;
let bundle: string;

before(async () => {
  bundle = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

/** The step-4 shape request_user_input writes: an open choice and a note, neither required. */
const OPTIONAL = {
  type: "object",
  properties: {
    adjust: { type: "string", title: "Điều chỉnh dữ liệu công", otherAnswer: true, oneOf: [{ const: "Có", title: "Có" }, { const: "Không", title: "Không" }] },
    details: { type: "string", title: "Nội dung điều chỉnh" },
  },
};
/** The runtime's own question whether to go on (core runtime-question.ts): one required choice. */
const RUNTIME = {
  type: "object", required: ["next"],
  properties: { next: { type: "string", title: "Làm tiếp?", oneOf: [{ const: "continue", title: "Làm tiếp" }, { const: "stop", title: "Dừng" }] } },
};

async function open(requestedSchema: Record<string, unknown>): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => { throw error; });
  await page.setContent(`<!doctype html><html><body style="margin:0"><main>app</main></body></html>`);
  await page.evaluate("window.__name = (target) => target; window.resolved = [];");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((schema) => {
    const scope = window as unknown as { resolved: unknown[]; AgentChat: { create(options: Record<string, unknown>): { send(text: string): Promise<void> } } };
    const interaction = {
      kind: "form", interactionId: "form-1", sessionId: "session-form", turnId: "turn-1", toolId: "request_user_input", requesterId: "agent",
      title: "Dữ liệu công", message: "Dữ liệu công tháng 10 đã lấy từ Chấm công.", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      requestedSchema: schema,
    };
    const widget = scope.AgentChat.create({
      persistSession: false, storageKey: `form-${Math.random()}`, agentName: "Agent", startOpen: true, sessionId: "session-form",
      transport: {
        checkConnection: () => ({ status: "ok" }), loadHistory: () => [],
        send: async () => ({ content: "", outcome: "awaiting_interaction", interaction }),
        resolveInteraction: async (request: { action: string; content?: unknown }) => {
          scope.resolved.push({ action: request.action, content: request.content ?? null });
          return { content: "Đã nhận." };
        },
      },
    });
    return widget.send("Tính lương tháng 10");
  }, requestedSchema);
  await page.locator("[data-agentic-chat] >> css=.acw-interaction").waitFor();
  return page;
}

const inCard = (page: Page, css: string) => page.locator(`[data-agentic-chat] >> css=.acw-interaction ${css}`);
const send = (page: Page) => inCard(page, ".acw-approval-approve");
const status = (page: Page) => inCard(page, ".acw-approval-status").innerText();
const resolved = (page: Page) => page.evaluate(() => (window as unknown as { resolved: unknown[] }).resolved);
const reviewTab = (page: Page) => inCard(page, '.acw-interaction-tab[data-summary="true"]').click();

test("two optional questions, none answered: Gửi is disabled and the status line names Bỏ qua", async () => {
  const page = await open(OPTIONAL);
  await reviewTab(page);
  assert.equal(await send(page).isVisible(), true, "the review tab shows Gửi");
  assert.equal(await send(page).isDisabled(), true, "nothing answered: nothing to send");
  assert.match(await status(page), /Bỏ qua/u, "the status line says the way to skip");
  await send(page).click({ force: true });
  assert.deepEqual(await resolved(page), [], "a press on the disabled button sends nothing");
  await page.close();
});

test("one answer is enough: Gửi is enabled again, the status line is back, and the answer is sent", async () => {
  const page = await open(OPTIONAL);
  await reviewTab(page);
  assert.equal(await send(page).isDisabled(), true);
  await inCard(page, ".acw-interaction-tab").first().click();
  await inCard(page, '.acw-choice-button[data-choice="Không"]').click();
  await reviewTab(page);
  assert.equal(await send(page).isDisabled(), false, "one question answered: the form can be sent");
  assert.doesNotMatch(await status(page), /Bỏ qua/u, "the hint is gone");
  assert.match(await status(page), /Có hiệu lực đến/u, "and the card's own line is back");
  await send(page).click();
  await page.waitForFunction(() => (window as unknown as { resolved: unknown[] }).resolved.length > 0);
  assert.deepEqual(await resolved(page), [{ action: "accept", content: { adjust: "Không" } }], "only what was answered is sent");
  await page.close();
});

test("Bỏ qua still skips the form: it sends a decline, never an empty answer", async () => {
  const page = await open(OPTIONAL);
  await inCard(page, ".acw-approval-deny").click();
  await page.waitForFunction(() => (window as unknown as { resolved: unknown[] }).resolved.length > 0);
  assert.deepEqual(await resolved(page), [{ action: "decline", content: null }]);
  await page.close();
});

test("the runtime's own card, whose question is required, has one question and no review: Gửi waits for the answer", async () => {
  const page = await open(RUNTIME);
  assert.equal(await inCard(page, ".acw-interaction-tab").count(), 0, "one question: no tab, so no review tab");
  assert.equal(await send(page).isVisible(), true, "Gửi is on the card from the start");
  assert.equal(await send(page).isDisabled(), true, "its required question still holds Gửi back");
  assert.doesNotMatch(await status(page), /Bỏ qua/u, "with the card's own status line, as before");
  await inCard(page, '.acw-choice-button[data-choice="continue"]').click();
  assert.equal(await inCard(page, ".acw-interaction-tab").count(), 0, "choosing moves nowhere");
  assert.equal(await send(page).isDisabled(), false);
  await send(page).click();
  await page.waitForFunction(() => (window as unknown as { resolved: unknown[] }).resolved.length > 0);
  assert.deepEqual(await resolved(page), [{ action: "accept", content: { next: "continue" } }], "the answer is sent once");
  await page.close();
});

test("one free-text question is typed and sent from its own panel, without a review tab", async () => {
  const page = await open({ type: "object", required: ["note"], properties: { note: { type: "string", title: "Ghi chú", minLength: 2 } } });
  assert.equal(await inCard(page, ".acw-interaction-tab").count(), 0);
  assert.equal(await send(page).isDisabled(), true, "nothing typed yet");
  await inCard(page, "input[name=note]").fill("a");
  assert.equal(await send(page).isDisabled(), true, "shorter than minLength: not valid yet");
  await inCard(page, "input[name=note]").fill("Đã kiểm tra");
  await send(page).click();
  await page.waitForFunction(() => (window as unknown as { resolved: unknown[] }).resolved.length > 0);
  assert.deepEqual(await resolved(page), [{ action: "accept", content: { note: "Đã kiểm tra" } }]);
  await page.close();
});

test("one optional question left blank is not sent: Gửi is disabled and the status line names Bỏ qua", async () => {
  const page = await open({ type: "object", properties: { note: { type: "string", title: "Ghi chú" } } });
  assert.equal(await send(page).isDisabled(), true);
  assert.match(await status(page), /Bỏ qua/u);
  await page.close();
});

test("several questions keep their tabs and the review tab, where Gửi lives", async () => {
  const page = await open({ type: "object", required: ["a", "b"], properties: {
    a: { type: "string", title: "Câu một", oneOf: [{ const: "x", title: "X" }, { const: "y", title: "Y" }] },
    b: { type: "string", title: "Câu hai" },
  } });
  const tabs = inCard(page, ".acw-interaction-tab");
  assert.deepEqual(await tabs.allInnerTexts(), ["Câu một", "Câu hai", "Xem lại"]);
  assert.equal(await send(page).isVisible(), false, "Gửi appears on the review tab only");
  await inCard(page, '.acw-choice-button[data-choice="x"]').click();
  await inCard(page, "input[name=b]").fill("ghi chú");
  await reviewTab(page);
  assert.equal(await send(page).isVisible(), true);
  await send(page).click();
  await page.waitForFunction(() => (window as unknown as { resolved: unknown[] }).resolved.length > 0);
  assert.deepEqual(await resolved(page), [{ action: "accept", content: { a: "x", b: "ghi chú" } }]);
  await page.close();
});
