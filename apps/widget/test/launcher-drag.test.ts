import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubNode } from "./dom-stub.js";

/**
 * The launcher button, dragged through the built bundle against the stub DOM.
 *
 * A launcher that can be moved has one failure mode no screenshot shows: the release at the
 * end of a drag is also a click, and a click opens the panel. These drive the pointer sequence
 * a browser produces and read back where the button went and whether the panel opened.
 */

interface Mounted {
  readonly launcher: StubNode;
  readonly panel: StubNode;
  /** What the widget wrote to localStorage, keyed exactly as it wrote it. */
  readonly storage: Map<string, string>;
  readonly scope: Record<string, unknown>;
  /** Changes the viewport and raises `resize` on the window the widget listens to. */
  resize(width: number, height: number): void;
}

const STORAGE_KEY = "spec";
const POSITION_KEY = `${STORAGE_KEY}:launcher`;

async function mount(options: Record<string, unknown> = {}, seed: Readonly<Record<string, string>> = {}): Promise<Mounted> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const storage = new Map(Object.entries(seed));
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);

  const api = scope.AgentChat as { create(options: Record<string, unknown>): unknown };
  api.create({
    persistSession: false,
    storageKey: STORAGE_KEY,
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
    ...options,
  });
  const launcher = dom.body.querySelector(".acw-launcher");
  const panel = dom.body.querySelector(".acw-panel");
  assert.ok(launcher && panel, "the widget mounted its shell");
  return {
    launcher, panel, storage, scope,
    resize(width, height) {
      scope.innerWidth = width;
      scope.innerHeight = height;
      (dom.window.dispatchEvent as (event: { readonly type: string }) => void)({ type: "resize" });
    },
  };
}

/** One pointer event, shaped the way the widget reads it. */
const pointer = (node: StubNode, type: string, x: number, y: number, pointerId = 7) =>
  node.dispatchEvent({ type, pointerId, button: 0, clientX: x, clientY: y });

const px = (value: string | undefined) => Number.parseInt(value ?? "", 10);

test("a drag moves the launcher, and the release does not open the panel", async () => {
  const { launcher, panel, storage } = await mount();
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 300, 250);
  assert.equal(launcher.dataset.dragging, "true");
  assert.equal(launcher.style.left, "200px");
  assert.equal(launcher.style.top, "150px");

  pointer(launcher, "pointerup", 300, 250);
  // A browser fires click after pointerup on the same element whatever happened in between.
  launcher.click();
  assert.equal(panel.hidden, true, "a drag is not a click");
  assert.equal(launcher.hidden, false);
  assert.equal(launcher.dataset.dragging, undefined);
  assert.equal(launcher.dataset.moved, "true");
  assert.equal(storage.get(POSITION_KEY), JSON.stringify({ left: 200, top: 150 }));

  // The flag was spent on that click: the next one is an ordinary click again.
  launcher.click();
  assert.equal(panel.hidden, false, "the click after a finished drag opens the panel as usual");
});

test("a press that barely moves is still a click", async () => {
  const { launcher, panel, storage } = await mount();
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 103, 102);
  assert.equal(launcher.dataset.dragging, undefined, "a wobble under the threshold is not a drag");
  pointer(launcher, "pointerup", 103, 102);
  launcher.click();
  assert.equal(panel.hidden, false, "the panel opened");
  assert.equal(launcher.hidden, true);
  assert.equal(launcher.style.left, undefined, "nothing was painted");
  assert.equal(storage.has(POSITION_KEY), false, "nothing moved, so nothing is remembered");
});

test("keyboard activation is a click with no pointer sequence in front of it", async () => {
  const { launcher, panel } = await mount();
  // Enter or Space on a focused <button> ends in exactly this event and nothing else.
  launcher.click();
  assert.equal(panel.hidden, false);
});

test("a remembered position that is off screen is pulled back inside", async () => {
  const { launcher, scope } = await mount({}, { [POSITION_KEY]: JSON.stringify({ left: 5000, top: 5000 }) });
  const width = scope.innerWidth as number;
  const height = scope.innerHeight as number;
  assert.equal(launcher.dataset.moved, "true");
  const left = px(launcher.style.left);
  const top = px(launcher.style.top);
  assert.ok(left >= 0 && left < width, `left ${left} sits inside a ${width}px viewport`);
  assert.ok(top >= 0 && top < height, `top ${top} sits inside a ${height}px viewport`);
});

test("garbage in storage is ignored rather than painted", async () => {
  const { launcher } = await mount({}, { [POSITION_KEY]: '{"left":"far","top":null}' });
  assert.equal(launcher.dataset.moved, undefined);
  assert.equal(launcher.style.left, undefined);
});

test("a smaller window pulls a moved launcher back inside, and a larger one gives it back", async () => {
  const mounted = await mount();
  const { launcher } = mounted;
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 800, 600);
  pointer(launcher, "pointerup", 800, 600);
  assert.equal(launcher.style.left, "700px");
  assert.equal(launcher.style.top, "500px");

  mounted.resize(400, 300);
  const left = px(launcher.style.left);
  const top = px(launcher.style.top);
  assert.ok(left >= 0 && left < 400, `left ${left} after shrinking the window to 400px`);
  assert.ok(top >= 0 && top < 300, `top ${top} after shrinking the window to 300px`);

  // The spot the user chose is what comes back, not the spot the small window forced.
  mounted.resize(1280, 900);
  assert.equal(launcher.style.left, "700px");
  assert.equal(launcher.style.top, "500px");
});

test("a cancelled gesture puts the launcher back where it started", async () => {
  const { launcher, panel, storage } = await mount();
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 300, 250);
  assert.equal(launcher.style.left, "200px");
  launcher.dispatchEvent({ type: "pointercancel", pointerId: 7 });
  assert.equal(launcher.style.left, "");
  assert.equal(launcher.dataset.moved, undefined);
  assert.equal(storage.has(POSITION_KEY), false);
  // And it left nothing behind that would eat the next click.
  launcher.click();
  assert.equal(panel.hidden, false);
});

test("draggableLauncher: false keeps the stylesheet's corner and ignores a stored position", async () => {
  const { launcher, panel } = await mount({ draggableLauncher: false }, { [POSITION_KEY]: JSON.stringify({ left: 200, top: 150 }) });
  assert.equal(launcher.dataset.draggable, undefined);
  assert.equal(launcher.style.left, undefined);
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 300, 250);
  pointer(launcher, "pointerup", 300, 250);
  assert.equal(launcher.style.left, undefined, "nothing moved");
  launcher.click();
  assert.equal(panel.hidden, false, "it is a plain button");
});

test("persistLauncherPosition: false moves the launcher for this page only", async () => {
  const { launcher, storage } = await mount({ persistLauncherPosition: false });
  pointer(launcher, "pointerdown", 100, 100);
  pointer(launcher, "pointermove", 300, 250);
  pointer(launcher, "pointerup", 300, 250);
  assert.equal(launcher.style.left, "200px");
  assert.equal(storage.size, 0);
});
