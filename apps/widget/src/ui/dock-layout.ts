/// <reference path="./dock-host-controls.ts" />
/**
 * @internal The docked panel beside the host page rather than over it.
 *
 * A panel lying over the page hides the part of it the agent may be working on, which is why the
 * floating panel steps aside (compact mode) whenever the agent acts on the screen. Pushed, the
 * panel takes its own strip of the viewport: the page's body gives up that width through a margin
 * on the panel's side, the app lays itself out in what remains, and both stay in view.
 *
 * The body's margin moves what flows in the body. A layer the page pins to the viewport
 * (`position: fixed`) is laid out against the window instead, so a margin never reaches it: a
 * full-screen popup (Agentic's salary-sheet detail, `vfm--fixed`, inset 0) kept the whole width and
 * ran under the panel, its close and toolbar buttons with it. Such a layer is part of the page, so
 * it gives up the strip too: one that spans the window from edge to edge gets its offset on the
 * panel's side set to the strip's width (and its width capped to what remains). Narrow controls
 * pinned to the screen's edge do not span the window and stay where the page put them — above the
 * panel when the host gives it a lower layer (`dockedZIndex`), as a side panel built into the app
 * would sit. Making the body or the root their containing block (`contain`, `transform`) would move
 * those edge controls and the panel itself into the app's narrowed box instead.
 *
 * Layers are found where they matter: by hit-testing a few points inside the strip, so only one
 * that actually lies under the panel is touched, and the page's other fixed elements (menus,
 * tooltips, toasts elsewhere) are never read. Popups open after the panel docked, so the page's
 * DOM is watched while the strip is held and looked at again in the next frame, before it paints.
 *
 * Every change is followed by one `resize` event on window: grids and canvas spreadsheets lay
 * themselves out on it, and the window itself never changed size. Every inline value set on the
 * body or a layer is put back exactly as it was on release.
 *
 * A margin only narrows a body whose width is left to the layout. Agentic's shared stylesheet on
 * a host application sets `body, html { width: 100% }`: the body kept the window's width beside its margin and
 * the app ran under the panel. The body's width is therefore capped at what the strip leaves
 * (`max-width`), which changes nothing on a body that was already that wide.
 */
interface DockSavedProperty { readonly value: string; readonly priority: string }

class DockLayout {
  #body: HTMLElement | null = null;
  #property = "";
  #saved: DockSavedProperty = { value: "", priority: "" };
  #savedMaxWidth: DockSavedProperty = { value: "", priority: "" };
  #width = 0;
  #frame: number | null = null;
  /** The widget's own host: never a page layer, though it is fixed and spans the window. */
  #own: Element | null = null;
  readonly #layers = new Map<HTMLElement, { readonly offset: DockSavedProperty; readonly maxWidth: DockSavedProperty }>();
  /** The host's own controls it names to go under the pushed panel (`dockedCovers`). */
  readonly #covers = new DockHostCovers();
  #observer: MutationObserver | null = null;
  /** Cancels the look that is due, if any. */
  #cancelScan: (() => void) | null = null;

  /**
   * Gives the panel `width` pixels on `side`; repeated calls with the same width change nothing but
   * still look for page layers that appeared under the strip. `own` is the widget's host element;
   * `covers` the controls the host names to go under the panel while the strip is held
   * (ui/dock-host-controls.ts).
   */
  reserve(side: "left" | "right", width: number, own?: Element, covers?: DockHostOptions): void {
    const body = document.body;
    if (!body) return;
    const property = side === "left" ? "margin-left" : "margin-right";
    if (this.#body && (this.#body !== body || this.#property !== property)) this.release();
    if (own) this.#own = own;
    this.#covers.configure(covers);
    if (!this.#body) {
      this.#body = body;
      this.#property = property;
      this.#saved = savedProperty(body, property);
      this.#savedMaxWidth = savedProperty(body, "max-width");
      this.#watch(body);
    }
    const rounded = Math.max(0, Math.round(width));
    if (rounded !== this.#width) {
      this.#width = rounded;
      body.style.setProperty(property, `${rounded}px`, "important");
      body.style.setProperty("max-width", `calc(100% - ${rounded}px)`, "important");
      for (const layer of this.#layers.keys()) this.#yield(layer);
      this.#announce();
    }
    this.#scheduleScan();
  }

  /** Hands the strip back to the page. */
  release(): void {
    const body = this.#body;
    if (!body) return;
    restoreProperty(body, this.#property, this.#saved);
    restoreProperty(body, "max-width", this.#savedMaxWidth);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#cancelScan?.();
    this.#cancelScan = null;
    const offsetProperty = this.#offsetProperty();
    for (const [layer, saved] of this.#layers) {
      restoreProperty(layer, offsetProperty, saved.offset);
      restoreProperty(layer, "max-width", saved.maxWidth);
    }
    this.#layers.clear();
    this.#covers.release();
    this.#body = null;
    this.#width = 0;
    this.#announce();
  }

  /** `right` for a strip on the right, `left` for one on the left. */
  #offsetProperty(): "left" | "right" {
    return this.#property === "margin-left" ? "left" : "right";
  }

  /** A popup is added (or shown) after the panel docked: any change to the page, outside the widget's own, looks again. */
  #watch(body: HTMLElement): void {
    if (typeof MutationObserver !== "function") return;
    try {
      this.#observer = new MutationObserver((records) => {
        // A streamed answer changes the widget on every chunk; only the page's changes can bring a layer.
        if (records.every((record) => this.#own?.contains(record.target))) return;
        this.#scheduleScan();
      });
      this.#observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    } catch { this.#observer = null; /* A page that cannot be watched still gets the layers present when the panel docked. */ }
  }

  /**
   * Looked at in the next animation frame, before it paints: a popup that just opened never shows
   * over the panel, even for a frame. One look per frame at most, however much the page changes;
   * a look is a few hit-tests in the strip, so a page that changes on every frame pays little.
   */
  #scheduleScan(): void {
    if (this.#cancelScan || !this.#body) return;
    const run = () => {
      this.#cancelScan = null;
      this.#scan();
    };
    if (typeof window.requestAnimationFrame === "function") {
      const frame = window.requestAnimationFrame(run);
      this.#cancelScan = () => window.cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(run, 16);
      this.#cancelScan = () => clearTimeout(timer);
    }
  }

  /** Finds the page's window-wide fixed layers under the strip and has them give it up. */
  #scan(): void {
    if (!this.#body || this.#width <= 0) return;
    this.#covers.place();
    if (typeof document.elementsFromPoint !== "function") return;
    let changed = false;
    for (const layer of [...this.#layers.keys()]) if (layer.isConnected === false) this.#layers.delete(layer);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const x = this.#offsetProperty() === "right" ? viewportWidth - this.#width / 2 : this.#width / 2;
    const seen = new Set<Element>();
    for (const fraction of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      let stack: Element[];
      try { stack = document.elementsFromPoint(x, viewportHeight * fraction); } catch { continue; }
      for (const hit of stack) {
        for (let cursor: Element | null = hit; cursor && cursor !== this.#body && cursor !== document.documentElement; cursor = cursor.parentElement) {
          if (seen.has(cursor)) break;
          seen.add(cursor);
          if (this.#own?.contains(cursor)) break;
          if (this.#layers.has(cursor as HTMLElement) || !this.#spansWindow(cursor, viewportWidth)) continue;
          this.#layers.set(cursor as HTMLElement, {
            offset: savedProperty(cursor as HTMLElement, this.#offsetProperty()),
            maxWidth: savedProperty(cursor as HTMLElement, "max-width"),
          });
          this.#yield(cursor as HTMLElement);
          changed = true;
        }
      }
    }
    if (changed) this.#announce();
  }

  /** A layer pinned to the window and as wide as it: a full-screen popup, mask or app shell, never an edge control. */
  #spansWindow(element: Element, viewportWidth: number): boolean {
    let position = "";
    try { position = window.getComputedStyle(element).position; } catch { return false; }
    if (position !== "fixed") return false;
    const box = element.getBoundingClientRect();
    return box.left <= 1 && box.right >= viewportWidth - 1;
  }

  #yield(layer: HTMLElement): void {
    layer.style.setProperty(this.#offsetProperty(), `${this.#width}px`, "important");
    layer.style.setProperty("max-width", `calc(100% - ${this.#width}px)`, "important");
  }

  /** One `resize` per frame at most: a drag of the panel's edge changes the width on every pointer move. */
  #announce(): void {
    if (this.#frame !== null) return;
    const fire = () => {
      this.#frame = null;
      try { window.dispatchEvent(new Event("resize")); } catch { /* A page without events still has its layout. */ }
    };
    if (typeof window.requestAnimationFrame === "function") this.#frame = window.requestAnimationFrame(fire);
    else fire();
  }
}

function savedProperty(element: HTMLElement, property: string): DockSavedProperty {
  return { value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) };
}

function restoreProperty(element: HTMLElement, property: string, saved: DockSavedProperty): void {
  if (saved.value) element.style.setProperty(property, saved.value, saved.priority);
  else element.style.removeProperty(property);
}

/** The docked panel's options, merged into AgentChatOptions (public-api.ts). */
interface AgentChatOptions {
  /**
   * How the docked panel shares the screen. "push" (default): the page's body gives up the panel's
   * width, so the app lays itself out beside the panel and both stay visible; the panel then never
   * compacts, since it covers nothing. "overlay": the panel lies over the page's edge.
   */
  readonly dockLayout?: "push" | "overlay";
  /**
   * Stacking layer of the pushed panel. Defaults to the widget's own top layer; a host that pins its
   * own controls to the screen edge passes a value just below theirs to keep them on top, as a side
   * panel built into the app would sit.
   */
  readonly dockedZIndex?: number;
  /**
   * CSS selectors of the host page's floating controls that the pushed panel lies over, although they
   * share its layer (`dockedZIndex`) or sit just above it: while the panel is pushed they are put one
   * layer below it, and get their own layer back when it stops. For a control that would otherwise
   * cover the chat (a page's onboarding button in the screen's corner), never for the page's menus.
   * Over the page or floating, the panel is on the widget's own top layer, above them already.
   */
  readonly dockedCovers?: readonly string[];
  /**
   * CSS selectors of the host page's callouts placed against something where the panel is (a tip
   * pointing at an icon of the host's edge drawer): while the panel is open, docked, pushed or
   * floating, they stand beside it on the page's side, 16px from it, where a `showCallout` card
   * stands (the page's bottom corner beside a panel of the window's full height, else level with the
   * panel's bottom), 16px above that card while it is shown, and never wider than the window leaves
   * there (16px from the window's edge too). They go back to the host's own placement while the
   * panel is closed or compact. The name is kept from when only the pushed panel moved them.
   */
  readonly dockedMoves?: readonly string[];
  /**
   * Pixels kept free between the pushed panel and the screen edge, for controls the host pins to
   * that edge: they keep their own strip instead of lying over the panel's buttons. Default 0.
   */
  readonly dockedEdgeInset?: number;
  /**
   * The narrowest the host page still works at. The panel never pushes it narrower; a window too
   * small to hold both the page at this width and the panel at its minimum gets the panel over the
   * page's edge instead, compacting while the agent works on the screen as the floating one does.
   * Default 0: push whenever the window is wider than 520px.
   */
  readonly dockedPageMinWidth?: number;
  /** Remembers the floating/docked choice made with the header button, under storageKey. Default true. */
  readonly persistMode?: boolean;
}
