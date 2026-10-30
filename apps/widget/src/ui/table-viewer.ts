/// <reference path="../shared/clipboard.ts" />
/// <reference path="../shared/markdown-table.ts" />
/// <reference path="./escape-before-host.ts" />
/**
 * @internal A Markdown table opened at full size.
 *
 * In a side panel a report table is either cramped or scrolls sideways; the button every table
 * carries (shared/markdown-table.ts) opens the same table in a modal over the widget's root, as
 * wide as the viewport allows, header pinned while the rows scroll. "Chép bảng" copies it as
 * tab-separated text, header row first, which a spreadsheet pastes into cells.
 *
 * The modal is the widget's own surface, never the page's: it is marked private (the agent's
 * hit-testing looks through it) and as an overlay (moved aside while the agent observes or acts,
 * like the panel), and the widget closes it when the chat steps aside for the agent.
 */

const TABLE_COPY_LABEL = "Chép bảng";
const TABLE_COPY_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M13.333 6.667V5a1.667 1.667 0 0 0-1.666-1.667H5A1.667 1.667 0 0 0 3.333 5v6.667A1.667 1.667 0 0 0 5 13.333h1.667m0-5a1.667 1.667 0 0 1 1.666-1.666H15a1.667 1.667 0 0 1 1.667 1.666V15A1.667 1.667 0 0 1 15 16.667H8.333A1.667 1.667 0 0 1 6.667 15z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TABLE_MODAL_TEMPLATE = `<div class="acw-table-dialog" role="dialog" aria-modal="true" aria-labelledby="acw-table-title" tabindex="-1">`
  + `<div class="acw-table-head"><strong id="acw-table-title">Bảng chi tiết</strong><span class="acw-table-meta"></span>`
  + `<button type="button" class="acw-table-copy">${TABLE_COPY_ICON}<span class="acw-table-copy-label">${TABLE_COPY_LABEL}</span></button>`
  + `<button type="button" class="acw-table-close" aria-label="Đóng bảng" title="Đóng (Esc)"><svg width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 5 5 15M5 5l10 10"></path></svg></button>`
  + `<span class="acw-sr-only acw-table-status" role="status" aria-live="polite"></span></div>`
  + `<div class="acw-table-body acw-markdown" tabindex="0"></div></div>`;

/** What can take focus inside the table itself: a link in a cell is a tab stop like any button. */
const TABLE_FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/**
 * One cell as a spreadsheet will read it once pasted. A cell starting with `=` or `@`, or with
 * `+`/`-` when it is not a figure, would be taken for a formula and run; an apostrophe makes it
 * text and does not show in the cell.
 */
function tsvCell(text: string): string {
  const value = text.replace(/\s+/gu, " ").trim();
  return /^[=@]/u.test(value) || (/^[+-]/u.test(value) && !TABLE_FIGURE.test(value)) ? `'${value}` : value;
}

/** Header row first, one line per row, cells split by tabs; a tab or line break inside a cell becomes a space. */
function tableAsTsv(table: Element): string {
  return Array.from(table.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => tsvCell(cell.textContent ?? "")).join("\t")).join("\n");
}

class TableViewer {
  readonly #modal: HTMLElement;
  readonly #dialog: HTMLElement;
  readonly #body: HTMLElement;
  readonly #meta: HTMLElement;
  readonly #status: HTMLElement;
  readonly #copy: HTMLButtonElement;
  readonly #copyLabel: HTMLElement;
  readonly #close: HTMLButtonElement;
  readonly #root: HTMLElement;
  #source: Element | null = null;
  #opener: HTMLElement | null = null;
  /** The answer the opener sits in, and which of its tables it opened: the answer re-renders when its turn ends. */
  #origin: Element | null = null;
  #openerIndex = -1;
  #copyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the press that ends in a click began on the backdrop: a selection dragged out of a cell must not close the view. */
  #pressedBackdrop = false;

  /**
   * `fallbackFocus` lists, in order, where focus goes on close when the opener's table is gone from
   * its answer (the composer, then the send/stop button); the first one enabled and shown takes it.
   * `onToggle` runs after the view opens or closes, however it closed: the widget's layer follows it.
   */
  constructor(root: HTMLElement, readonly fallbackFocus: () => readonly (HTMLElement | null | undefined)[],
    readonly onToggle: () => void, readonly writeText: (text: string) => Promise<boolean> = writeClipboardText) {
    this.#root = root;
    this.#modal = document.createElement("div");
    this.#modal.className = "acw-table-modal";
    this.#modal.hidden = true;
    this.#modal.setAttribute("data-agent-private", "");
    this.#modal.setAttribute("data-agent-overlay", "");
    this.#modal.innerHTML = TABLE_MODAL_TEMPLATE;
    const part = <T extends HTMLElement>(selector: string): T => this.#modal.querySelector<T>(selector)!;
    this.#dialog = part(".acw-table-dialog");
    this.#body = part(".acw-table-body");
    this.#meta = part(".acw-table-meta");
    this.#status = part(".acw-table-status");
    this.#copy = part<HTMLButtonElement>(".acw-table-copy");
    this.#copyLabel = part(".acw-table-copy-label");
    this.#close = part<HTMLButtonElement>(".acw-table-close");
    this.#close.addEventListener("click", () => this.close());
    this.#copy.addEventListener("click", () => void this.#copyTable());
    this.#modal.addEventListener("keydown", (event) => this.#key(event as KeyboardEvent));
    this.#modal.addEventListener("focusout", (event) => this.#keepFocus(event as FocusEvent));
    this.#modal.addEventListener("pointerdown", (event) => { this.#pressedBackdrop = event.target === this.#modal; });
    // One listener for every table, present and future: answers arrive as rendered Markdown.
    root.addEventListener("click", (event) => {
      if (event.target === this.#modal) {
        if (this.#pressedBackdrop) this.close();
        this.#pressedBackdrop = false;
        return;
      }
      const target = event.target as Element | null;
      const button = typeof target?.closest === "function" ? target.closest<HTMLElement>(".acw-table-expand") : null;
      const table = button?.closest(".acw-table-block")?.querySelector("table");
      if (button && table && !this.#modal.contains(button)) this.open(table, button);
    });
    root.append(this.#modal);
  }

  get isOpen(): boolean { return !this.#modal.hidden; }

  /** Escape closes the view when pressed inside it; focus the page took is the page's, and so is its Escape. */
  get escapeSurface(): EscapeSurface { return { element: this.#modal, isOpen: () => this.isOpen, close: () => this.close() }; }

  open(table: Element, opener: HTMLElement): void {
    this.#source = table;
    this.#opener = opener;
    this.#origin = opener.closest(".acw-markdown");
    this.#openerIndex = this.#origin ? Array.from(this.#origin.querySelectorAll(".acw-table-expand")).indexOf(opener) : -1;
    this.#body.replaceChildren(table.cloneNode(true));
    const rows = table.querySelectorAll("tr").length;
    const columns = table.querySelector("tr")?.children.length ?? 0;
    this.#meta.textContent = `${columns} cột · ${Math.max(0, rows - 1)} dòng`;
    this.#resetCopy();
    this.#modal.hidden = false;
    this.#body.scrollTop = 0;
    this.#close.focus();
    this.onToggle();
  }

  /** Hides the modal and gives focus back to the button that opened it. Safe to call when closed. */
  close(): void {
    if (this.#modal.hidden) return;
    this.#modal.hidden = true;
    this.#body.replaceChildren();
    this.#source = null;
    this.#resetCopy();
    this.#returnFocus();
    this.onToggle();
  }

  /**
   * Back to the button that opened the view; when the answer was rendered again meanwhile (its
   * turn ended), to the same table's new button; else to the first usable fallback. The composer
   * is disabled while a turn runs, which is exactly when an answer re-renders.
   */
  #returnFocus(): void {
    const opener = this.#opener;
    const origin = this.#origin;
    this.#opener = null;
    this.#origin = null;
    let target: HTMLElement | null | undefined;
    if (opener && !origin) target = opener.isConnected !== false ? opener : undefined;
    else if (opener && origin && origin.isConnected !== false) {
      target = origin.contains(opener) ? opener : origin.querySelectorAll<HTMLElement>(".acw-table-expand")[this.#openerIndex];
    }
    target ??= this.fallbackFocus().find((node) => node && !(node as HTMLButtonElement).disabled && !node.hidden);
    target?.focus();
  }

  /**
   * Focus that slips out of the view to nowhere, or to another part of this widget, comes back to
   * the dialog so Escape still reaches it. Focus the page takes — the user, or the agent working
   * on the page while the chat stays open — is the page's and is never pulled back. Checked a
   * moment later, not at once: the clipboard's selection fallback borrows focus for one copy.
   */
  #keepFocus(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (this.#modal.hidden || (next && (this.#modal.contains(next) || !this.#root.contains(next)))) return;
    setTimeout(() => {
      if (this.#modal.hidden) return;
      const tree = typeof this.#modal.getRootNode === "function" ? this.#modal.getRootNode() as Document | ShadowRoot : undefined;
      const inside = tree?.activeElement ?? null;
      const page = document.activeElement;
      const nowhere = !page || page === document.body || page === document.documentElement;
      if (inside ? !this.#modal.contains(inside) : nowhere) this.#dialog.focus();
    }, 0);
  }

  /** Tab only: Escape is taken before the host page can stop it (escape-before-host.ts), through `escapeSurface`. */
  #key(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const inside = Array.from(this.#body.querySelectorAll<HTMLElement>(TABLE_FOCUSABLE)).filter((node) => node.getAttribute("tabindex") !== "-1");
    const stops: HTMLElement[] = [this.#copy, this.#close, this.#body, ...inside];
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (event.shiftKey && (event.target === first || event.target === this.#dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
  }

  async #copyTable(): Promise<void> {
    const table = this.#source;
    if (!table) return;
    const copied = await this.writeText(tableAsTsv(table));
    if (this.#source !== table) return;
    // The selection fallback moved focus out of the view; Escape must keep working after a copy.
    this.#copy.focus();
    this.#copy.dataset.copyState = copied ? "success" : "failed";
    this.#copyLabel.textContent = copied ? "Đã chép" : "Không chép được";
    this.#status.textContent = copied ? "Đã chép bảng" : "Không chép được bảng";
    clearTimeout(this.#copyTimer);
    this.#copyTimer = setTimeout(() => this.#resetCopy(), 1600);
  }

  #resetCopy(): void {
    clearTimeout(this.#copyTimer);
    this.#copyTimer = undefined;
    delete this.#copy.dataset.copyState;
    this.#copyLabel.textContent = TABLE_COPY_LABEL;
    this.#status.textContent = "";
  }
}
