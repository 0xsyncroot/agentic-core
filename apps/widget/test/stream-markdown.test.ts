import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { createStubDom, type StubNode } from "./dom-stub.js";

/**
 * A narration streaming as Markdown, through the built bundle against the stub DOM (spec ux-u2, U2-5).
 *
 * Written as plain text while it streams and formatted only at its end, a narration shows `**`, list markers and table
 * pipes raw and then snaps into format. Each frame renders the text so far as Markdown, with what is still unfinished
 * withheld or closed the way the renderer reads
 * it once complete. Each test gives the exact deltas and the narration's markup after the frame each one asked for.
 *
 * Fixtures: the journal's narrations are not on this machine, so the bold, formula and menu-path cases are model output
 * the renderer's own comments record (content.ts, tex.ts); tables, links, fences and markers are synthetic.
 */

interface Stream {
  /** The narration's markup after each delta's frame, then once the narration ended. */
  readonly frames: readonly string[];
  /** Its text after each delta's frame. */
  readonly texts: readonly string[];
  readonly final: string;
}

async function mount() {
  const source = await readFile(new URL("../dist/agentic-chat-widget.js", import.meta.url), "utf8");
  const dom = createStubDom();
  const context = createContext({
    ...dom.window, document: dom.document, URL, Headers, Response, TextDecoder, DOMException,
    AbortController, setTimeout, clearTimeout, crypto,
    location: { origin: "https://sample-app.example", href: "https://sample-app.example/app/", assign: () => undefined },
    CustomEvent: class { readonly type: string; readonly detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    Event: class { readonly type: string; constructor(type: string) { this.type = type; } },
  });
  const scope = context as unknown as Record<string, unknown>;
  scope.window = context;
  scope.globalThis = context;
  new Script(source, { filename: "agentic-chat-widget.js" }).runInContext(context);
  let sink: { onEvent(event: Record<string, unknown>): void } | undefined;
  const api = scope.AgentChat as { create(options: Record<string, unknown>): { send(content: string): Promise<void>; destroy(): void } };
  const widget = api.create({
    persistSession: false, startOpen: true,
    transport: {
      checkConnection: () => ({ status: "ok" }), loadHistory: () => [],
      send: (_request: unknown, events: { onEvent(event: Record<string, unknown>): void }) => { sink = events; return new Promise(() => undefined); },
    },
  });
  void widget.send("Tính lương tháng 10");
  for (let attempt = 0; attempt < 50 && !sink; attempt += 1) {
    dom.flushFrames();
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  assert.ok(sink, "the transport received the turn");
  const events = sink;
  const narration = () => dom.body.querySelectorAll('.acw-timeline .acw-bubble[data-message-kind="narration"]').at(-1);
  return {
    dom, widget,
    /** Streams one narration delta by delta, one frame each, and reads its markup back. */
    stream(deltas: readonly string[], id = "n1", kind?: "draft"): Stream {
      events.onEvent({ type: "assistant-narration-start", narrationId: id, audience: "user", ...(kind ? { kind } : {}) });
      const frames: string[] = [];
      const texts: string[] = [];
      for (const delta of deltas) {
        events.onEvent({ type: "assistant-narration-delta", narrationId: id, audience: "user", delta });
        dom.stepFrame();
        frames.push(narration()?.innerHTML ?? "");
        texts.push(narration()?.textContent ?? "");
      }
      events.onEvent({ type: "assistant-narration-end", narrationId: id, audience: "user", status: "completed" });
      return { frames, texts, final: narration()?.innerHTML ?? "" };
    },
    /** One delta and its frame, timed: what the frame costs on the stub. */
    timedDelta(delta: string, id = "n1"): number {
      events.onEvent({ type: "assistant-narration-delta", narrationId: id, audience: "user", delta });
      const started = performance.now();
      dom.stepFrame();
      return performance.now() - started;
    },
    start(id = "n1"): void { events.onEvent({ type: "assistant-narration-start", narrationId: id, audience: "user" }); },
    narration,
  };
}

/** What no frame may show: a raw marker the finished text never shows. Checked on the text a reader sees, code aside. */
function assertClean(html: string, frame: number): void {
  const text = html.replace(/<pre>[\s\S]*?<\/pre>/gu, "").replace(/<[^>]+>/gu, "");
  assert.doesNotMatch(text, /\*\*|__/u, `frame ${frame}: no raw emphasis marker (${html})`);
  assert.doesNotMatch(text, /\|/u, `frame ${frame}: no table pipe as text (${html})`);
  assert.doesNotMatch(text, /\[|\]\(/u, `frame ${frame}: no half link's brackets (${html})`);
  assert.doesNotMatch(text, /\\|\$\\|\$$/u, `frame ${frame}: no half TeX (${html})`);
  assert.doesNotMatch(html, /<p>(?:[^<]*\s)?(?:[-*+]|\d+[.)]?|#{1,6})<\/p>/u, `frame ${frame}: no lone list or heading marker (${html})`);
}

function check(stream: Stream, frames: readonly string[], final: string): void {
  stream.frames.forEach(assertClean);
  assert.deepEqual(stream.frames, frames);
  assert.equal(stream.final, final, "the committed narration is renderMarkdown of the whole text");
}

const BUTTON = '<button type="button" class="acw-table-expand" aria-haspopup="dialog" aria-label="Phóng to bảng" title="Phóng to bảng"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.5 3.333h4.167V7.5M7.5 16.667H3.333V12.5m13.334-9.167-5 5m-8.334 8.334 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
const table = (head: string, body: string) => `<div class="acw-table-block"><div class="acw-table-tools">${BUTTON}</div><div class="acw-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
const LINK = ' target="_blank" rel="noopener noreferrer"';

test("rule 1, tables: the header waits for its finished rule line, then only the row being written waits", async () => {
  const page = await mount();
  const stream = page.stream(["Kết quả:\n", "| Nhóm | Số", " người |\n", "|---|--:", "|\n", "| Phụ cấp | 4", " |\n", "| Ngày công | 6 |\n"]);
  const lead = "<p>Kết quả:</p>";
  const empty = lead + table('<th class="acw-cell-nowrap">Nhóm</th><th class="acw-cell-end acw-cell-nowrap">Số người</th>', "");
  const head = '<th class="acw-cell-nowrap">Nhóm</th><th class="acw-cell-figure">Số người</th>';
  const one = lead + table(head, '<tr><td>Phụ cấp</td><td class="acw-cell-figure">4</td></tr>');
  const two = lead + table(head, '<tr><td>Phụ cấp</td><td class="acw-cell-figure">4</td></tr><tr><td>Ngày công</td><td class="acw-cell-figure">6</td></tr>');
  check(stream, [lead, lead, lead, lead, empty, empty, one, two], two);
  page.widget.destroy();
});

test("rule 2, emphasis: a marker run at the very end waits, and only a run the renderer would open is closed, with its own marker", async () => {
  const page = await mount();
  // The formula a model bolded (content.ts): its `*` between two cells is a multiplication sign, never an opener.
  const stream = page.stream(["Công thức ", "**ROUND(D24*", "F24+E24,0)*", "* cho ", "**Tổng*", "*."]);
  const formula = "<strong>ROUND(D24*F24+E24,0)</strong>";
  check(stream, [
    "<p>Công thức</p>",
    "<p>Công thức <strong>ROUND(D24</strong></p>",
    `<p>Công thức ${formula}</p>`,
    `<p>Công thức ${formula} cho</p>`,
    `<p>Công thức ${formula} cho <strong>Tổng</strong></p>`,
    `<p>Công thức ${formula} cho <strong>Tổng</strong>.</p>`,
  ], `<p>Công thức ${formula} cho <strong>Tổng</strong>.</p>`);
  page.widget.destroy();
});

test("rule 3, trailing whitespace: the closer goes before it, where it can close", async () => {
  const page = await mount();
  const stream = page.stream(["Em đã **đối chiếu ", "xong** 84 người."]);
  check(stream, ["<p>Em đã <strong>đối chiếu</strong></p>", "<p>Em đã <strong>đối chiếu xong</strong> 84 người.</p>"],
    "<p>Em đã <strong>đối chiếu xong</strong> 84 người.</p>");
  page.widget.destroy();
});

test("rule 4, links: a link without its \")\" reads as its words, never dropped and never in brackets", async () => {
  const page = await mount();
  const stream = page.stream(["Xem [hướng", " dẫn](https://help", ".example.test/a) và [mục", "](https://help.example.test/b", ") nhé."]);
  const first = `<a href="https://help.example.test/a"${LINK}>hướng dẫn</a>`;
  check(stream, [
    "<p>Xem hướng</p>",
    "<p>Xem hướng dẫn</p>",
    `<p>Xem ${first} và mục</p>`,
    `<p>Xem ${first} và mục</p>`,
    `<p>Xem ${first} và <a href="https://help.example.test/b"${LINK}>mục</a> nhé.</p>`,
  ], `<p>Xem ${first} và <a href="https://help.example.test/b"${LINK}>mục</a> nhé.</p>`);
  page.widget.destroy();
});

test("rule 5, math: an open TeX span waits for its end, a dollar amount does not, and code keeps its TeX while its fence is open", async () => {
  const page = await mount();
  // A menu path and a close-the-sum line as models wrote them (tex.ts).
  const stream = page.stream(["Vào Tiền lương $", "\\right", "arrow$ Quản lý", " bảng lương; tổng $\\text{Tổng chênh} \\approx", " 5$ đồng, phí $100", " thôi."]);
  const path = "Vào Tiền lương → Quản lý";
  check(stream, [
    "<p>Vào Tiền lương</p>",
    "<p>Vào Tiền lương</p>",
    `<p>${path}</p>`,
    `<p>${path} bảng lương; tổng</p>`,
    `<p>${path} bảng lương; tổng Tổng chênh ≈ 5 đồng, phí $100</p>`,
    `<p>${path} bảng lương; tổng Tổng chênh ≈ 5 đồng, phí $100 thôi.</p>`,
  ], `<p>${path} bảng lương; tổng Tổng chênh ≈ 5 đồng, phí $100 thôi.</p>`);

  const code = page.stream(["Lệnh:\n```\na \\to b\n", "``", "`\nxong"], "n2");
  const block = '<p>Lệnh:</p><pre><code class="language-">a \\to b</code></pre>';
  check(code, [block, block, `${block}<p>xong</p>`], `${block}<p>xong</p>`);
  assert.equal(code.frames.some((frame) => frame.includes("→")), false, "inside an open fence no symbol is rewritten");
  page.widget.destroy();
});

test("rule 6, bare markers: a line that is only a list or heading marker waits for its text", async () => {
  const page = await mount();
  const stream = page.stream(["Các bước:\n", "1", ". Mở **Tiền lương**\n", "-", " Chọn kỳ\n", "##", " Kết quả"]);
  const lead = "<p>Các bước:</p>";
  const ordered = `${lead}<ol><li>Mở <strong>Tiền lương</strong></li></ol>`;
  const both = `${ordered}<ul><li>Chọn kỳ</li></ul>`;
  check(stream, [lead, lead, ordered, ordered, both, both, `${both}<h2>Kết quả</h2>`], `${both}<h2>Kết quả</h2>`);
  page.widget.destroy();
});

// An answer's `---` between sections is a thematic break, not a line of dashes.
test("rule 7, thematic breaks: ---, ***, ___ and - - - on a line of their own are one rule, after a table too", async () => {
  const page = await mount();
  for (const [index, rule] of ["---", "***", "___", "- - -", "  * * *  "].entries()) {
    const { final } = page.stream([`Lương, phụ cấp\n\n${rule}\n\nTiếp theo`], `r${index}`);
    assert.equal(final, "<p>Lương, phụ cấp</p><hr><p>Tiếp theo</p>", `${JSON.stringify(rule)} is a rule, not text or a list`);
  }
  for (const [index, gap] of ["\n\n", "\n"].entries()) {
    const { final } = page.stream([`| Nhóm | Số người |\n|---|---|\n| Phụ cấp | 4 |${gap}---\n\nXong.`], `t${index}`);
    assert.equal(final.split("<table>").length - 1, 1, `one table (${final})`);
    assert.match(final, /<\/table><\/div><\/div><hr><p>Xong\.<\/p>$/u, "and the rule under it");
  }
  const { final: lead } = page.stream(["Một ---- hai -- ba"], "inline");
  assert.equal(lead, "<p>Một ---- hai -- ba</p>", "dashes inside a line stay text");
  page.widget.destroy();
});

/** Rendered text without tags, and how many rules: a frame may only show what the finished text shows, never take back a rule. */
function streamedPrefixes(page: Awaited<ReturnType<typeof mount>>, text: string, id: string): void {
  const stream = page.stream([...text], id);
  const words = (html: string) => html.replace(/<[^>]+>/gu, "");
  const rules = (html: string) => html.split("<hr>").length - 1;
  let shown = 0;
  stream.frames.forEach((frame, index) => {
    assertClean(frame, index);
    assert.ok(words(stream.final).startsWith(words(frame)), `frame ${index} of ${JSON.stringify(text)} shows no text the end takes back (${frame})`);
    assert.ok(rules(frame) >= shown && rules(frame) <= rules(stream.final), `frame ${index} of ${JSON.stringify(text)}: a rule shown stays a rule (${frame})`);
    shown = rules(frame);
  });
}

test("rule 7 while streaming: a line that may still become a rule, or stop being one, waits for its line break", async () => {
  const page = await mount();
  streamedPrefixes(page, "x\n\n---\n\ny", "s1");
  streamedPrefixes(page, "x\n\n***Lưu ý:*** y", "s2");
  streamedPrefixes(page, "a\n---b", "s3");
  const { frames, final } = page.stream(["Xong.\n\n", "-", "--"], "end");
  assert.deepEqual(frames, ["<p>Xong.</p>", "<p>Xong.</p>", "<p>Xong.</p>"], "the last line, a rule so far, is not drawn yet");
  assert.equal(final, "<p>Xong.</p><hr>", "and is a rule once the stream ends with it");
  page.widget.destroy();
});

test("a narration the review sent back streams hidden, and no frame renders it", async () => {
  const page = await mount();
  const stream = page.stream(["Em đã **tính xong**", " bảng lương."], "d1", "draft");
  assert.deepEqual([stream.frames, stream.texts], [["", ""], ["", ""]], "hidden, so nothing is drawn for nobody");
  assert.equal(page.narration()?.hidden, true, "and it stays hidden once it ends");
  page.widget.destroy();
});

test("a 4,000-character narration renders each frame within 2 ms on the stub (median of 50 frames)", async (context) => {
  const page = await mount();
  const block = [
    "Em đã đối chiếu **bảng lương tháng 10/2026** với dữ liệu chấm công và hồ sơ phụ cấp.",
    "- Phụ cấp chức vụ: **4 người** chênh lệch, do hệ số cũ.",
    "- Ngày công: 6 người thiếu công, xem [hướng dẫn](https://help.example.test/a).",
    "| Nhóm | Số người | Chênh lệch |", "|---|--:|--:|", "| Phụ cấp | 4 | +38.035.266 |", "| Ngày công | 6 | −2.259.518 |",
    "",
  ].join("\n");
  const text = block.repeat(Math.ceil(4_000 / block.length)).slice(0, 4_000);
  // The same stream once untimed first: a fresh process compiles the renderer and the stub's parser on its first frames.
  const frames = (id: string) => {
    page.start(id);
    page.timedDelta(text.slice(0, 3_950), id);
    return [...text.slice(3_950)].map((character) => page.timedDelta(character, id));
  };
  frames("warm-up");
  const times = frames("n1");
  assert.equal(times.length, 50);
  const median = [...times].sort((left, right) => left - right)[25] ?? Number.POSITIVE_INFINITY;
  context.diagnostic(`frame time over ${text.length} chars: median ${median.toFixed(3)} ms, max ${Math.max(...times).toFixed(3)} ms`);
  assert.ok(median <= 2, `median ${median.toFixed(3)} ms per frame`);
  page.widget.destroy();
});
