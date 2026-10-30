import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubDom, type StubNode } from "./dom-stub.js";

/**
 * Who moved the conversation last, driven through the built bundle.
 *
 * Two failures no unit of the widget shows on its own: a reply that keeps dragging the view
 * back down while the user reads earlier messages, and a reply that lands below the fold
 * without the view following it. Both are about whether the last move was the user's or the
 * widget's, so these move the view the way a person does — a wheel notch, a click on the jump
 * button, a sent message — and read back where it ended up. The stub has no layout: geometry
 * is set by hand, and a taller conversation is a taller `scrollHeight`.
 */

interface StreamEvent { readonly type: string; readonly [key: string]: unknown }

interface Turn {
  /** Publishes a plan with one row per description; the last row is the one in progress. */
  plan(...descriptions: string[]): void;
  finish(): Promise<void>;
}

interface Harness {
  readonly dom: StubDom;
  readonly conversation: StubNode;
  readonly jump: StubNode;
  start(content: string): Promise<Turn>;
  /** The scroll a browser raises after the user has moved the view to `top`. */
  userScrollTo(top: number): void;
  wheelUp(): void;
}

async function mount(): Promise<Harness> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);

  let pending: { readonly sink: { onEvent(event: StreamEvent): void }; settle(result: Record<string, unknown>): void } | undefined;
  const api = scope.AgentChat as { create(options: Record<string, unknown>): { send(content: string): Promise<void> } };
  const widget = api.create({
    persistSession: false,
    startOpen: true,
    transport: {
      checkConnection: () => ({ status: "ok" }),
      loadHistory: () => [],
      send: (_request: unknown, sink: { onEvent(event: StreamEvent): void }) => new Promise((resolve) => {
        pending = { sink, settle: (result) => resolve(result) };
      }),
    },
  });
  const conversation = dom.body.querySelector(".acw-conversation");
  const jump = dom.body.querySelector(".acw-jump");
  assert.ok(conversation && jump, "the widget mounted its conversation and jump button");

  return {
    dom, conversation, jump,
    async start(content) {
      pending = undefined;
      const sent = widget.send(content);
      for (let attempt = 0; attempt < 50 && !pending; attempt += 1) {
        dom.flushFrames();
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
      assert.ok(pending, "the transport never received the turn");
      const turn = pending;
      dom.flushFrames();
      let revision = 0;
      return {
        plan(...descriptions) {
          revision += 1;
          const steps = descriptions.map((description, index) => ({
            id: `s${index + 1}`, description, status: index === descriptions.length - 1 ? "in_progress" : "completed",
          }));
          turn.sink.onEvent({
            type: "plan-updated", turnId: "t1", cause: "proposal",
            plan: { planId: "p1", revision, state: "active", goal: "Tính lương", steps },
          });
        },
        async finish() {
          // The reveal paces itself across frames; nothing here reads it, but the frames must run.
          const sampler = setInterval(() => dom.stepFrame(), 1);
          try {
            turn.settle({ content: "Xong." });
            await sent;
          } finally { clearInterval(sampler); }
          dom.flushFrames();
        },
      };
    },
    userScrollTo(top) {
      conversation.scrollTop = top;
      conversation.dispatchEvent({ type: "scroll" });
    },
    wheelUp() { conversation.dispatchEvent({ type: "wheel", deltaY: -100 }); },
  };
}

/** A conversation four screens tall, with the view parked at the bottom. */
function tall(harness: Harness): void {
  harness.conversation.scrollHeight = 2000;
  harness.conversation.clientHeight = 400;
  harness.conversation.scrollTop = 1600;
}

test("a wheel notch up during a reply leaves the view where the user put it and offers the way back", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  tall(harness);
  turn.plan("Đã xác nhận kỳ lương");
  harness.dom.flushFrames();
  assert.equal(harness.conversation.scrollTop, 2000, "while the user follows the stream, new rows pull the view to the end");
  assert.equal(harness.jump.hidden, true, "no jump button while the view is at the bottom");

  harness.wheelUp();
  harness.userScrollTo(1400);
  harness.conversation.scrollHeight = 2300;
  turn.plan("Đã xác nhận kỳ lương", "Đang đọc dữ liệu công");
  harness.dom.flushFrames();
  assert.equal(harness.conversation.scrollTop, 1400, "a row that lands while the user reads must not move them");
  assert.equal(harness.jump.hidden, false, "the way back down appears once the user is away");
  assert.equal(harness.jump.dataset.fresh, "true", "and it says something new landed below");
});

test("the jump button lands at the bottom, hides itself, and the stream follows again", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  tall(harness);
  harness.wheelUp();
  harness.userScrollTo(900);
  turn.plan("Đã xác nhận kỳ lương", "Đang đọc dữ liệu công");
  harness.dom.flushFrames();
  assert.equal(harness.jump.hidden, false);

  harness.jump.click();
  assert.equal(harness.conversation.scrollTop, 1600, "the jump lands exactly at the end of the content");
  assert.equal(harness.jump.hidden, true, "and the button is gone once the view is back");
  assert.equal(harness.jump.dataset.fresh, undefined, "nothing is new any more");

  harness.conversation.scrollHeight = 2400;
  turn.plan("Đã xác nhận kỳ lương", "Đã đọc dữ liệu công", "Đang lập bảng lương");
  harness.dom.flushFrames();
  assert.equal(harness.conversation.scrollTop, 2400, "after the jump the stream is followed again");
});

test("positions a smooth jump passes through do not count as the user leaving, a wheel notch does", async () => {
  const harness = await mount();
  const turn = await harness.start("Tính lương tháng 8");
  tall(harness);
  harness.wheelUp();
  harness.userScrollTo(300);
  turn.plan("Đã xác nhận kỳ lương", "Đang đọc dữ liệu công");
  harness.dom.flushFrames();

  harness.jump.click();
  // The stub lands instantly; a browser animates, raising scroll events from every position
  // in between. Replay one of those from inside the settle window.
  harness.userScrollTo(900);
  assert.equal(harness.jump.hidden, true, "a scroll event raised by our own smooth jump keeps the view stuck");
  harness.conversation.scrollHeight = 2400;
  turn.plan("Đã xác nhận kỳ lương", "Đã đọc dữ liệu công", "Đang lập bảng lương");
  harness.dom.flushFrames();
  assert.equal(harness.conversation.scrollTop, 2400, "and the next row still pulls the view to the end");

  harness.wheelUp();
  assert.equal(harness.jump.hidden, false, "a real gesture during the settle window still wins");
});

test("sending a message brings the view to the bottom even when the user had scrolled up", async () => {
  const harness = await mount();
  const first = await harness.start("Tính lương tháng 8");
  tall(harness);
  first.plan("Đã xác nhận kỳ lương");
  await first.finish();

  harness.wheelUp();
  harness.userScrollTo(200);
  assert.equal(harness.jump.hidden, false, "reading earlier messages shows the way back");

  harness.conversation.scrollHeight = 2200;
  await harness.start("Tạo bảng lương luôn");
  assert.equal(harness.conversation.scrollTop, 2200, "the user's own message always lands in view");
  assert.equal(harness.jump.hidden, true, "and the jump button is gone with it");
});
