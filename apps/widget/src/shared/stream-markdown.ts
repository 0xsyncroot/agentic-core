/// <reference path="./content.ts" />
/**
 * @internal Markdown still being written, made safe to render as it stands.
 *
 * A narration streams for seconds. Rendered raw, its unfinished end showed what the finished text
 * never does: `**` before its closer arrived, a table's header as a line of pipes until its rule
 * line ended, a list marker alone, half a link, half a TeX span; then it snapped into format at its
 * end. Each frame renders
 * `renderMarkdown(healStreamedMarkdown(text))`. What can still change is withheld, or closed the way
 * the renderer itself reads it once complete; nothing here counts characters, it asks the renderer's
 * own block patterns and run scan (content.ts) what they would make of the text.
 */

/** A bare list or heading marker: the renderer's patterns without their text group (a number is "1." half written). */
const BARE_MARKER = /^\s*(?:[-*+]|\d+[.)]?)\s*$|^ {0,3}#{1,6}[ \t]*$/;
/** What a thematic break can still grow from: one or two of its markers. With the full break it waits for its line break, since `---b` is text. */
const THEMATIC_BREAK_START = /^ {0,3}([-*_])(?:[ \t]*\1)?[ \t]*$/;
/** What a table's rule line can still grow from. */
const RULE_PREFIX = /^[\s|:-]*$/;
/** `[text`, `[text]` or `[text](address-so-far` at the very end. */
const HALF_LINK = /\[([^\]\n]*)(?:\]|\]\([^)\s]*)?$/;
/** plainMath's spans (tex.ts), tried at one position. */
const MATH_SPAN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/y;
/** plainSymbols' split of inline code out of prose (tex.ts). */
const INLINE_CODE_SPLIT = /(`[^`\n]*`)/;

type StreamLineRole = "fence" | "code" | "blank" | "heading" | "table" | "rule" | "quote" | "list" | "paragraph";

/** Each finished line as renderMarkdown reads it, and whether a code fence is still open after them. */
function streamLineRoles(lines: readonly string[]): { readonly roles: StreamLineRole[]; readonly inCode: boolean } {
  const roles: StreamLineRole[] = [];
  let inCode = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (MARKDOWN_FENCE.test(line)) { inCode = !inCode; roles.push("fence"); continue; }
    if (inCode) { roles.push("code"); continue; }
    if (!line.trim()) { roles.push("blank"); continue; }
    if (MARKDOWN_HEADING.test(line)) { roles.push("heading"); continue; }
    const rule = lines[index + 1];
    if (TABLE_ROW.test(line) && rule !== undefined && TABLE_RULE.test(rule) && rule.includes("-")) {
      roles.push("table", "table");
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) { roles.push("table"); index += 1; }
      index -= 1;
      continue;
    }
    roles.push(MARKDOWN_THEMATIC_BREAK.test(line) ? "rule" : MARKDOWN_QUOTE.test(line) ? "quote" : MARKDOWN_UNORDERED.test(line) || MARKDOWN_ORDERED.test(line) ? "list" : "paragraph");
  }
  return { roles, inCode };
}

/** Where a math span still open at the end starts, if it would turn to text once closed (rule: it holds a backslash). */
function openMathStart(text: string, from: number): number {
  const pieces = text.slice(from).split(INLINE_CODE_SPLIT);
  // Code splits prose apart, so only the last prose piece can still be closed.
  const prose = pieces.length % 2 === 1 ? pieces[pieces.length - 1] ?? "" : "";
  const offset = text.length - prose.length;
  for (let index = 0; index < prose.length; index += 1) {
    MATH_SPAN.lastIndex = index;
    const span = MATH_SPAN.exec(prose);
    if (span) { index += span[0].length - 1; continue; }
    const rest = prose.slice(index);
    // Nothing after it yet: whether this opens a span is not known, and shown now it could vanish a frame later.
    if (rest === "$" || rest === "$$" || rest === "\\") return offset + index;
    const opener = rest.startsWith("$$") || rest.startsWith("\\[") || rest.startsWith("\\(") ? 2 : rest.startsWith("$") ? 1 : 0;
    if (opener === 0) continue;
    // A `$` span is one line long: past a line break this `$` is an amount, written as it stands.
    if (opener === 1 && rest.includes("\n")) continue;
    if (rest.includes("\\")) return offset + index;
  }
  return -1;
}

/** The inline text the last block is made of, when that block can still change; "" when it cannot. */
function openInlineText(lines: readonly string[], roles: readonly StreamLineRole[], partial: string): string {
  if (partial) {
    const heading = MARKDOWN_HEADING.exec(partial);
    if (heading) return heading[2] ?? "";
    const quote = MARKDOWN_QUOTE.exec(partial);
    if (quote) return quote[1] ?? "";
    const item = MARKDOWN_UNORDERED.exec(partial) ?? MARKDOWN_ORDERED.exec(partial);
    if (item) return item[item.length - 1] ?? "";
  }
  // A paragraph goes on until a blank line or another block: its finished lines are part of it.
  let first = lines.length;
  while (first > 0 && roles[first - 1] === "paragraph") first -= 1;
  return [...lines.slice(first), ...(partial ? [partial] : [])].map((line) => line.trim()).join(" ");
}

/** Whether the text ends in the closing backtick of an inline code span. */
function endsInCode(inline: string): boolean {
  return inline.endsWith("`") && inlinePieces(plainSymbols(inline)).at(-1)?.kind === "html";
}

/** The closers for every run the renderer would open but found no closer for, innermost first. */
function emphasisClosers(inline: string): string {
  return inlinePieces(plainSymbols(inline)).filter((piece): piece is EmphasisRun => piece.kind === "run" && piece.canOpen && piece.left > 0)
    .reverse().map((run) => run.marker.repeat(run.left)).join("");
}

function healStreamedMarkdown(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  // The last line is still being written; every line before it has ended.
  let partial = lines.pop() ?? "";
  const { roles, inCode } = streamLineRoles(lines);
  const fencePartial = MARKDOWN_FENCE.test(partial);
  // Inside an open fence the text is code: closed here, symbols inside it stay as written (plainSymbols skips closed fences only).
  if (inCode !== fencePartial) {
    const kept = partial === "" || /^\s*`{1,2}$/.test(partial) ? lines : [...lines, partial];
    return `${kept.join("\n")}\n\`\`\``;
  }
  if (fencePartial) return markdown;
  // Tables: a header waits for its finished rule line; after that only the row being written waits.
  const last = lines.length - 1;
  if (RULE_PREFIX.test(partial) && roles[last] === "paragraph" && TABLE_ROW.test(lines[last] ?? "")) { lines.pop(); partial = ""; }
  if (partial.trimStart().startsWith("|") || BARE_MARKER.test(partial) || THEMATIC_BREAK_START.test(partial) || MARKDOWN_THEMATIC_BREAK.test(partial)) partial = "";
  let text = [...lines, partial].join("\n");
  // Math: an open TeX span waits for its end rather than showing its backslashes, then text for a frame.
  const fence = roles.lastIndexOf("fence");
  const math = openMathStart(text, fence < 0 ? 0 : lines.slice(0, fence + 1).join("\n").length + 1);
  if (math >= 0) text = text.slice(0, math);
  const finished = lines.slice(0, text.split("\n").length - 1);
  partial = text.slice(text.lastIndexOf("\n") + 1);
  if (partial) {
    // A link without its ")" reads as its words: neither dropped (they would come back) nor shown in brackets.
    const link = HALF_LINK.exec(text);
    if (link) text = text.slice(0, link.index) + (link[1] ?? "");
    // A marker run at the very end may be half of a closer or the start of an opener: neither shows yet.
    for (let run = /([*_`])\1*$/.exec(text); run && text[run.index - 1] !== "\\"; run = /([*_`])\1*$/.exec(text)) {
      if (run[1] === "`" && endsInCode(openInlineText(finished, roles, text.slice(text.lastIndexOf("\n") + 1)))) break;
      text = text.slice(0, run.index);
    }
    partial = text.slice(text.lastIndexOf("\n") + 1);
  }
  const inline = openInlineText(finished, roles, partial);
  const closers = inline ? emphasisClosers(inline) : "";
  if (!closers) return text;
  // A closer needs a non-space before it, so it goes in front of any trailing whitespace.
  const end = text.trimEnd().length;
  return text.slice(0, end) + closers + text.slice(end);
}
