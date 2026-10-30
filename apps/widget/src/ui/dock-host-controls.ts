/**
 * @internal The host page's own floating controls that lie where the panel is, named by the host
 * because nothing on the page says what they are for (ui/dock-layout.ts finds the page's
 * full-screen layers by itself; these are small and sit where the host put them).
 *
 * - `covers` (DockHostCovers): controls on the pushed panel's layer or just above it that lie over
 *   the chat (an onboarding button in the screen's corner). While the panel is pushed they go one
 *   layer below it. Over the page or floating, the panel keeps the widget's own top layer, already
 *   above them; a rule there would have to name a layer, and one just under the widget's would lift
 *   them over the page's own menus and popups.
 * - `moves` (DockHostMoves): callouts the host places against something under the panel (a tip
 *   pointing at an icon of its edge drawer), which then lie over the chat or under it. While the
 *   panel is open, in any mode, they stand beside it on the page's side, where the widget's own
 *   card stands (ui/callout.ts places both from the same arithmetic).
 *
 * Both are rules in a sheet of the widget's own, adopted by the document while they apply, never
 * values written on the controls: a host callout that places itself again whenever its inline style
 * changes rewrites an inline value set against it in every frame. An `!important` rule wins over the host's inline placement
 * without touching it, reaches the controls the host shows later by itself, and goes with the sheet.
 */
interface DockHostOptions {
  readonly covers: readonly string[];
  /** The pushed panel's layer; covers need one, the widget's own top layer leaves nothing to cover. */
  readonly zIndex?: number;
}

/** One sheet of rules over the host's controls; the same rules twice write nothing, none release it. */
class DockHostSheet {
  #rules = "";
  #adopted: CSSStyleSheet | null = null;
  #element: HTMLStyleElement | null = null;

  write(rules: string): void {
    if (!rules) { this.release(); return; }
    if (rules === this.#rules) return;
    this.#rules = rules;
    // A constructed sheet adds no element to the page (nothing for the page's own observers to see)
    // and is not an inline style a strict content-security policy would refuse.
    if (!this.#adopted && !this.#element && typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {
      try {
        this.#adopted = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.#adopted];
      } catch { this.#adopted = null; }
    }
    if (this.#adopted) {
      try { this.#adopted.replaceSync(rules); return; } catch { /* Falls back to an element below. */ }
    }
    if (!this.#element) {
      this.#element = document.createElement("style");
      this.#element.dataset.gatewayAgentDock = "";
      document.head.append(this.#element);
    }
    this.#element.textContent = rules;
  }

  release(): void {
    this.#rules = "";
    if (this.#adopted) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== this.#adopted);
    this.#element?.remove();
    this.#adopted = null;
    this.#element = null;
  }
}

/** The host's controls that go under the pushed panel; held by ui/dock-layout.ts with the strip. */
class DockHostCovers {
  readonly #sheet = new DockHostSheet();
  #options: DockHostOptions = { covers: [] };

  configure(options: DockHostOptions | undefined): void {
    this.#options = options ?? { covers: [] };
  }

  place(): void {
    const { covers, zIndex } = this.#options;
    this.#sheet.write(zIndex === undefined ? "" : validSelectors(covers).map((selector) => `${selector} { z-index: ${zIndex - 1} !important; }`).join("\n"));
  }

  release(): void { this.#sheet.release(); }
}

/** The host's callouts that stand beside the open panel; placed by ui/callout.ts with the widget's own card. */
class DockHostMoves {
  readonly #sheet = new DockHostSheet();
  readonly #selectors: readonly string[];

  constructor(selectors: readonly string[]) {
    this.#selectors = validSelectors(selectors);
  }

  get named(): boolean { return this.#selectors.length > 0; }

  /**
   * `at` is where a card beside the panel goes; null (closed, compact) gives the host its own placement back.
   * A window too narrow for the card there narrows it rather than letting it run past the window's edge.
   */
  place(at: BesidePanel | null): void {
    if (!at) { this.#sheet.release(); return; }
    const far = at.side === "right" ? "left" : "right";
    this.#sheet.write(this.#selectors.map((selector) => `${selector} { ${far}: auto !important; top: auto !important; `
      + `${at.side}: ${at.offset}px !important; bottom: ${at.bottom}px !important; max-width: ${at.maxWidth}px !important; }`).join("\n"));
  }

  release(): void { this.#sheet.release(); }
}

/** The host's selectors the page can parse, one rule each: a selector never carries a block of its own. */
function validSelectors(selectors: readonly string[]): string[] {
  return selectors.filter((selector) => {
    if (/[{}]/.test(selector)) return false;
    try { document.querySelector(selector); return true; } catch { return false; }
  });
}
