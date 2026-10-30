import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubNode } from "./dom-stub.js";

/**
 * The docked panel beside the page (ui/dock-layout.ts), through the built bundle against the stub DOM.
 *
 * Pushed, the page's body gives up the panel's width and the panel never compacts. A window too
 * small to hold the page at the width it still works at next to the panel gets the panel over the
 * page's edge instead, where compacting while the agent works is back — as on the floating panel.
 */

interface Widget { setCompactMode(compact: boolean): void; setMode(mode: "floating" | "docked"): void; close(): void; destroy(): void }

async function mount(width: number, options: Record<string, unknown> = {}) {
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
  scope.innerWidth = width;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): Widget };
  const widget = api.create({
    persistSession: false, storageKey: "dock-spec", mode: "docked", startOpen: true, dockedPageMinWidth: 800,
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
    ...options,
  });
  const root = dom.body.querySelector(".acw-root") as StubNode;
  const handle = dom.body.querySelector(".acw-resize-handle") as StubNode;
  return {
    widget, root, handle, dom, scope,
    margin: () => dom.body.style["margin-right"] ?? "",
    resize(next: number) {
      scope.innerWidth = next;
      (dom.window.dispatchEvent as (event: { readonly type: string }) => void)({ type: "resize" });
    },
  };
}

test("docked, the panel stands beside a page that keeps its working width and never compacts there", async () => {
  const mounted = await mount(1280);
  try {
    assert.equal(mounted.root.dataset.dock, "push");
    assert.equal(mounted.margin(), "410px", "the page gives up exactly the panel's width");
    mounted.widget.setCompactMode(true);
    assert.notEqual(mounted.root.dataset.compact, "true", "beside the page the panel covers nothing, so it does not step aside");
  } finally { mounted.widget.destroy(); }
});

test("a window too small for the page beside the panel gets the panel over the page, which compacts again", async () => {
  // 1000 - 340 (the panel at its narrowest) = 660px, under the page's 800.
  const mounted = await mount(1000);
  try {
    assert.equal(mounted.root.dataset.dock, undefined);
    assert.equal(mounted.margin(), "", "the page keeps its whole width");
    mounted.widget.setCompactMode(true);
    assert.equal(mounted.root.dataset.compact, "true", "over the page, the panel steps aside while the agent works");
    mounted.widget.setCompactMode(false);
    mounted.resize(1600);
    assert.equal(mounted.root.dataset.dock, "push", "a wider window puts it back beside the page");
    assert.equal(mounted.margin(), "410px");
    mounted.resize(1000);
    assert.equal(mounted.root.dataset.dock, undefined, "and a narrower one over it again");
    assert.equal(mounted.margin(), "", "handing the width back");
  } finally { mounted.widget.destroy(); }
});

test("widening the docked panel stops where the page would fall under its working width", async () => {
  const mounted = await mount(1280);
  try {
    mounted.handle.dispatchEvent({ type: "pointerdown", pointerId: 3, button: 0, clientX: 870, clientY: 400, preventDefault: () => undefined });
    mounted.handle.dispatchEvent({ type: "pointermove", pointerId: 3, button: 0, clientX: 0, clientY: 400 });
    mounted.handle.dispatchEvent({ type: "pointerup", pointerId: 3, button: 0, clientX: 0, clientY: 400 });
    assert.equal(mounted.margin(), "480px", "1280 - 800: the page keeps its 800px");
  } finally { mounted.widget.destroy(); }
});

test("closing the docked panel, or destroying the widget, hands the page its width back", async () => {
  const mounted = await mount(1280);
  mounted.widget.close();
  assert.equal(mounted.margin(), "");
  mounted.widget.destroy();
  assert.equal(mounted.margin(), "");
});

/**
 * A page layer pinned to the window: the stub has no layout, so its box, its computed position
 * and what lies under a point in the strip are given here, as a browser would report them.
 */
function pinned(mounted: Awaited<ReturnType<typeof mount>>, box: { readonly left: number; readonly right: number }, style: Record<string, string> = {}): StubNode {
  const layer = mounted.dom.document.createElement("div") as unknown as StubNode;
  for (const [name, value] of Object.entries(style)) layer.style.setProperty(name, value);
  (layer as unknown as { getBoundingClientRect(): Record<string, number> }).getBoundingClientRect = () => {
    const offset = Number.parseFloat(layer.style.right ?? "") || 0;
    const right = Math.min(box.right, (mounted.scope.innerWidth as number) - offset);
    return { left: box.left, right, top: 0, bottom: 900, width: right - box.left, height: 900, x: box.left, y: 0 };
  };
  return layer;
}

function underTheStrip(mounted: Awaited<ReturnType<typeof mount>>, layers: () => readonly StubNode[]): void {
  const fixed = new Set<StubNode>();
  mounted.scope.getComputedStyle = (node: StubNode) => ({ position: fixed.has(node) ? "fixed" : "static", getPropertyValue: () => "" });
  (mounted.dom.document as unknown as Record<string, unknown>).elementsFromPoint = () => {
    const stack = layers();
    for (const layer of stack) fixed.add(layer);
    // The panel lies on top of the strip, as in a browser; the page's layers below it.
    return [mounted.root, ...stack];
  };
}

/** The look at the page runs in an animation frame, or after a short wait while the page keeps changing. */
async function settle(mounted: Awaited<ReturnType<typeof mount>>): Promise<void> {
  mounted.dom.flushFrames();
  await new Promise((resolve) => setTimeout(resolve, 200));
  mounted.dom.flushFrames();
}

test("a full-screen popup opened after the panel docked gives up the strip too, and gets its own inline values back on release", async () => {
  const mounted = await mount(1280);
  try {
    const popup = pinned(mounted, { left: 0, right: 1280 }, { "z-index": "9999" });
    const shown: StubNode[] = [];
    underTheStrip(mounted, () => shown);
    mounted.dom.body.append(popup);
    shown.push(popup);
    // What the page changes is looked at again; a resize of the window does the same in the stub.
    mounted.resize(1280);
    await settle(mounted);
    assert.equal(popup.style.right, "410px", "the popup stops at the panel's edge, as the body does");
    assert.equal(popup.style["max-width"], "calc(100% - 410px)");
    assert.equal(popup.style["z-index"], "9999", "nothing else on the popup changes");
    mounted.widget.close();
    assert.equal(popup.style.right, undefined, "closing the panel hands the popup its whole width back");
    assert.equal(popup.style["max-width"], undefined);
  } finally { mounted.widget.destroy(); }
});

test("a control the page pins to the screen's edge stays on the edge, over the panel", async () => {
  const mounted = await mount(1280);
  try {
    // Agentic's drawer of edge buttons: fixed, right 0, 56px wide.
    const drawer = pinned(mounted, { left: 1224, right: 1280 }, { right: "0px" });
    mounted.dom.body.append(drawer);
    underTheStrip(mounted, () => [drawer]);
    mounted.resize(1280);
    await settle(mounted);
    assert.equal(drawer.style.right, "0px", "an edge control does not span the window, so it is left where the page put it");
    assert.equal(drawer.style["max-width"], undefined);
  } finally { mounted.widget.destroy(); }
});

test("widening the docked panel moves a yielded popup's edge with it", async () => {
  const mounted = await mount(1280);
  try {
    const popup = pinned(mounted, { left: 0, right: 1280 });
    mounted.dom.body.append(popup);
    underTheStrip(mounted, () => [popup]);
    mounted.resize(1280);
    await settle(mounted);
    assert.equal(popup.style.right, "410px");
    mounted.handle.dispatchEvent({ type: "pointerdown", pointerId: 4, button: 0, clientX: 870, clientY: 400, preventDefault: () => undefined });
    mounted.handle.dispatchEvent({ type: "pointermove", pointerId: 4, button: 0, clientX: 0, clientY: 400 });
    mounted.handle.dispatchEvent({ type: "pointerup", pointerId: 4, button: 0, clientX: 0, clientY: 400 });
    assert.equal(mounted.margin(), "480px");
    assert.equal(popup.style.right, "480px", "the popup and the body give up the same strip");
  } finally { mounted.widget.destroy(); }
});
