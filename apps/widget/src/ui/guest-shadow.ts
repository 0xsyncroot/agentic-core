/**
 * @internal The widget's shadow root, attached so that a press on the widget is not a press on the host page.
 *
 * Host apps close their transient layers (row menus, dropdowns, popovers) from a bubble-phase listener on `document`
 * when a press lands outside the layer. A press inside the shadow root reaches such a listener retargeted to the host
 * element, and a layer an approved press is about to use must not close because the user answered a card in the chat.
 * Presses, and the clicks they make, stop at the host element.
 *
 * A mouse or pen release stops only when its press began inside the widget: a drag the page began (a column resize, a
 * text selection) still ends when the button is let go over the panel. A drag that begins in the widget and ends over
 * the page fires its click on a shared ancestor, which the page sees. Not stopped: keys (the page's shortcuts and the
 * widget's own on `window`), focus, moves, wheel, and the `agentic-chat:*` events the widget dispatches on its host.
 * Host listeners in the capture phase still see every press; a layer closed from one is not covered.
 */

/** @internal Stopped at the host always: each fires on its press target (a touch ends on the element it began on), or on a target inside the widget only when both ends are. */
const GUEST_PRESSES = ["pointerdown", "mousedown", "touchstart", "touchend", "contextmenu", "click", "dblclick", "auxclick"] as const;
/** @internal Stopped at the host only when the press of the same pointer began inside the widget. */
const GUEST_RELEASES = ["pointerup", "mouseup"] as const;

/** @internal The pointer a press or release belongs to. */
function pressKey(event: Event): string {
  return event.type.startsWith("pointer") ? `pointer:${(event as PointerEvent).pointerId}` : "mouse";
}

/** @internal Attaches the open shadow root to `host` and keeps pointer presses on it from reaching the page, for the widget's lifetime (`signal`). */
function attachGuestShadow(host: HTMLElement, signal: AbortSignal): ShadowRoot {
  const shadow = host.attachShadow({ mode: "open" });
  // Where each pointer still held was pressed: an entry lives from its press to its release or cancel.
  const pressedInside = new Map<string, boolean>();
  let release: { readonly event: Event; readonly inside: boolean } | undefined;
  const options = { capture: true, passive: true, signal };
  // Capture on `window` sees a press and a release before the host element does.
  for (const type of ["pointerdown", "mousedown"]) {
    window.addEventListener(type, (event) => { pressedInside.set(pressKey(event), event.composedPath().includes(host)); }, options);
  }
  for (const type of GUEST_RELEASES) {
    window.addEventListener(type, (event) => {
      release = { event, inside: pressedInside.get(pressKey(event)) === true };
      pressedInside.delete(pressKey(event));
    }, options);
  }
  window.addEventListener("pointercancel", (event) => { pressedInside.delete(pressKey(event)); }, options);
  const stop = (event: Event) => event.stopPropagation();
  for (const type of GUEST_PRESSES) host.addEventListener(type, stop, { signal });
  for (const type of GUEST_RELEASES) {
    host.addEventListener(type, (event) => { if (release?.event === event && release.inside) event.stopPropagation(); }, { signal });
  }
  return shadow;
}
