/**
 * @internal The greeting's question typed out, one character at a time, as the welcome is shown.
 *
 * What is already on screen is kept as far as it agrees with the new text, so a greeting the host
 * resolves a moment later (the user's name, the salutation) carries on typing instead of starting
 * over, and a refresh to the same words does not type them again. With reduced motion asked for,
 * or no `matchMedia` to ask, the text is written at once. Aborting stops where it is; whoever
 * aborted is about to write the element again or drop it.
 */
function typeWelcomeText(target: HTMLElement, text: string, signal: AbortSignal, stepMs = 40): void {
  const characters = graphemes(text);
  const shown = graphemes(target.textContent ?? "");
  let index = 0;
  while (index < shown.length && index < characters.length && shown[index] === characters[index]) index += 1;
  const reduced = typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (signal.aborted || reduced || index === characters.length) {
    target.textContent = text;
    delete target.dataset.typing;
    return;
  }
  target.textContent = characters.slice(0, index).join("");
  target.dataset.typing = "true";
  let timer = 0;
  const tick = () => {
    if (signal.aborted) return;
    index += 1;
    target.textContent = characters.slice(0, index).join("");
    if (index < characters.length) timer = window.setTimeout(tick, stepMs);
    else delete target.dataset.typing;
  };
  timer = window.setTimeout(tick, stepMs);
  signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
}

/** Whole user-perceived characters: a letter and its tone mark appear together, never one after the other. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter("vi", { granularity: "grapheme" }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/**
 * A row of suggestion chips scrolls sideways under an ordinary mouse wheel, as a touchpad already
 * does, and follows the mouse when the user holds it and drags. A drag ends with a click on the
 * chip it started on; that click is not a choice, so it is stopped before the chip sees it.
 */
function scrollSideways(row: HTMLElement): void {
  row.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });
  let start: { readonly id: number; readonly x: number; readonly left: number } | null = null;
  let dragged = false;
  row.addEventListener("pointerdown", (event) => {
    dragged = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || row.scrollWidth <= row.clientWidth) return;
    start = { id: event.pointerId, x: event.clientX, left: row.scrollLeft };
  });
  row.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const moved = event.clientX - start.x;
    if (!dragged && Math.abs(moved) < 5) return;
    if (!dragged) {
      dragged = true;
      row.dataset.dragging = "true";
      try { row.setPointerCapture(event.pointerId); } catch { /* Capture only keeps the drag past the row's edge. */ }
    }
    row.scrollLeft = start.left - moved;
  });
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    delete row.dataset.dragging;
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
  row.addEventListener("click", (event) => {
    if (!dragged) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
