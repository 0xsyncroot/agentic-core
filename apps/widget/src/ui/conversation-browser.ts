/// <reference path="./session-history-group.ts" />
/// <reference path="./escape-before-host.ts" />
/** @internal Session navigation shares the transport identity; it never starts or cancels a turn. */
class ConversationBrowser {
  readonly #history: HTMLElement;
  readonly #list: HTMLElement;
  readonly #historyQuery: HTMLInputElement;
  #filter = "";
  #filterTimer: ReturnType<typeof setTimeout> | undefined;
  #groups = new Map<string, HTMLElement>();
  #groupDate = new Date();
  readonly #retry: HTMLButtonElement;
  readonly #status: HTMLElement;
  readonly #search: HTMLElement;
  readonly #query: HTMLInputElement;
  readonly #count: HTMLElement;
  #controller: AbortController | undefined;
  #cursor: string | undefined;
  #loading = false;
  #failed = false;
  #cursors = new Set<string>();
  #skeleton: HTMLElement | undefined;
  #resize: ResizeObserver | undefined;
  #seen = new Set<string>();
  #matches: HTMLElement[] = [];
  #match = -1;
  constructor(readonly panel: HTMLElement, readonly conversation: HTMLElement, readonly transport: AgentChatTransport,
    readonly context: (signal: AbortSignal) => AgentChatOperationContext,
    readonly select: (sessionId: string) => Promise<void>, readonly pending: () => boolean, readonly onSearch: () => void) {
    this.#history = document.createElement("section");
    this.#history.className = "acw-session-browser";
    this.#history.hidden = true;
    this.#history.setAttribute("aria-label", "Lịch sử trò chuyện");
    this.#history.innerHTML = `<div class="acw-browser-heading"><button type="button" aria-label="Trở về cuộc trò chuyện"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m12.5 5-5 5 5 5"></path></svg></button><strong>Lịch sử trò chuyện</strong></div><label class="acw-session-filter"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m17.5 17.5-5-5m-10-4.167a5.834 5.834 0 1 0 11.667 0 5.834 5.834 0 0 0-11.667 0"></path></svg><input type="search" maxlength="180" placeholder="Tìm cuộc trò chuyện…" aria-label="Tìm theo tên cuộc trò chuyện"></label><div class="acw-session-list"></div><p class="acw-browser-status" role="status"></p><button type="button" class="acw-sessions-retry" hidden>Thử lại</button>`;
    this.#historyQuery = this.#history.querySelector<HTMLInputElement>(".acw-session-filter input")!;
    this.#historyQuery.addEventListener("input", () => {
      this.#resetList();
      this.#filter = this.#historyQuery.value.trim();
      this.#showSkeleton();
      this.#status.textContent = "Đang tìm cuộc trò chuyện…";
      this.#filterTimer = setTimeout(() => { this.#filterTimer = undefined; void this.#load(); }, 250);
    });
    this.#list = this.#history.querySelector<HTMLElement>(".acw-session-list")!;
    this.#retry = this.#history.querySelector<HTMLButtonElement>(".acw-sessions-retry")!;
    this.#status = this.#history.querySelector<HTMLElement>(".acw-browser-status")!;
    this.#history.querySelector(".acw-browser-heading button")!.addEventListener("click", () => this.close());
    this.#retry.addEventListener("click", () => void this.#load());
    this.#list.addEventListener("scroll", () => this.#loadNearEnd(), { passive: true });
    this.#search = document.createElement("div");
    this.#search.className = "acw-message-search";
    this.#search.hidden = true;
    this.#search.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 20 20" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m17.5 17.5-5-5m-10-4.167a5.834 5.834 0 1 0 11.667 0 5.834 5.834 0 0 0-11.667 0"></path></svg><input type="search" placeholder="Tìm trong cuộc trò chuyện" aria-label="Tìm trong cuộc trò chuyện"><span role="status"></span><button type="button" aria-label="Kết quả trước">↑</button><button type="button" aria-label="Kết quả tiếp">↓</button><button type="button" aria-label="Đóng tìm kiếm">×</button>`;
    this.#query = this.#search.querySelector("input")!;
    this.#count = this.#search.querySelector("span")!;
    const buttons = this.#search.querySelectorAll("button");
    buttons[0]!.addEventListener("click", () => this.#move(-1));
    buttons[1]!.addEventListener("click", () => this.#move(1));
    buttons[2]!.addEventListener("click", () => this.close());
    this.#query.addEventListener("input", () => this.#find());
    this.#query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.#move(event.shiftKey ? -1 : 1); }
    });
    panel.insertBefore(this.#search, conversation);
    panel.append(this.#history);
  }
  /** Escape inside the search bar or the history closes it (escape-before-host.ts), the search first. */
  get escapeSurfaces(): readonly EscapeSurface[] {
    return [this.#search, this.#history].map((element) => ({ element, isOpen: () => !element.hidden, close: () => this.close() }));
  }
  close(): void {
    clearTimeout(this.#filterTimer);
    this.#filterTimer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#loading = false;
    this.#resize?.disconnect();
    this.#skeleton?.remove();
    this.#list.setAttribute("aria-busy", "false");
    this.#history.hidden = true;
    this.#search.hidden = true;
    delete this.panel.dataset.search;
    delete this.panel.dataset.browser;
    this.#clearMarks();
  }
  openHistory(): void {
    this.close();
    this.#history.hidden = false;
    this.panel.dataset.browser = "history";
    this.#historyQuery.value = "";
    this.#filter = "";
    this.#resetList();
    this.#historyQuery.disabled = this.pending();
    if (this.pending()) {
      this.#status.textContent = "Trợ lý đang xử lý. Có thể mở phiên khác sau khi lượt này kết thúc.";
      this.#retry.hidden = true;
      return;
    }
    if (typeof ResizeObserver !== "undefined") {
      this.#resize ??= new ResizeObserver(() => this.#loadNearEnd());
      this.#resize.observe(this.#list);
    }
    void this.#load();
    this.#historyQuery.focus();
  }
  #resetList(): void {
    clearTimeout(this.#filterTimer);
    this.#filterTimer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#loading = false;
    this.#failed = false;
    this.#cursors.clear();
    this.#retry.hidden = true;
    this.#list.replaceChildren();
    this.#list.scrollTop = 0;
    this.#seen.clear();
    this.#cursor = undefined;
    this.#groups.clear();
    this.#groupDate = new Date();
  }
  openSearch(): void {
    this.close();
    this.#search.hidden = false;
    this.panel.dataset.search = "true";
    this.onSearch();
    this.#query.focus();
    this.#find();
  }
  #loadNearEnd(): void {
    if (!this.#cursor || this.#failed || this.#loading || this.#history.hidden || this.#list.clientHeight === 0) return;
    if (this.#list.scrollHeight - this.#list.scrollTop - this.#list.clientHeight < 160) void this.#load();
  }
  #showSkeleton(): void {
    this.#skeleton?.remove();
    this.#skeleton = document.createElement("div");
    this.#skeleton.className = "acw-session-skeleton";
    this.#skeleton.setAttribute("aria-hidden", "true");
    for (let index = 0; index < (this.#seen.size ? 3 : 7); index++) {
      const row = document.createElement("div");
      row.className = "acw-session-placeholder";
      row.innerHTML = '<span class="acw-skeleton-line"></span><span class="acw-skeleton-line"></span>';
      this.#skeleton.append(row);
    }
    this.#list.append(this.#skeleton);
  }
  async #load(): Promise<void> {
    if (this.#loading || this.#history.hidden) return;
    this.#loading = true;
    const controller = new AbortController();
    this.#controller = controller;
    this.#retry.disabled = true;
    this.#retry.hidden = true;
    this.#failed = false;
    this.#list.setAttribute("aria-busy", "true");
    this.#showSkeleton();
    this.#status.textContent = this.#seen.size ? "Đang tải thêm cuộc trò chuyện…" : "Đang tải lịch sử…";
    try {
      if (!this.transport.loadSessions) throw new Error();
      const page = await this.transport.loadSessions(this.context(controller.signal), this.#cursor, this.#filter || undefined);
      if (controller.signal.aborted || this.#controller !== controller) return;
      if (page.nextCursor && this.#cursors.has(page.nextCursor)) throw new Error("Cursor did not advance");
      this.#skeleton?.remove();
      for (const session of page.sessions) {
        if (this.#seen.has(session.sessionId)) continue;
        this.#seen.add(session.sessionId);
        const label = sessionHistoryGroup(session.createdAt, this.#groupDate);
        let group = this.#groups.get(label);
        if (!group) {
          group = document.createElement("div");
          group.className = "acw-session-group";
          group.setAttribute("role", "group");
          group.setAttribute("aria-label", label);
          const heading = document.createElement("h3");
          heading.className = "acw-session-heading";
          heading.textContent = label;
          group.append(heading);
          this.#list.append(group);
          this.#groups.set(label, group);
        }
        const row = document.createElement("button");
        row.type = "button";
        row.className = "acw-session-entry";
        row.dataset.sessionId = session.sessionId;
        row.setAttribute("aria-current", String(session.sessionId === this.context(controller.signal).sessionId));
        const title = document.createElement("strong");
        title.textContent = session.title || "Cuộc trò chuyện";
        row.title = `${session.title} · ${new Date(session.createdAt).toLocaleString("vi-VN")}`;
        const date = document.createElement("time");
        date.className = "acw-sr-only";
        date.dateTime = session.createdAt;
        date.textContent = new Date(session.createdAt).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        row.append(title, date);
        row.addEventListener("click", () => {
          if (this.pending()) { this.#status.textContent = "Vui lòng chờ lượt đang xử lý kết thúc trước khi đổi phiên."; return; }
          this.close();
          void this.select(session.sessionId);
        });
        group.append(row);
      }
      if (page.nextCursor) this.#cursors.add(page.nextCursor);
      this.#cursor = page.nextCursor;

      this.#status.textContent = this.#seen.size ? "" : this.#cursor ? "Đang tìm trong các phiên cũ hơn…" : this.#filter ? "Không tìm thấy cuộc trò chuyện phù hợp." : "Chưa có cuộc trò chuyện nào.";
    } catch {
      if (!controller.signal.aborted && this.#controller === controller) {
        this.#failed = true;
        this.#retry.hidden = false;
        this.#status.textContent = "Chưa tải được lịch sử trò chuyện. Vui lòng thử lại.";
        this.#retry.textContent = "Thử lại";
      }
    } finally {
      if (this.#controller === controller) {
        this.#loading = false;
        this.#retry.disabled = false;
        this.#skeleton?.remove();
        this.#list.setAttribute("aria-busy", "false");
        requestAnimationFrame(() => { if (this.#controller === controller) this.#loadNearEnd(); });
      }
    }
  }
  #clearMarks(): void { for (const match of this.#matches) match.classList.remove("acw-search-match"); }
  #find(): void {
    this.#clearMarks();
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLocaleLowerCase("vi-VN");
    const query = normalize(this.#query.value.trim());
    this.#matches = query ? [...this.conversation.querySelectorAll<HTMLElement>(".acw-bubble, .acw-step-note")]
      .filter((element) => normalize(element.textContent ?? "").includes(query)) : [];
    this.#match = -1;
    if (this.#matches.length) this.#move(1);
    else this.#count.textContent = query ? "0 kết quả" : "";
  }
  #move(delta: number): void {
    this.#clearMarks();
    if (!this.#matches.length) return;
    this.#match = (this.#match + delta + this.#matches.length) % this.#matches.length;
    const match = this.#matches[this.#match]!;
    const details = match.closest("details");
    if (details) details.open = true;
    match.classList.add("acw-search-match");
    match.scrollIntoView({ block: "center", behavior: "smooth" });
    this.#count.textContent = `${this.#match + 1}/${this.#matches.length}`;
  }
}
