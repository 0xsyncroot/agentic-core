import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubNode } from "./dom-stub.js";

/**
 * Theming through the built bundle: a host passes its brand colour and nothing else, and every
 * brand-coloured surface follows. Two ways that breaks, one test each — the options not reaching
 * the host element's custom properties, and a stylesheet rule naming a brand hue literally,
 * which no option can reach.
 */

interface Mounted {
  /** The element the widget attached its shadow root to; the theme's custom properties live here. */
  readonly host: StubNode;
  readonly styles: string;
}

async function mount(options: Record<string, unknown> = {}): Promise<Mounted> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    // Stands in for the browser's own check: hex colours pass, anything else is not a colour.
    CSS: { supports: (_property: string, value: string) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(value) },
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
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: () => new Promise(() => undefined) },
    ...options,
  });
  const host = dom.body.children.find((node) => node.children.some((child) => child.tagName === "#shadow-root"));
  assert.ok(host, "the widget mounted its host element");
  // No CSSStyleSheet in the stub, so the widget takes its <style> fallback — the same sheet text.
  const style = host.children.find((child) => child.tagName === "#shadow-root")!.children.find((child) => child.tagName === "style");
  assert.ok(style, "the stylesheet was injected");
  return { host, styles: style.textContent };
}

test("a host's primaryColor alone recolours the widget, gradients included", async () => {
  const { host } = await mount({ primaryColor: "#0e9a62" });
  assert.equal(host.style["--acw-primary"], "#0e9a62");
  assert.equal(host.style["--acw-accent"], "#0e9a62", "the default purple accent does not survive a host's own colour");
});

test("an accentColor of the host's own is kept alongside its primaryColor", async () => {
  const { host } = await mount({ primaryColor: "#0e9a62", accentColor: "#0a7a4d" });
  assert.equal(host.style["--acw-primary"], "#0e9a62");
  assert.equal(host.style["--acw-accent"], "#0a7a4d");
});

test("without a usable colour the stylesheet's own defaults stand", async () => {
  for (const options of [{}, { primaryColor: "" }, { primaryColor: "green; background: red" }]) {
    const { host } = await mount(options);
    assert.equal(host.style["--acw-primary"], undefined, JSON.stringify(options));
    assert.equal(host.style["--acw-accent"], undefined, JSON.stringify(options));
  }
});

test("brand hues appear only as the theme's defaults, so every rule follows primaryColor", async () => {
  const { styles } = await mount();
  // The bare `:host { … }` block is where the defaults are declared; everything after it must
  // reach a brand colour through var(--acw-primary) / var(--acw-accent) / what derives from them.
  const rules = styles.replace(/:host\s*\{[^}]*\}/u, "");
  assert.notEqual(rules, styles, "the stylesheet declares its theme defaults on :host");
  const literals = [
    ...[...rules.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/giu)].map(([text, hex]) => {
      const full = hex!.length === 3 ? [...hex!].map((digit) => digit + digit).join("") : hex!;
      return { text, rgb: [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) };
    }),
    ...[...rules.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)[^)]*\)/giu)].map(([text, ...rgb]) => ({ text, rgb: rgb.map(Number) })),
  ];
  // Blue through violet with real colour in it. Greys with a cool cast (#344054, #dbe3ef…) have
  // too little chroma to read as a brand; success greens, warning ambers and error reds are
  // outside the range and meant to stay what they are whatever the brand.
  const brandHued = literals.filter(({ rgb }) => {
    const [r, g, b] = rgb as [number, number, number];
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma < 60) return false;
    const sector = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    const hue = sector * 60;
    return hue >= 190 && hue <= 330;
  }).map(({ text }) => text);
  assert.deepEqual(brandHued, [], "these stay blue or purple whatever primaryColor the host sets");
});
