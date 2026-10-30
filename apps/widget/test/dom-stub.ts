/**
 * Enough of a DOM to run the built widget inside `node:vm`, and nothing more.
 *
 * The widget is a classic script that publishes one global, so a test cannot import its
 * internals — the activity panel, where the bugs users actually report keep appearing, was
 * therefore covered only by asserting that certain strings survive minification. That checks
 * the copy exists, never that the panel puts it on the right row.
 *
 * A real DOM library would answer that, at the cost of a dependency in a repository that is
 * handed to another team and has kept its dependency list to four entries. The widget's actual
 * demand is small — `createElement`, class and dataset bookkeeping, and a few selectors — so
 * this is the same trade the rest of the suite already makes: hand-written stubs for the exact
 * surface under test.
 *
 * What it deliberately does NOT do: layout or CSS. It does parse HTML, because it has to: the
 * widget builds its shell by assigning a static template to a shadow root, so a stub that only
 * stored the string would fail in the constructor. The parser is small on purpose — its input is
 * that one template plus the widget's own Markdown output, never arbitrary documents.
 */

type Listener = (event: unknown) => void;

/**
 * The window's capture-phase listeners, by the top node of a document (its body or html): a bubbling
 * event reaches them before any node on its path, as in a browser, where `window` is the first stop
 * of the capture phase. The widget takes Escape there, before a host page can stop it.
 */
const WINDOW_CAPTURE = new WeakMap<StubNode, Map<string, Set<Listener>>>();

const VOID_TEXT = new Set(["script", "style"]);
/** Tags that never have a closing form. The widget's own markup uses only `input`. */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decode(text: string): string {
  return text.replaceAll(/&(#\d+|#x[0-9a-f]+|[a-z]+);/giu, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Builds nodes from markup.
 *
 * Deliberately not a conformant HTML parser: no comments, no implied tags, no error recovery.
 * It reads well-formed markup that this repository itself produces, and a malformed input is
 * far better surfaced as a broken test than silently repaired the way a browser would.
 */
function parseHtml(html: string, into: StubNode): void {
  const tokens = html.matchAll(/<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gu);
  const stack: StubNode[] = [into];
  for (const [, closing, opening, attributes, selfClosing, text] of tokens) {
    const parent = stack.at(-1)!;
    if (text !== undefined) {
      if (text.trim()) parent.append(decode(text));
      continue;
    }
    if (closing !== undefined) {
      if (stack.length > 1 && parent.tagName === closing.toLowerCase()) stack.pop();
      continue;
    }
    const node = new StubNode(opening!.toLowerCase());
    for (const [, name, value] of (attributes ?? "").matchAll(/([\w:-]+)(?:="([^"]*)")?/gu)) {
      const attribute = name!.toLowerCase();
      const resolved = value === undefined ? "" : decode(value);
      if (attribute.startsWith("data-")) {
        node.dataset[attribute.slice(5).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = resolved;
        continue;
      }
      node.setAttribute(attribute, resolved);
      if (attribute === "hidden") node.hidden = true;
      if (attribute === "value") node.value = resolved;
    }
    parent.append(node);
    if (!selfClosing && !VOID_ELEMENTS.has(node.tagName)) stack.push(node);
  }
}

export class StubNode {
  readonly children: StubNode[] = [];
  parentNode: StubNode | undefined;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  /** Properties as plain keys; custom properties (`--x`) go through setProperty, as in a browser. */
  readonly style: Record<string, string> = Object.defineProperties({}, {
    setProperty: { value(this: Record<string, string>, name: string, value: string) { this[name] = value; } },
    getPropertyValue: { value(this: Record<string, string>, name: string) { return this[name] ?? ""; } },
    getPropertyPriority: { value() { return ""; } },
    removeProperty: { value(this: Record<string, string>, name: string) { delete this[name]; } },
  });
  readonly #listeners = new Map<string, Set<Listener>>();
  #text = "";
  #html = "";
  /** `<details>` only; assigning it fires `toggle`, which is what the panel's label listens to. */
  #open = false;
  hidden = false;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** No layout: everything sits at the origin with no size, and the widget falls back to its own constants. */
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;

  constructor(readonly tagName: string) {}

  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(value: string) { this.attributes.set("class", value); }
  get classList(): { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void; contains(name: string): boolean } {
    const names = () => new Set(this.className.split(/\s+/u).filter(Boolean));
    const write = (set: Set<string>) => { this.className = [...set].join(" "); };
    return {
      add: (...add) => { const set = names(); for (const name of add) set.add(name); write(set); },
      remove: (...drop) => { const set = names(); for (const name of drop) set.delete(name); write(set); },
      toggle: (name, force) => {
        const set = names();
        if (force === undefined ? set.has(name) : !force) set.delete(name); else set.add(name);
        write(set);
      },
      contains: (name) => names().has(name),
    };
  }

  get open(): boolean { return this.#open; }
  set open(value: boolean) {
    if (this.#open === value) return;
    this.#open = value;
    this.dispatchEvent({ type: "toggle" });
  }

  get textContent(): string {
    if (this.#text) return this.#text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    // Replaced children are detached, as in a browser: a node kept from before no longer has this parent.
    for (const child of this.children) child.parentNode = undefined;
    this.children.length = 0;
    this.#text = String(value ?? "");
  }

  get innerHTML(): string { return this.#html; }
  set innerHTML(value: string) {
    for (const child of this.children) child.parentNode = undefined;
    this.children.length = 0;
    this.#text = "";
    this.#html = String(value ?? "");
    parseHtml(this.#html, this);
  }

  /** The widget renders inside a shadow root; for these tests it is simply a child node. */
  attachShadow(): StubNode {
    const root = new StubNode("#shadow-root");
    root.parentNode = this;
    this.children.push(root);
    return root;
  }

  get firstChild(): StubNode | undefined { return this.children[0]; }
  get lastChild(): StubNode | undefined { return this.children.at(-1); }
  get firstElementChild(): StubNode | undefined { return this.children[0]; }
  get lastElementChild(): StubNode | undefined { return this.children.at(-1); }
  get nextSibling(): StubNode | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get childNodes(): StubNode[] { return this.children; }

  #detach(node: StubNode): void {
    const index = node.parentNode?.children.indexOf(node) ?? -1;
    if (index >= 0) node.parentNode!.children.splice(index, 1);
    node.parentNode = undefined;
  }

  append(...nodes: (StubNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") { this.#text += node; continue; }
      this.#detach(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node: StubNode): StubNode { this.append(node); return node; }
  prepend(node: StubNode): void { this.insertBefore(node, this.children[0] ?? null); }
  replaceChildren(...nodes: StubNode[]): void {
    for (const child of [...this.children]) this.#detach(child);
    this.append(...nodes);
  }
  insertBefore(node: StubNode, reference: StubNode | null | undefined): StubNode {
    this.#detach(node);
    node.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  removeChild(node: StubNode): StubNode { this.#detach(node); return node; }
  remove(): void { if (this.parentNode) this.#detach(this); }
  replaceWith(node: StubNode): void {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    this.remove();
  }

  /**
   * Only the positions the widget uses, parsed the same way `innerHTML` is.
   *
   * The streaming renderer commits settled Markdown with `beforeend` and keeps the unsettled
   * tail in a text node. An answer without a paragraph break never reaches the first path, so a
   * stub missing this looks complete right up until a real reply arrives with a blank line in it.
   */
  insertAdjacentHTML(position: string, html: string): void {
    const holder = new StubNode("#fragment");
    parseHtml(String(html), holder);
    const nodes = [...holder.children];
    if (position === "afterbegin") { for (const node of nodes.reverse()) this.insertBefore(node, this.children[0] ?? null); return; }
    if (position === "beforebegin" && this.parentNode) { for (const node of nodes) this.parentNode.insertBefore(node, this); return; }
    if (position === "afterend" && this.parentNode) { for (const node of nodes.reverse()) this.parentNode.insertBefore(node, this.nextSibling); return; }
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttributeNS(_namespace: string | null, name: string, value: string): void { this.setAttribute(name, value); }

  addEventListener(type: string, listener: Listener): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void { this.#listeners.get(type)?.delete(listener); }
  /**
   * Delivered to this node only, unless the event says `bubbles: true`: then it climbs the parents
   * the way a browser's does, `target` staying the node it started at, until a listener stops it.
   * Opt-in, so the many tests that dispatch at the node they mean keep meaning exactly that node;
   * delegated listeners (one handler on the root for every table's button) need the climb.
   */
  dispatchEvent(event: { readonly type: string } & Record<string, unknown>): boolean {
    if (event.bubbles !== true) {
      for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener({ ...event, target: this });
      return true;
    }
    const path: StubNode[] = [];
    for (let node: StubNode | undefined = this; node; node = node.parentNode) path.push(node);
    let stopped = false;
    const own = event.stopPropagation as (() => void) | undefined;
    const delivered = {
      preventDefault: () => undefined, ...event, target: this, composedPath: () => path,
      stopPropagation: () => { stopped = true; own?.(); },
    };
    for (const listener of [...(WINDOW_CAPTURE.get(path.at(-1)!)?.get(event.type) ?? [])]) listener({ ...delivered, currentTarget: undefined });
    if (stopped) return true;
    for (const node of path) {
      for (const listener of [...(node.#listeners.get(event.type) ?? [])]) listener({ ...delivered, currentTarget: node });
      if (stopped) break;
    }
    return true;
  }

  /** Attributes, data, text and (deep) children, as the full-size table view copies a table. Listeners are not copied, as in a browser. */
  cloneNode(deep = false): StubNode {
    const copy = new StubNode(this.tagName);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    Object.assign(copy.dataset, this.dataset);
    copy.hidden = this.hidden;
    copy.#text = this.#text;
    if (deep) for (const child of this.children) copy.append(child.cloneNode(true));
    return copy;
  }

  focus(): void { /* no layout, nothing to move */ }
  blur(): void { /* no layout, nothing to move */ }
  click(): void { this.dispatchEvent({ type: "click" }); }
  /** Capture only routes events; a test dispatches them at the node it means anyway. */
  setPointerCapture(): void { /* nothing to route */ }
  releasePointerCapture(): void { /* nothing to route */ }
  /** Lands where a browser would — clamped — and raises the `scroll` a real move raises. */
  scrollTo(options?: number | { readonly top?: number }): void {
    const top = typeof options === "number" ? options : options?.top ?? 0;
    this.scrollTop = Math.max(0, Math.min(top, Math.max(0, this.scrollHeight - this.clientHeight)));
    this.dispatchEvent({ type: "scroll" });
  }
  scrollIntoView(): void { /* no layout */ }
  getBoundingClientRect(): Record<string, number> {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 320, height: 480, x: 0, y: 0 };
  }
  contains(node: StubNode): boolean {
    for (let cursor: StubNode | undefined = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true;
    return false;
  }
  closest(selector: string): StubNode | undefined {
    for (let cursor: StubNode | undefined = this; cursor; cursor = cursor.parentNode) if (matches(cursor, selector)) return cursor;
    return undefined;
  }
  matches(selector: string): boolean { return matches(this, selector); }

  /** Depth-first, document order — the order `querySelectorAll` is expected to return. */
  descendants(): StubNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelector(selector: string): StubNode | null {
    return this.descendants().find((node) => matchesAny(node, selector)) ?? null;
  }
  querySelectorAll(selector: string): StubNode[] {
    return this.descendants().filter((node) => matchesAny(node, selector));
  }
}

/** `.class`, `tag`, `[attr]`, `[attr="value"]`, and any of those joined — no combinators. */
/**
 * A selector with descendant steps, matched right to left the way a browser does.
 *
 * The stub used to read only the first compound of a selector, and a tag name after a space was
 * silently dropped: `.acw-composer textarea` resolved to the `<form>` itself, so a test that wrote
 * to the composer and read the textarea back saw nothing. `:scope` and `>` are skipped — every
 * query here starts at the element it is called on, and the widget's `:scope >` lookups target
 * direct children the stub already walks first.
 */
function matches(node: StubNode, selector: string): boolean {
  const steps = selector.trim().split(/\s+(?![^[]*\])/u).filter((step) => step && step !== ">" && step !== ":scope");
  if (steps.length === 0 || !matchesCompound(node, steps.at(-1)!)) return false;
  let cursor = node.parentNode;
  for (let index = steps.length - 2; index >= 0; index -= 1) {
    while (cursor && !matchesCompound(cursor, steps[index]!)) cursor = cursor.parentNode;
    if (!cursor) return false;
    cursor = cursor.parentNode;
  }
  return true;
}

function matchesCompound(node: StubNode, selector: string): boolean {
  const parts = selector.trim().match(/(\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*)/gu) ?? [];
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part.startsWith(".")) return node.classList.contains(part.slice(1));
    if (part.startsWith("[")) {
      const [, name, , value] = /^\[([\w-]+)(="([^"]*)")?\]$/u.exec(part) ?? [];
      if (!name) return false;
      const dataName = name.startsWith("data-")
        ? name.slice(5).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
        : undefined;
      const actual = dataName !== undefined ? node.dataset[dataName] : node.getAttribute(name) ?? undefined;
      return value === undefined ? actual !== undefined : actual === value;
    }
    return node.tagName === part.toLowerCase();
  });
}

function matchesAny(node: StubNode, selector: string): boolean {
  return selector.split(",").some((part) => part.trim() && matches(node, part));
}

export interface StubDom {
  readonly document: Record<string, unknown>;
  readonly window: Record<string, unknown>;
  readonly body: StubNode;
  /** Runs every animation frame the widget has queued, repeatedly, until none are left. */
  flushFrames(): void;
  /**
   * Runs exactly one generation of queued frames.
   *
   * `flushFrames` drains chained frames to exhaustion, which fast-forwards anything that paces
   * itself across frames — measuring a reveal with it reports the end state and calls it the
   * first frame. Anything watching motion has to step.
   */
  stepFrame(): void;
}

export function createStubDom(): StubDom {
  const body = new StubNode("body");
  const documentElement = new StubNode("html");
  let frames: Array<() => void> = [];
  const create = (tagName: string) => new StubNode(String(tagName).toLowerCase());
  const document: Record<string, unknown> = {
    baseURI: "https://sample-app.example/app/",
    body, documentElement,
    createElement: create,
    createElementNS: (_namespace: string, tagName: string) => create(tagName),
    createTextNode: (text: string) => { const node = create("#text"); node.textContent = text; return node; },
    createDocumentFragment: () => create("#fragment"),
    querySelector: (selector: string) => body.querySelector(selector) ?? documentElement.querySelector(selector),
    querySelectorAll: (selector: string) => [...body.querySelectorAll(selector), ...documentElement.querySelectorAll(selector)],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    execCommand: () => true,
    // Styles are injected as a <style> element whose text nobody here reads.
    head: create("head"),
    activeElement: undefined,
    hidden: false,
    visibilityState: "visible",
  };
  // Kept, unlike the document's, so a test can raise `resize` at the widget. The `signal` option
  // is ignored: nothing here outlives the test that mounted it.
  const windowListeners = new Map<string, Set<Listener>>();
  const windowCapture = new Map<string, Set<Listener>>();
  WINDOW_CAPTURE.set(body, windowCapture);
  WINDOW_CAPTURE.set(documentElement, windowCapture);
  const window: Record<string, unknown> = {
    innerWidth: 1280, innerHeight: 900,
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: (handle: number) => { frames[handle - 1] = () => undefined; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: (type: string, listener: Listener, options?: boolean | { readonly capture?: boolean }) => {
      const listeners = options === true || (typeof options === "object" && options.capture === true) ? windowCapture : windowListeners;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => { windowListeners.get(type)?.delete(listener); windowCapture.get(type)?.delete(listener); },
    dispatchEvent: (event: { readonly type: string } & Record<string, unknown>) => {
      for (const listener of [...(windowListeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    open: () => null,
    localStorage: {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    },
  };
  return {
    document, window, body,
    flushFrames(): void {
      for (let pass = 0; pass < 20 && frames.length > 0; pass += 1) this.stepFrame();
    },
    stepFrame(): void {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame();
    },
  };
}

/** Whether a tag's text is markup rather than copy, so a reader can skip it. */
export function isStyleTag(node: StubNode): boolean { return VOID_TEXT.has(node.tagName); }
