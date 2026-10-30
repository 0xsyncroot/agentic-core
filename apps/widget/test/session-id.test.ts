import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { StubNode, createStubDom } from "./dom-stub.js";

/**
 * A conversation the widget starts itself is named by a plain GUID, with no prefix: on first mount and on "new conversation",
 * whether or not the page offers `crypto.randomUUID`.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface Widget { getSessionId(): string; newSession(): void; destroy(): void }

async function mount(cryptoApi: unknown): Promise<Widget> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: dom.document, URL, Headers, Response, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout,
    crypto: cryptoApi, Element: StubNode,
    location: { origin: "https://app.example", href: "https://app.example/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context; scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  const api = scope.AgentChat as { create(options: Record<string, unknown>): Widget };
  return api.create({
    persistSession: false, startOpen: true,
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: async () => ({ content: "ok" }) },
  });
}

test("a conversation the widget starts is a plain GUID, on mount and on a new conversation", async () => {
  const widget = await mount(crypto);
  const first = widget.getSessionId();
  assert.match(first, GUID);
  widget.newSession();
  const second = widget.getSessionId();
  assert.match(second, GUID);
  assert.notEqual(second, first);
  widget.destroy();
});

test("without crypto.randomUUID the id is still a version 4 GUID", async () => {
  const widget = await mount({ getRandomValues: (bytes: Uint8Array) => crypto.getRandomValues(bytes) });
  assert.match(widget.getSessionId(), GUID);
  widget.newSession();
  assert.match(widget.getSessionId(), GUID);
  widget.destroy();
});
