/// <reference path="../public-api-menu.ts" />
/**
 * @internal The host-declared toggles in the header "…" menu, the inline confirmation that guards
 * switching one on, and the header badge. Generic: every word shown comes from the host.
 */
interface HeaderMenuHooks {
  readonly sessionId: () => string;
  /** Closes the "…" menu after a choice. */
  readonly closeMenu: () => void;
  readonly decide: (event: AgentChatMenuToggleEvent) => boolean | Promise<boolean>;
}

class HeaderMenuToggles {
  readonly #header: HTMLElement;
  readonly #menu: HTMLElement;
  readonly #badge: HTMLElement;
  readonly #hooks: HeaderMenuHooks;
  readonly #items = new Map<string, { item: HTMLButtonElement; confirm?: AgentChatMenuToggleConfirm; busy: boolean }>();
  readonly #baseBadge: string;
  #confirm: HTMLElement | null = null;

  constructor(header: HTMLElement, menu: HTMLElement, badge: HTMLElement, toggles: readonly AgentChatMenuToggle[], hooks: HeaderMenuHooks) {
    this.#header = header;
    this.#menu = menu;
    this.#badge = badge;
    this.#hooks = hooks;
    this.#baseBadge = badge.hidden ? "" : badge.textContent ?? "";
    for (const toggle of toggles) this.#add(toggle);
  }

  #add(toggle: AgentChatMenuToggle): void {
    if (!toggle.id || this.#items.has(toggle.id)) return;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "acw-menu-toggle";
    item.setAttribute("role", "menuitemcheckbox");
    item.dataset.toggleId = toggle.id;
    const copy = document.createElement("span");
    copy.className = "acw-menu-toggle-copy";
    const label = document.createElement("span");
    label.textContent = toggle.label;
    copy.append(label);
    if (toggle.description) {
      const description = document.createElement("small");
      description.textContent = toggle.description;
      copy.append(description);
    }
    const mark = document.createElement("span");
    mark.className = "acw-menu-toggle-mark";
    mark.setAttribute("aria-hidden", "true");
    item.append(copy, mark);
    this.#items.set(toggle.id, { item, busy: false, ...(toggle.confirmOn ? { confirm: toggle.confirmOn } : {}) });
    this.#paint(item, toggle.checked, toggle.disabled === true);
    item.addEventListener("click", () => this.#choose(toggle.id));
    this.#menu.append(item);
  }

  #paint(item: HTMLButtonElement, checked: boolean, disabled: boolean): void {
    item.setAttribute("aria-checked", String(checked));
    item.setAttribute("aria-disabled", String(disabled));
    item.disabled = disabled;
  }

  set(id: string, state: { readonly checked?: boolean; readonly disabled?: boolean; readonly visible?: boolean }): void {
    const entry = this.#items.get(id);
    if (!entry) return;
    this.#paint(entry.item, state.checked ?? entry.item.getAttribute("aria-checked") === "true", state.disabled ?? entry.item.disabled);
    if (state.visible !== undefined) entry.item.hidden = !state.visible;
  }

  setBadge(label: string | null, title?: string): void {
    const text = label?.trim() || this.#baseBadge;
    this.#badge.textContent = text;
    this.#badge.hidden = !text;
    if (title && label?.trim()) this.#badge.title = title;
    else this.#badge.removeAttribute("title");
  }

  #choose(id: string): void {
    const entry = this.#items.get(id);
    if (!entry || entry.busy || entry.item.disabled) return;
    this.#hooks.closeMenu();
    const checked = entry.item.getAttribute("aria-checked") !== "true";
    if (checked && entry.confirm) this.#ask(id, entry.confirm);
    else void this.#apply(id, checked);
  }

  async #apply(id: string, checked: boolean): Promise<void> {
    const entry = this.#items.get(id);
    if (!entry) return;
    entry.busy = true;
    this.#paint(entry.item, checked, entry.item.disabled);
    let keep = false;
    try { keep = (await this.#hooks.decide({ id, checked, sessionId: this.#hooks.sessionId() })) === true; } catch { keep = false; }
    entry.busy = false;
    // A host that set the state itself (setMenuToggle) while deciding keeps what it set.
    if (!keep && entry.item.getAttribute("aria-checked") === String(checked)) this.#paint(entry.item, !checked, entry.item.disabled);
  }

  #ask(id: string, text: AgentChatMenuToggleConfirm): void {
    this.dismissConfirm();
    const box = document.createElement("div");
    box.className = "acw-menu-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", text.title);
    const title = document.createElement("strong");
    title.textContent = text.title;
    const message = document.createElement("p");
    message.textContent = text.message;
    const actions = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "acw-menu-confirm-cancel";
    cancel.textContent = text.cancelLabel;
    cancel.addEventListener("click", () => this.dismissConfirm());
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "acw-menu-confirm-accept";
    accept.textContent = text.confirmLabel;
    accept.addEventListener("click", () => { this.dismissConfirm(); void this.#apply(id, true); });
    actions.append(cancel, accept);
    box.append(title, message, actions);
    this.#header.append(box);
    this.#confirm = box;
    accept.focus();
  }

  dismissConfirm(): void {
    this.#confirm?.remove();
    this.#confirm = null;
  }
}

/** @internal The three built-in header-menu entries; wired here so the controller does not grow. */
function bindHeaderMenuEntries(scope: ParentNode, entries: Readonly<Record<"history" | "search" | "new", () => void>>, closeMenu: () => void): void {
  for (const name of ["history", "search", "new"] as const) {
    scope.querySelector<HTMLButtonElement>(`.acw-menu-${name}`)?.addEventListener("click", () => { closeMenu(); entries[name](); });
  }
}
