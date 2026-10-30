/**
 * @internal Escape for the widget's own surfaces, taken before the host page can stop it.
 *
 * A host's shortcut library may listen for keydown on `document` in the capture phase and stop
 * Escape there; capture on `document` runs before any listener inside the widget's shadow root, so
 * every Escape handler inside would be starved. One listener on `window` in the
 * capture phase runs before `document`'s; the shadow root is open, so `composedPath()` shows which
 * of the widget's surfaces the key was pressed in.
 *
 * Only Escape, and only when it was pressed inside an open surface: any other key, and Escape
 * pressed on the page, is the page's (stopping a key at `window` ends its whole dispatch, the
 * widget's own listeners included). A host listener on `window` in the capture phase registered
 * before the widget still runs first.
 */

/** @internal One surface Escape closes: open, and the key pressed inside `element`. */
interface EscapeSurface {
  readonly element: Node;
  isOpen(): boolean;
  close(): void;
}

/**
 * @internal Listens for the widget's lifetime (`signal`). `surfaces` are in the order Escape closes
 * them when more than one is open around the focus: the first open one the key was pressed in
 * closes, alone. The key then stops: a host that closes its own panel on Escape must not also act
 * on the press that closed the chat's table or menu.
 */
function listenEscapeBeforeHost(signal: AbortSignal, surfaces: readonly EscapeSurface[]): void {
  window.addEventListener("keydown", (event) => {
    // The Escape that ends an IME composition cancels the composition, nothing else.
    if (event.key !== "Escape" || event.isComposing) return;
    const path = event.composedPath();
    const surface = surfaces.find((entry) => entry.isOpen() && path.includes(entry.element));
    if (!surface) return;
    event.preventDefault();
    event.stopPropagation();
    surface.close();
  }, { capture: true, signal });
}
