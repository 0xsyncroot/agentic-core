/// <reference path="./dock-host-controls.ts" />
/**
 * @internal A card the host asks the widget to show beside the assistant (showCallout), placed by
 * where the assistant is: above its launcher while closed, beside its panel while open.
 *
 * It lives in the widget's own root, not the host page, so the host never fights the page's
 * layers or its own re-placement for it, and it shares the launcher's layer without a z-index of
 * its own. Placement is pure arithmetic over boxes the controller reports (`CalloutGeometry`), run
 * again whenever any of them can have moved.
 *
 * The host's own callouts it names (`dockedMoves`, ui/dock-host-controls.ts) are placed by the same
 * arithmetic at the same moments: beside the open panel, and on this card while it is shown there.
 */
interface CalloutBox { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** @internal What the card is placed against, read fresh at every placement. */
interface CalloutGeometry {
  /** Which edge the assistant lives on; the card sits on the side facing the page. */
  readonly side: "left" | "right";
  /** The compact status takes the launcher's neighbourhood while it is shown. */
  readonly compact: boolean;
  /** The open panel's box, or null while it is closed. */
  readonly panel: CalloutBox | null;
  /** The panel is docked, pushed or over the page: it runs the window's full height, so the card keeps to the page's corner. */
  readonly docked: boolean;
  /** The visible launcher's box, or null when there is none. */
  readonly launcher: CalloutBox | null;
}

interface CalloutHandlers {
  readonly closeLabel: string;
  readonly geometry: () => CalloutGeometry;
  /** Runs synchronously inside the click: a host opening a file picker needs the user's gesture. */
  readonly action: (event: { readonly id: string; readonly actionId: string }) => void;
  readonly dismiss: (event: { readonly id: string }) => void;
}

/** Space between the card and what it points at, and between the card and the viewport's edge. */
const CALLOUT_GAP = 12;
const CALLOUT_PANEL_GAP = 16;
const CALLOUT_DOCKED_BOTTOM = 40;
const CALLOUT_EDGE = 8;
const CALLOUT_MAX_WIDTH = 388;
const CALLOUT_MAX_ACTIONS = 3;

/** @internal Where a card beside the open panel goes: from the window's edge on `side`, `offset` to its near edge. */
interface BesidePanel {
  readonly side: "left" | "right";
  readonly offset: number;
  readonly bottom: number;
  /** The widest a card fits between the panel and the window's other edge, a gap on each side. */
  readonly maxWidth: number;
}

/** Null while nothing stands beside the panel: it is closed, or compact. */
function besidePanel(geometry: CalloutGeometry, viewport: { readonly width: number; readonly height: number }): BesidePanel | null {
  const panel = geometry.panel;
  if (geometry.compact || !panel) return null;
  // The panel's far side: its left edge when it lives on the right, so the card goes to the page's side.
  const right = geometry.side === "right";
  return {
    side: geometry.side,
    offset: right ? viewport.width - panel.left + CALLOUT_PANEL_GAP : panel.right + CALLOUT_PANEL_GAP,
    bottom: geometry.docked ? CALLOUT_DOCKED_BOTTOM : Math.max(CALLOUT_PANEL_GAP, viewport.height - panel.bottom),
    maxWidth: Math.max(0, (right ? panel.left : viewport.width - panel.right) - 2 * CALLOUT_PANEL_GAP),
  };
}

class CalloutView {
  readonly #root: HTMLElement;
  readonly #handlers: CalloutHandlers;
  /** The host's own callouts that stand beside the panel too. */
  readonly #moves: DockHostMoves;
  #destroyed = false;
  #element: HTMLElement | null = null;
  #title: HTMLElement | null = null;
  #body: HTMLElement | null = null;
  #actions: HTMLElement | null = null;
  #id = "";

  constructor(root: HTMLElement, handlers: CalloutHandlers, moves: readonly string[] = []) {
    this.#root = root;
    this.#handlers = handlers;
    this.#moves = new DockHostMoves(moves);
  }

  get id(): string | undefined { return this.#element ? this.#id : undefined; }

  show(callout: AgentChatCallout): void {
    if (typeof callout?.id !== "string" || callout.id.length < 1 || callout.id.length > 64) throw new TypeError("callout id must be 1-64 characters");
    if (typeof callout.title !== "string" || typeof callout.markdown !== "string") throw new TypeError("callout title and markdown must be strings");
    // The same id is the same card getting new words: the node stays, so nothing flashes or re-enters.
    const kept = this.#element && this.#id === callout.id;
    // The buttons are rebuilt below, which drops keyboard focus held on one of them.
    const focused = kept ? this.#focusedButton() : undefined;
    if (!kept) this.#build(callout.id);
    this.#id = callout.id;
    this.#element!.setAttribute("aria-label", callout.title);
    this.#title!.textContent = callout.title;
    this.#body!.innerHTML = renderMarkdown(callout.markdown);
    this.#paintActions(callout);
    this.place();
    if (focused !== undefined) this.#restoreFocus(focused);
  }

  /** What holds focus inside the card, undefined when focus is elsewhere. */
  #focusedButton(): { readonly close: true } | { readonly action: string } | undefined {
    const root = this.#element!.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    if (!active || !this.#element!.contains(active)) return undefined;
    if (active.classList.contains("acw-callout-close")) return { close: true };
    const action = (active as HTMLElement).dataset.actionId;
    return action === undefined ? undefined : { action };
  }

  /** The same button when it is still there, else the primary action, else the close button. */
  #restoreFocus(was: { readonly close: true } | { readonly action: string }): void {
    const element = this.#element!;
    const close = element.querySelector<HTMLButtonElement>(".acw-callout-close");
    if ("close" in was && close) { close.focus(); return; }
    const actions = [...element.querySelectorAll<HTMLButtonElement>(".acw-callout-action")];
    const target = ("action" in was ? actions.find((button) => button.dataset.actionId === was.action) : undefined)
      ?? actions.find((button) => button.dataset.primary === "true")
      ?? close;
    target?.focus();
  }

  hide(id?: string): void {
    if (!this.#element || (id !== undefined && id !== this.#id)) return;
    this.#element.remove();
    this.#element = this.#title = this.#body = this.#actions = null;
    // The host's callouts stood on this card: they take the corner again.
    if (this.#moves.named) this.place();
  }

  destroy(): void {
    this.#destroyed = true;
    this.hide();
    this.#moves.release();
  }

  /** Puts the card where the assistant is now, and the host's named callouts beside the panel with it. */
  place(): void {
    const element = this.#element;
    if (this.#destroyed || (!element && !this.#moves.named)) return;
    const geometry = this.#handlers.geometry();
    // A classic page scrollbar is part of the window's width, but fixed offsets start at its inner edge.
    const viewport = { width: document.documentElement?.clientWidth || window.innerWidth, height: window.innerHeight };
    const beside = besidePanel(geometry, viewport);
    const height = element ? this.#placeCard(element, geometry, beside, viewport) : 0;
    // The same corner for both would put the host's callout over this card: it stands on it instead.
    this.#moves.place(beside && height > 0 ? { ...beside, bottom: beside.bottom + height + CALLOUT_PANEL_GAP } : beside);
  }

  /** Places the card, hidden when the window leaves no room for it; its height when it stands beside the panel, else 0. */
  #placeCard(element: HTMLElement, geometry: CalloutGeometry, beside: BesidePanel | null, viewport: { readonly width: number; readonly height: number }): number {
    // A hidden card measures as zero, so it is shown for the measuring and hidden again below if it must be.
    element.hidden = false;
    const width = element.offsetWidth || Math.min(CALLOUT_MAX_WIDTH, viewport.width - 32);
    const height = element.offsetHeight || 0;
    const style = element.style;
    const at = (side: "left" | "right", offset: number, vertical: { readonly bottom: number } | { readonly top: number }) => {
      style.left = side === "left" ? `${offset}px` : "auto";
      style.right = side === "right" ? `${offset}px` : "auto";
      style.top = "top" in vertical ? `${vertical.top}px` : "auto";
      style.bottom = "bottom" in vertical ? `${vertical.bottom}px` : "auto";
    };
    let tail: "none" | "down" | "up" = "none";
    let visible = true;
    if (geometry.compact) {
      visible = false;
    } else if (beside) {
      visible = width <= beside.maxWidth;
      if (visible) at(beside.side, beside.offset, { bottom: beside.bottom });
    } else if (geometry.launcher) {
      const launcher = geometry.launcher;
      // Right edges line up, then the card is pulled back inside the window on both sides.
      const right = Math.min(Math.max(CALLOUT_EDGE, viewport.width - launcher.right), viewport.width - width - CALLOUT_EDGE);
      const above = launcher.top - CALLOUT_GAP - height >= CALLOUT_EDGE;
      at("right", right, above ? { bottom: viewport.height - launcher.top + CALLOUT_GAP } : { top: launcher.bottom + CALLOUT_GAP });
      tail = above ? "down" : "up";
      const centre = (launcher.left + launcher.right) / 2 - (viewport.width - right - width);
      element.style.setProperty("--acw-callout-tail-x", `${Math.round(Math.min(width - 24, Math.max(24, centre)))}px`);
    } else {
      at(geometry.side, 16, { bottom: 16 });
    }
    element.dataset.tail = tail;
    element.hidden = !visible;
    return beside && visible ? height : 0;
  }

  #build(id: string): void {
    this.#element?.remove();
    const element = document.createElement("section");
    element.className = "acw-callout";
    element.setAttribute("role", "region");
    element.setAttribute("aria-live", "polite");
    element.dataset.calloutId = id;
    const title = document.createElement("h2");
    title.className = "acw-callout-title";
    const body = document.createElement("div");
    body.className = "acw-callout-body";
    const actions = document.createElement("div");
    actions.className = "acw-callout-actions";
    const tail = document.createElement("span");
    tail.className = "acw-callout-tail";
    tail.setAttribute("aria-hidden", "true");
    element.append(title, body, actions, tail);
    this.#root.append(element);
    this.#element = element;
    this.#title = title;
    this.#body = body;
    this.#actions = actions;
  }

  #paintActions(callout: AgentChatCallout): void {
    const element = this.#element!;
    element.querySelector(".acw-callout-close")?.remove();
    if (callout.dismissible !== false) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "acw-callout-close";
      close.setAttribute("aria-label", this.#handlers.closeLabel);
      close.innerHTML = `<svg width="16" height="16" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M14.5 5.5l-9 9m0-9 9 9"></path></svg>`;
      close.addEventListener("click", () => {
        const id = this.#id;
        this.hide();
        this.#handlers.dismiss({ id });
      });
      element.append(close);
    }
    const buttons = (callout.actions ?? []).slice(0, CALLOUT_MAX_ACTIONS).map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "acw-callout-action";
      if (action.primary) button.dataset.primary = "true";
      button.dataset.actionId = action.id;
      button.textContent = action.label;
      button.addEventListener("click", () => this.#handlers.action({ id: this.#id, actionId: action.id }));
      return button;
    });
    this.#actions!.replaceChildren(...buttons);
    this.#actions!.hidden = buttons.length === 0;
  }
}
