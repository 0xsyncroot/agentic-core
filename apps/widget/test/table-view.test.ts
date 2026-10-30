import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { StubNode, createStubDom } from "./dom-stub.js";

/**
 * Markdown tables through the built bundle: how a column is classed by what it holds, the frame
 * that scrolls instead of squeezing, and the full-size view behind each table's button.
 *
 * The case is the one seen in a 480px panel: a report whose money column broke at every grouping
 * mark and whose "Số người" header stacked a syllable per line, while the prose column took the
 * width. The stub has no layout, so these check what layout is decided by — the classes and the
 * structure — and drive the view the way a person does: a click, Escape, the backdrop, the copy.
 */

const REPORT = [
  "Kết quả đối chiếu:",
  "",
  "| Nhóm nguyên nhân | Số người | Chênh lệch (VNĐ) | Chi tiết & Căn cứ |",
  "|---|---|---|---|",
  "| Phụ cấp chức vụ | 4 | **+38.035.266,06** | Bảng lương còn tính hệ số phụ cấp cũ trong khi quyết định mới có hiệu lực từ tháng 9 |",
  "| Ngày công | 6 | −2.259.518 | Thiếu ngày công |",
  "| Bảo hiểm | — | (1.200) | Làm tròn |",
].join("\n");

interface Mounted {
  readonly body: StubNode;
  readonly widget: { setCompactMode(compact: boolean): void };
  /** The last reply's answer bubble. */
  answer(): StubNode;
  /** What reached the clipboard, in order. */
  readonly copied: string[];
  /** The element the widget puts on the page, whose layer decides what it paints over. */
  readonly host: StubNode;
  /** The window is resized to `width`, as a browser reports it. */
  resize(width: number): void;
}

/** `innerWidth` sets the window's width before the widget mounts; the rest are widget options. */
async function mount(content: string, options: Record<string, unknown> & { readonly innerWidth?: number } = {}): Promise<Mounted> {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const copied: string[] = [];
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    // The widget's own click handler asks `instanceof Element` of a delegated click's target.
    Element: StubNode,
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  const { innerWidth, ...widgetOptions } = options;
  if (innerWidth !== undefined) scope.innerWidth = innerWidth;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);

  const api = scope.AgentChat as { create(options: Record<string, unknown>): Mounted["widget"] & { send(content: string): Promise<void> } };
  const widget = api.create({
    persistSession: false,
    startOpen: true,
    transport: { checkConnection: () => ({ status: "ok" }), loadHistory: () => [], send: async () => ({ content }) },
    ...widgetOptions,
  });
  const sampler = setInterval(() => dom.stepFrame(), 1);
  try { await widget.send("đối chiếu"); } finally { clearInterval(sampler); }
  dom.flushFrames();
  const root = dom.body.querySelector(".acw-root");
  assert.ok(root?.parentNode?.parentNode, "the widget mounted its root inside its host");
  return {
    body: dom.body, widget, copied, host: root.parentNode.parentNode,
    resize(width: number) {
      scope.innerWidth = width;
      (dom.window.dispatchEvent as (event: { readonly type: string }) => void)({ type: "resize" });
    },
    answer() {
      const row = dom.body.querySelectorAll(".acw-assistant").at(-1);
      const bubble = row?.querySelectorAll(".acw-bubble").find((node) => !node.hidden);
      assert.ok(bubble, "the reply has an answer bubble");
      return bubble;
    },
  };
}

/** A click that climbs to the delegated listener, as a real one does. */
function press(node: StubNode): void { node.dispatchEvent({ type: "click", bubbles: true }); }

function key(node: StubNode, name: string, shiftKey = false): { stopped: boolean; prevented: boolean } {
  const seen = { stopped: false, prevented: false };
  node.dispatchEvent({
    type: "keydown", key: name, shiftKey, bubbles: true,
    preventDefault: () => { seen.prevented = true; }, stopPropagation: () => { seen.stopped = true; },
  });
  return seen;
}

/** Opens the last reply's table at full size and hands back the modal and the button that opened it. */
function expand(mounted: Mounted): { modal: StubNode; opener: StubNode; focused: () => number } {
  const opener = mounted.answer().querySelector(".acw-table-expand");
  assert.ok(opener, "every table carries the full-size button");
  let focused = 0;
  opener.focus = () => { focused += 1; };
  press(opener);
  const modal = mounted.body.querySelector(".acw-table-modal");
  assert.ok(modal, "the full-size view exists");
  return { modal, opener, focused: () => focused };
}

test("a figure column stays on one line and on the right, by what it holds; prose keeps a readable width", async () => {
  const mounted = await mount(REPORT);
  const html = mounted.answer().innerHTML;
  assert.match(html, /<th class="acw-cell-phrase">Nhóm nguyên nhân<\/th><th class="acw-cell-figure">Số người<\/th><th class="acw-cell-end acw-cell-phrase">Chênh lệch \(VNĐ\)<\/th><th class="acw-cell-phrase">Chi tiết &amp; Căn cứ<\/th>/u,
    "a short header stays on one line; a longer one wraps between words from a minimum width, still on the right over figures");
  assert.match(html, /<td class="acw-cell-figure">4<\/td><td class="acw-cell-figure"><strong>\+38\.035\.266,06<\/strong><\/td><td class="acw-cell-text">Bảng lương/u,
    "a bold amount is still a figure, and a long explanation keeps its minimum width");
  assert.match(html, /<td class="acw-cell-figure">—<\/td><td class="acw-cell-figure">\(1\.200\)<\/td><td>Làm tròn<\/td>/u,
    "a dash in a figure column lines up with the figures; a bracketed amount is a figure; short prose is left alone");
  assert.match(html, /<td class="acw-cell-figure">−2\.259\.518<\/td>/u, "a minus sign of any spelling");
  assert.match(html, /<tr><td class="acw-cell-phrase">Phụ cấp chức vụ<\/td>/u, "a row label of several words keeps a small minimum width");
});

test("the table sits in its own scrolling frame, with the full-size button above it", async () => {
  const mounted = await mount(REPORT);
  const block = mounted.answer().querySelector(".acw-table-block");
  assert.ok(block, "the table has a block of its own");
  const frame = block.querySelector(".acw-table");
  assert.ok(frame?.querySelector("table"), "the table is inside the frame that scrolls sideways");
  const button = block.querySelector(".acw-table-expand");
  assert.equal(button?.getAttribute("aria-label"), "Phóng to bảng");
  assert.equal(button?.getAttribute("title"), "Phóng to bảng");
  assert.equal(button?.getAttribute("aria-haspopup"), "dialog");
  assert.equal(button?.getAttribute("type"), "button");
});

test("a column of single tokens does not wrap, the rule's alignment is kept, and a cell's markup is text", async () => {
  const mounted = await mount([
    "| Mã | Ngày | Ghi chú | Trạng thái |", "|---|---|:---:|---:|",
    "| NV001 | 01/09/2026 | <b>đậm</b> và nghiêng | đã xong |", "| NV002 | 15/09/2026 | thường lệ | chờ duyệt |",
  ].join("\n"));
  const html = mounted.answer().innerHTML;
  assert.match(html, /<th class="acw-cell-nowrap">Mã<\/th><th class="acw-cell-nowrap">Ngày<\/th><th class="acw-cell-center acw-cell-nowrap">Ghi chú<\/th><th class="acw-cell-end acw-cell-nowrap">Trạng thái<\/th>/u);
  assert.match(html, /<td class="acw-cell-nowrap">NV001<\/td><td class="acw-cell-nowrap">01\/09\/2026<\/td><td class="acw-cell-center acw-cell-phrase">&lt;b&gt;đậm&lt;\/b&gt; và nghiêng<\/td><td class="acw-cell-end">đã xong<\/td>/u);
  assert.doesNotMatch(html, /<b>/u, "nothing in a cell reaches the page as markup");
});

test("the button opens the table in a dialog the agent looks through; Escape closes it and focus goes back", async () => {
  const mounted = await mount(REPORT);
  const { modal, opener, focused } = expand(mounted);
  assert.equal(modal.hidden, false, "the view is open");
  assert.ok(modal.hasAttribute("data-agent-private"), "the agent's hit-testing looks through the view");
  assert.ok(modal.hasAttribute("data-agent-overlay"), "the view is moved aside with the panel while the agent acts");
  const dialog = modal.querySelector(".acw-table-dialog");
  assert.equal(dialog?.getAttribute("role"), "dialog");
  assert.equal(dialog?.getAttribute("aria-modal"), "true");
  const copy = modal.querySelector(".acw-table-body table");
  assert.ok(copy, "the dialog shows the table");
  assert.deepEqual(copy.querySelectorAll("th").map((cell) => cell.textContent),
    ["Nhóm nguyên nhân", "Số người", "Chênh lệch (VNĐ)", "Chi tiết & Căn cứ"]);
  assert.equal(copy.querySelectorAll("tbody tr").length, 3);
  assert.equal(modal.querySelector(".acw-table-meta")?.textContent, "4 cột · 3 dòng");
  assert.ok(mounted.answer().querySelector(".acw-table table"), "the table stays in the answer too");

  const close = modal.querySelector(".acw-table-close");
  assert.ok(close);
  const escape = key(close, "Escape");
  assert.equal(modal.hidden, true, "Escape closes the view");
  assert.ok(escape.prevented && escape.stopped, "and the key stops there, so a host's own Escape does not close the chat");
  assert.equal(focused(), 1, "focus goes back to the button that opened it");
  assert.equal(modal.querySelector(".acw-table-body table"), null, "the copy is gone once closed");
  assert.equal(opener.getAttribute("aria-label"), "Phóng to bảng");
});

test("the backdrop and the close button close the view; Tab stays inside it", async () => {
  const mounted = await mount(REPORT);
  const first = expand(mounted);
  const cell = first.modal.querySelector(".acw-table-body td")!;
  // A selection dragged out of a cell and released over the backdrop clicks the backdrop too.
  cell.dispatchEvent({ type: "pointerdown", bubbles: true });
  press(first.modal);
  assert.equal(first.modal.hidden, false, "a press that began inside the table does not close the view");
  first.modal.dispatchEvent({ type: "pointerdown", bubbles: true });
  press(first.modal);
  assert.equal(first.modal.hidden, true, "a click on the backdrop closes the view");

  const second = expand(mounted);
  const dialog = second.modal.querySelector(".acw-table-dialog")!;
  press(dialog);
  assert.equal(second.modal.hidden, false, "a click inside the dialog does not");
  const copyButton = second.modal.querySelector(".acw-table-copy")!;
  const scroller = second.modal.querySelector(".acw-table-body")!;
  const moved: string[] = [];
  copyButton.focus = () => { moved.push("copy"); };
  scroller.focus = () => { moved.push("body"); };
  assert.ok(key(scroller, "Tab").prevented, "Tab from the last stop wraps");
  assert.ok(key(copyButton, "Tab", true).prevented, "Shift+Tab from the first stop wraps");
  assert.deepEqual(moved, ["copy", "body"]);
  second.modal.querySelector(".acw-table-close")!.click();
  assert.equal(second.modal.hidden, true, "× closes the view");
  assert.equal(second.focused(), 1);
});

test("a <br> inside a cell breaks the line, as in GitHub tables; it is the only markup a cell keeps", async () => {
  // A model lists a group's people under its cause with <br>; the cell must not show the tag.
  const mounted = await mount([
    "| Nhóm | Chi tiết |", "|---|---|",
    "| Nhóm thử nghiệm | Tệp ghi 0 kèm TEST.<br>Nhân viên: **Nhân Viên Mẫu B**<br/>và <b>ba</b> người |",
  ].join("\n"));
  const html = mounted.answer().innerHTML;
  assert.match(html, /Tệp ghi 0 kèm TEST\. <br>Nhân viên: <strong>Nhân Viên Mẫu B<\/strong> <br>và &lt;b&gt;ba&lt;\/b&gt; người<\/td>/u);
  assert.doesNotMatch(html, /&lt;br/u, "the break is not shown as text");
});

test("Chép bảng puts the table on the clipboard as tab-separated text, header row first", async () => {
  const mounted = await mount(REPORT);
  const { modal } = expand(mounted);
  const button = modal.querySelector(".acw-table-copy")!;
  assert.equal(button.querySelector(".acw-table-copy-label")?.textContent, "Chép bảng");
  button.click();
  for (let attempt = 0; attempt < 50 && mounted.copied.length === 0; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
  await new Promise((resolve) => { setTimeout(resolve, 1); });
  assert.equal(mounted.copied[0], [
    "Nhóm nguyên nhân\tSố người\tChênh lệch (VNĐ)\tChi tiết & Căn cứ",
    "Phụ cấp chức vụ\t4\t+38.035.266,06\tBảng lương còn tính hệ số phụ cấp cũ trong khi quyết định mới có hiệu lực từ tháng 9",
    "Ngày công\t6\t−2.259.518\tThiếu ngày công",
    "Bảo hiểm\t—\t(1.200)\tLàm tròn",
  ].join("\n"));
  assert.equal(button.querySelector(".acw-table-copy-label")?.textContent, "Đã chép", "a short confirmation on the button");
  assert.equal(button.dataset.copyState, "success");
  assert.equal(modal.querySelector(".acw-table-status")?.textContent, "Đã chép bảng", "and for a screen reader");
});

test("the view closes when the chat steps aside for the agent to act on the page", async () => {
  const mounted = await mount(REPORT);
  const { modal } = expand(mounted);
  assert.equal(modal.hidden, false);
  mounted.widget.setCompactMode(true);
  assert.equal(modal.hidden, true, "nothing of the widget's stays over the page the agent is about to use");
});

test("headings of every Markdown level render as headings, not as hashes", async () => {
  const mounted = await mount("#### a. Nhóm làm tròn\n\nCó 69 người.\n\n##### Ghi chú ##\n\n####### bảy dấu là chữ");
  const html = mounted.answer().innerHTML;
  assert.match(html, /<h4>a\. Nhóm làm tròn<\/h4>/u);
  assert.match(html, /<h5>Ghi chú<\/h5>/u, "closing hashes are dropped");
  assert.doesNotMatch(html, /<h7>/u, "seven hashes are no heading");
});

const LINKED = [
  "| Nhóm | Căn cứ | Công thức |", "|---|---|---|",
  "| Phụ cấp | [Quyết định 112](https://example.com/qd-112) | =SUM(A1:A2) |",
  "| Ngày công | [Bảng chấm công](https://example.com/cham-cong) | @thamchieu |",
  "| -bù trừ | +5 | -5 |",
].join("\n");

test("a link in a cell is a tab stop of the view: Tab wraps from it, and focus that escapes comes back", async () => {
  const mounted = await mount(LINKED);
  const { modal } = expand(mounted);
  const links = modal.querySelectorAll(".acw-table-body a");
  assert.equal(links.length, 2, "the links came along into the view");
  const copyButton = modal.querySelector(".acw-table-copy")!;
  const dialog = modal.querySelector(".acw-table-dialog")!;
  const moved: string[] = [];
  copyButton.focus = () => { moved.push("copy"); };
  links[1]!.focus = () => { moved.push("last link"); };
  dialog.focus = () => { moved.push("dialog"); };
  assert.ok(key(links[1]!, "Tab").prevented, "Tab from the last link wraps instead of leaving for the page");
  assert.ok(key(copyButton, "Tab", true).prevented);
  assert.deepEqual(moved, ["copy", "last link"], "Shift+Tab from the first stop lands on the last link");
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 5); });
  links[0]!.dispatchEvent({ type: "focusout", bubbles: true, relatedTarget: null });
  await settle();
  assert.deepEqual(moved.at(-1), "dialog", "focus that slipped to nowhere is pulled back, so Escape still reaches it");
  const composer = mounted.body.querySelector(".acw-composer textarea")!;
  links[0]!.dispatchEvent({ type: "focusout", bubbles: true, relatedTarget: composer });
  await settle();
  assert.equal(moved.length, 4, "focus that went to another part of the widget is pulled back too");
  // The agent (or the user) focusing a control of the host page while the chat stays open.
  const hostSelect = new StubNode("select");
  mounted.body.append(hostSelect);
  links[0]!.dispatchEvent({ type: "focusout", bubbles: true, relatedTarget: hostSelect });
  await settle();
  assert.equal(moved.length, 4, "focus the page took is the page's: never pulled back");
});

test("closing after the answer re-rendered gives focus to the same table's new button", async () => {
  const mounted = await mount(REPORT);
  const { modal, focused } = expand(mounted);
  // The bubble is rendered again when its turn ends: same node, new content, the opener is gone.
  const bubble = mounted.answer();
  bubble.innerHTML = bubble.innerHTML;
  const again = bubble.querySelector(".acw-table-expand")!;
  let againFocused = 0;
  again.focus = () => { againFocused += 1; };
  key(modal.querySelector(".acw-table-close")!, "Escape");
  assert.equal(modal.hidden, true);
  assert.equal(focused(), 0, "the removed button is not focused");
  assert.equal(againFocused, 1, "the re-rendered table's button takes focus");
});

test("with the table gone, focus goes to the composer, or to the send/stop button while the composer is disabled", async () => {
  for (const disabled of [false, true]) {
    const mounted = await mount(REPORT);
    const { modal } = expand(mounted);
    mounted.answer().innerHTML = "<p>Đã cập nhật.</p>";
    const composer = mounted.body.querySelector(".acw-composer textarea")!;
    const send = mounted.body.querySelector(".acw-send")!;
    // A turn is running: the composer refuses input, the send button has become Stop.
    Object.assign(composer, { disabled });
    const moved: string[] = [];
    composer.focus = () => { moved.push("composer"); };
    send.focus = () => { moved.push("send"); };
    key(modal.querySelector(".acw-table-close")!, "Escape");
    assert.deepEqual(moved, [disabled ? "send" : "composer"]);
  }
});

test("the copy keeps focus in the view, and a cell that would run as a formula is pasted as text", async () => {
  const mounted = await mount(LINKED);
  const { modal } = expand(mounted);
  const button = modal.querySelector(".acw-table-copy")!;
  let refocused = 0;
  button.focus = () => { refocused += 1; };
  button.click();
  for (let attempt = 0; attempt < 50 && mounted.copied.length === 0; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
  await new Promise((resolve) => { setTimeout(resolve, 1); });
  assert.equal(mounted.copied[0], [
    "Nhóm\tCăn cứ\tCông thức",
    "Phụ cấp\tQuyết định 112\t'=SUM(A1:A2)",
    "Ngày công\tBảng chấm công\t'@thamchieu",
    "'-bù trừ\t+5\t-5",
  ].join("\n"), "=, @ and a non-figure +/- get an apostrophe; signed figures stay numbers");
  assert.equal(refocused, 1, "focus is back on the copy button, so Escape still closes the view");
  key(button, "Escape");
  assert.equal(modal.hidden, true);
});

// Docked beside the page, the widget sits under the page's own popups (dockedZIndex), so a host popup would cover all of the
// full-size view but a strip unless the view takes the top layer.
test("docked beside the page, the open table view takes the top layer over the whole page, and gives it back when it closes", async () => {
  const mounted = await mount(REPORT, { mode: "docked", dockedPageMinWidth: 800, dockedZIndex: 9998, innerWidth: 1280 });
  assert.equal(mounted.body.querySelector(".acw-root")?.dataset.dock, "push", "the panel stands beside the page");
  assert.equal(mounted.host.style.zIndex, "9998", "under the page's own popups while the view is closed");
  const { modal } = expand(mounted);
  assert.equal(modal.hidden, false);
  assert.equal(mounted.host.style.zIndex, "2147483000", "open, the view is over everything on the page");
  mounted.resize(1600);
  assert.equal(mounted.host.style.zIndex, "2147483000", "a resize while it is open keeps it on top");
  key(modal.querySelector(".acw-table-close")!, "Escape");
  assert.equal(modal.hidden, true);
  assert.equal(mounted.host.style.zIndex, "9998", "closed by Escape, back under the page's popups");
  expand(mounted);
  press(modal.querySelector(".acw-table-close")!);
  assert.equal(mounted.host.style.zIndex, "9998", "closed by its button, the same");
});
