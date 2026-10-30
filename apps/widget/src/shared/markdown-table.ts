/**
 * @internal Pipe tables: how each column reads, and the markup the full-size view hooks onto.
 *
 * Seen in a 480px panel: a four-column report squeezed until a money value broke into
 * "+38." / "035." / "266," / "06", a two-word header stacked one syllable per line, and the one
 * column of prose took the width. The bubble lets text break anywhere (`overflow-wrap: anywhere`),
 * which also shrinks every column's narrowest width to a single character, so the prose column
 * won every negotiation. A column is now judged by what is in it — figures stay on one line and
 * line up on the right, a column of single tokens stays on one line, prose wraps between words
 * from a sensible minimum width — and a table wider than the bubble scrolls inside its own frame.
 * Nothing here names a language: a figure is digits, grouping marks, a sign, a currency symbol
 * or a unit of at most three letters, whatever locale wrote it.
 */

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** An amount, a count, a share: `+38.035.266,06`, `−1,234.5`, `(1.200)`, `12,5%`, `$1,200`, `35 kg`. */
const TABLE_FIGURE = /^\(?[+\-\u2212\u00b1]?\s?\p{Sc}?\s?\d[\d.,'\u00a0\u202f ]*(?:\s?(?:%|\u2030|\p{Sc}|\p{L}{1,3}\.?))?\)?$/u;
/** No letter and no digit: a dash, an ellipsis, an empty cell. It says nothing about its column. */
const TABLE_PLACEHOLDER = /^[^\p{L}\p{N}]*$/u;
/** One word that should not be split across lines: a code, a date, `84/84`, `A-12`. */
const TABLE_TOKEN = /^\S{1,20}$/u;
/** Past this many characters a cell is a phrase (a row's label), and its column does not shrink to one word a line. */
/** A line break written inside a cell, the way GitHub tables take one: the only markup a cell keeps. */
const TABLE_CELL_BREAK = /<br\s*\/?>/giu;
const TABLE_PHRASE_CHARS = 12;
/** Past this many characters a cell is prose, and its column keeps a readable minimum width. */
const TABLE_PROSE_CHARS = 40;

const TABLE_EXPAND_LABEL = "Phóng to bảng";
const TABLE_EXPAND_ICON = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.5 3.333h4.167V7.5M7.5 16.667H3.333V12.5m13.334-9.167-5 5m-8.334 8.334 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** What a reader sees of a cell, emphasis and link targets left out: the text its column is judged by. */
function tableCellText(cell: string): string {
  return cell.replace(TABLE_CELL_BREAK, " ").replace(/\[([^\]]+)\]\([^)\s]+\)/gu, "$1").replace(/[*_`]/gu, "").trim();
}

type TableColumnKind = "figure" | "token" | "prose";

/** A column is figures (or tokens) only when every cell that says anything is one. */
function tableColumnKind(cells: readonly string[]): TableColumnKind {
  const meaningful = cells.filter((cell) => !TABLE_PLACEHOLDER.test(cell));
  if (meaningful.length === 0) return "prose";
  if (meaningful.every((cell) => TABLE_FIGURE.test(cell))) return "figure";
  return meaningful.every((cell) => TABLE_TOKEN.test(cell)) ? "token" : "prose";
}

/** The rule's own alignment, kept where the content does not decide it: `---:` right, `:---:` centred. */
function tableRuleAlignment(cell: string): string {
  if (cell.endsWith(":") && !cell.startsWith(":")) return "acw-cell-end";
  return cell.endsWith(":") && cell.startsWith(":") ? "acw-cell-center" : "";
}

/**
 * A pipe table: a header row, the rule under it, then the rows.
 *
 * The frame scrolls sideways when the table is wider than the bubble, and carries the button that
 * opens the same table at full size (ui/table-viewer.ts). Every cell still goes through
 * `inlineMarkdown`, so nothing in a cell reaches the page as markup but a `<br>` line break.
 */
function renderTable(header: string, rule: string, rows: readonly string[]): string {
  const headCells = tableCells(header);
  const bodyCells = rows.map(tableCells);
  const alignments = tableCells(rule).map(tableRuleAlignment);
  const kinds = headCells.map((_, column) => tableColumnKind(bodyCells.map((cells) => tableCellText(cells[column] ?? ""))));
  const columnClass = (column: number): string => {
    const kind = kinds[column];
    if (kind === "figure") return "acw-cell-figure";
    return [kind === "token" ? "acw-cell-nowrap" : "", alignments[column] ?? ""].filter(Boolean).join(" ");
  };
  /**
   * A header stays on one line only while it is short; a longer one wraps between words from a
   * minimum width, over a figure column too (still on the right), rather than widening its column
   * to the whole phrase or shrinking to one word a line.
   */
  const headerClass = (text: string, column: number): string => {
    const short = text.length <= TABLE_PHRASE_CHARS;
    if (kinds[column] === "figure") return short ? "acw-cell-figure" : "acw-cell-end acw-cell-phrase";
    return [alignments[column] ?? "", short ? "acw-cell-nowrap" : "acw-cell-phrase"].filter(Boolean).join(" ");
  };
  const bodyClass = (text: string, column: number): string => {
    const length = kinds[column] === "prose" ? text.length : 0;
    const width = length > TABLE_PROSE_CHARS ? "acw-cell-text" : length > TABLE_PHRASE_CHARS ? "acw-cell-phrase" : "";
    return [columnClass(column), width].filter(Boolean).join(" ");
  };
  const cell = (tag: "th" | "td", content: string, column: number): string => {
    const classes = (tag === "th" ? headerClass : bodyClass)(tableCellText(content), column);
    // Each line of the cell is inline Markdown on its own; the space before a break keeps the lines apart in a copied table.
    const lines = content.split(TABLE_CELL_BREAK).map((line) => inlineMarkdown(line.trim()));
    return `<${tag}${classes ? ` class="${classes}"` : ""}>${lines.join(" <br>")}</${tag}>`;
  };
  const head = headCells.map((content, column) => cell("th", content, column)).join("");
  // A short row is padded to the header; a long one keeps its extra cells rather than losing them.
  const body = bodyCells.map((cells) => `<tr>${Array.from({ length: Math.max(headCells.length, cells.length) },
    (_, column) => cell("td", cells[column] ?? "", column)).join("")}</tr>`).join("");
  return `<div class="acw-table-block"><div class="acw-table-tools"><button type="button" class="acw-table-expand" aria-haspopup="dialog" aria-label="${
    TABLE_EXPAND_LABEL}" title="${TABLE_EXPAND_LABEL}">${TABLE_EXPAND_ICON}</button></div><div class="acw-table"><table><thead><tr>${
    head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
