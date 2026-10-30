/// <reference path="./tex.ts" />
/// <reference path="./markdown-table.ts" />
/// <reference path="./link-target.ts" />
/** Pure value, escaping and Markdown helpers shared by the controller and renderers. */
function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @internal The most a narration keeps, live or replayed — the same cap the server applies. */
const NARRATION_MAX_CHARS = 20_000;

/** @internal A longer narration is cut to the cap and ends in "…" instead of vanishing. */
function clipNarration(value: string): string {
  if (value.length <= NARRATION_MAX_CHARS) return value;
  const cut = value.slice(0, NARRATION_MAX_CHARS - 1);
  // Never leave half of a surrogate pair in front of the mark.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function compact(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function dimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

/** A version 4 GUID: conversation and request ids are plain GUIDs, with no prefix. */
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(-2).map((part) => part.charAt(0).toUpperCase()).join("") || "AI";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
};

/** Single pass: the chained form allocated a fresh copy of the whole string per character class. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** A run of `*` or `_` that may open or close emphasis, and what it became once paired. */
interface EmphasisRun {
  readonly kind: "run";
  readonly marker: "*" | "_";
  /** Marker characters not yet used by a pair; whatever is left shows as text. */
  left: number;
  canOpen: boolean;
  readonly canClose: boolean;
  /** Tags this run opens, outermost first; they follow its leftover characters. */
  readonly opens: string[];
  /** Tags this run closes, innermost first; they precede its leftover characters. */
  readonly closes: string[];
}
type InlinePiece = { readonly kind: "text"; readonly text: string } | { readonly kind: "html"; readonly html: string } | EmphasisRun;

const INLINE_ATOM = /^(?:`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

/**
 * Whether a marker run may open or close emphasis, judged by the characters around it.
 *
 * A marker touching a letter or digit on the outer side is part of a word or a formula, never
 * emphasis: `**ROUND(D24*F24+E24,0)**` used to lose its multiplication sign and gain a stray `*`
 * on screen, the regex taking `*F24+E24,0)*` for italics. `2*3=6`, `a*b*c` and `D24 * F24` stay as
 * written. A bracket is a formula's punctuation too: `(A1)*(B1)` is a product, not a pair.
 */
function emphasisRun(marker: "*" | "_", length: number, before: string | undefined, after: string | undefined): EmphasisRun {
  const outerOpen = before === undefined || SPACE.test(before) || (!WORD.test(before) && !")]}".includes(before));
  const outerClose = after === undefined || SPACE.test(after) || (!WORD.test(after) && !"([{".includes(after));
  return {
    kind: "run", marker, left: length, opens: [], closes: [],
    canOpen: after !== undefined && !SPACE.test(after) && outerOpen,
    canClose: before !== undefined && !SPACE.test(before) && outerClose,
  };
}

/**
 * Inline code, links, then emphasis paired the way Markdown pairs delimiter runs (nearest opener,
 * nested, never crossed). A run still able to open with characters `left` found no closer.
 */
function inlinePieces(value: string): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  let text = "";
  const flush = () => { if (text) pieces.push({ kind: "text", text }); text = ""; };
  for (let index = 0; index < value.length;) {
    const character = value[index] ?? "";
    const atom = character === "`" || character === "[" ? INLINE_ATOM.exec(value.slice(index)) : null;
    if (atom) {
      flush();
      pieces.push({ kind: "html", html: atom[1] !== undefined
        ? `<code>${escapeHtml(atom[1])}</code>`
        : `<a href="${escapeHtml(atom[3] ?? "")}"${linkTargetAttributes(atom[3] ?? "")}>${inlineMarkdown(atom[2] ?? "")}</a>` });
      index += atom[0].length;
      continue;
    }
    if (character === "\\" && "*_`".includes(value[index + 1] ?? "\\")) { text += value[index + 1]; index += 2; continue; }
    if (character === "*" || character === "_") {
      let end = index;
      while (value[end] === character) end += 1;
      flush();
      pieces.push(emphasisRun(character, end - index, value[index - 1], value[end]));
      index = end;
      continue;
    }
    text += character;
    index += 1;
  }
  flush();

  for (let closerIndex = 0; closerIndex < pieces.length; closerIndex += 1) {
    const closer = pieces[closerIndex]!;
    if (closer.kind !== "run" || !closer.canClose) continue;
    while (closer.left > 0) {
      let openerIndex = closerIndex - 1;
      for (; openerIndex >= 0; openerIndex -= 1) {
        const candidate = pieces[openerIndex]!;
        if (candidate.kind === "run" && candidate.canOpen && candidate.left > 0 && candidate.marker === closer.marker) break;
      }
      if (openerIndex < 0) break;
      const opener = pieces[openerIndex] as EmphasisRun;
      const used = opener.left >= 2 && closer.left >= 2 ? 2 : 1;
      const tag = used === 2 ? "strong" : "em";
      opener.left -= used;
      closer.left -= used;
      opener.opens.unshift(`<${tag}>`);
      closer.closes.push(`</${tag}>`);
      // A run left unpaired inside this pair can no longer open: a later closer would cross it.
      for (let between = openerIndex + 1; between < closerIndex; between += 1) {
        const inner = pieces[between]!;
        if (inner.kind === "run") inner.canOpen = false;
      }
    }
  }
  return pieces;
}

function inlineMarkdown(value: string): string {
  return inlinePieces(value).map((piece) => piece.kind === "text" ? escapeHtml(piece.text)
    : piece.kind === "html" ? piece.html
      : `${piece.closes.join("")}${piece.marker.repeat(piece.left)}${piece.opens.join("")}`).join("");
}


/** Block lines as the renderer reads them; the streaming healer (stream-markdown.ts) reads them the same way. */
const MARKDOWN_FENCE = /^\s*```([\w-]*)\s*$/;
/** Six levels, as Markdown has: a model writes "#### a." for a sub-section, and three levels left it printed raw. */
const MARKDOWN_HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const MARKDOWN_QUOTE = /^>\s?(.*)$/;
const MARKDOWN_UNORDERED = /^\s*[-*+]\s+(.+)$/;
const MARKDOWN_ORDERED = /^\s*(\d+)[.)]\s+(.+)$/;
/** CommonMark's thematic break: three or more of one of `-`, `*`, `_` alone on a line, spaces between allowed. */
const MARKDOWN_THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** How far in a marker must sit to be a child of the item above, not its sibling. */
const LIST_STEP = 2;

/** Columns a list marker sits in from: a tab counts as four, the way an editor shows it. */
function indentOf(line: string): number {
  return (line.match(/^[ \t]*/)?.[0] ?? "").replaceAll("\t", "    ").length;
}

/**
 * Markdown to HTML, for the subset an answer uses.
 *
 * A list item indented under another is its child: the lists nest, so a tree reads as a tree. Every
 * marker used to open an item of one flat list whatever its indent — a catalogue of twelve groups
 * and their tasks came out as one column of sixty bullets, the group names told apart only by being
 * bold. An ordered list that resumes after something else keeps its numbers (`start`), since
 * "1. … 2. … 3. …" with bullets between them used to render as "1. … 1. … 1. …". A pipe table is a
 * table: it used to fall through to a paragraph, every row's pipes and dashes run together in one line.
 */
/** "Title ##" without its closing hashes, scanned once from the end (a pattern for it backtracked on long runs of spaces). */
function withoutClosingHashes(title: string): string {
  let end = title.length;
  while (end > 0 && title[end - 1] === "#") end -= 1;
  if (end === title.length || end === 0 || (title[end - 1] !== " " && title[end - 1] !== "\t")) return title;
  return title.slice(0, end).trimEnd();
}

function renderMarkdown(markdown: string): string {
  const lines = plainSymbols(String(markdown)).replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  const lists: { readonly type: "ul" | "ol"; readonly indent: number }[] = [];
  let paragraph: string[] = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines: string[] = [];
  /** Closes open lists, innermost first, down to the one an item at `indent` belongs to. */
  const closeList = (indent = -LIST_STEP) => {
    while (lists.length > 0 && lists[lists.length - 1]!.indent >= indent + LIST_STEP) output.push(`</li></${lists.pop()!.type}>`);
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushBlocks = () => { flushParagraph(); closeList(); };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = MARKDOWN_FENCE.exec(line);
    if (fence) {
      if (inCode) {
        output.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        codeLanguage = "";
        inCode = false;
      } else {
        flushBlocks();
        inCode = true;
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!line.trim()) { flushBlocks(); continue; }
    // Linear patterns only: a lazy group before optional trailing hashes backtracked quadratically on long blank lines.
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1]?.length ?? 1;
      const title = withoutClosingHashes((heading[2] ?? "").trimEnd());
      output.push(`<h${level}>${inlineMarkdown(title)}</h${level}>`);
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "") && (lines[index + 1] ?? "").includes("-")) {
      flushBlocks();
      const rows: string[] = [];
      let next = index + 2;
      while (next < lines.length && TABLE_ROW.test(lines[next] ?? "")) { rows.push(lines[next] ?? ""); next += 1; }
      output.push(renderTable(line, lines[index + 1] ?? "", rows));
      index = next - 1;
      continue;
    }
    // After the table (a `---` under a header row is its rule), before the list (`- - -` is a rule, not an item).
    if (MARKDOWN_THEMATIC_BREAK.test(line)) { flushBlocks(); output.push("<hr>"); continue; }
    const quote = MARKDOWN_QUOTE.exec(line);
    if (quote) { flushBlocks(); output.push(`<blockquote>${inlineMarkdown(quote[1] ?? "")}</blockquote>`); continue; }
    const unordered = MARKDOWN_UNORDERED.exec(line);
    const ordered = MARKDOWN_ORDERED.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? "ul" : "ol";
      const indent = indentOf(line);
      closeList(indent);
      const open = lists[lists.length - 1];
      // Same depth, other marker: one list ends and another begins, as before.
      if (open && open.indent > indent - LIST_STEP && open.type !== type) output.push(`</li></${lists.pop()!.type}>`);
      const sibling = lists[lists.length - 1];
      if (sibling && sibling.indent > indent - LIST_STEP) output.push("</li>");
      else {
        const start = ordered && ordered[1] !== "1" ? ` start="${Number(ordered[1])}"` : "";
        // A child whose parent is not in this block — a blank line came between them — still sits in.
        const orphan = lists.length === 0 && indent >= LIST_STEP ? ' class="acw-list-inner"' : "";
        output.push(`<${type}${start}${orphan}>`);
        lists.push({ type, indent });
      }
      output.push(`<li>${inlineMarkdown(unordered?.[1] ?? ordered?.[2] ?? "")}`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushBlocks();
  return output.join("");
}
