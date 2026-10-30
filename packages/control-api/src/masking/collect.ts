import { normalizeWords, type ColumnKind, type CompiledTableRule, type CompiledToolFields, type NumberFormat, type PersonalKind } from "./config.js";
import { selectPath } from "./path.js";

/** Receives one raw value a mark points at; the masker decides whether it is a usable value of that kind. */
export type CollectSink = (kind: PersonalKind, value: unknown) => void;

interface GridCell { readonly row: number; readonly column: string; readonly value: unknown }

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/u;

const escapeForPattern = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");

/**
 * A number in a result: a JSON number, or text that is only digits with an optional decimal point. With a `format`, text
 * grouped by its group separator in threes and with its decimal separator (`12.700.600`, `1.333.563,5`, `22,0`) counts too.
 */
export function numericValue(value: unknown, format?: NumberFormat): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (PLAIN_NUMBER.test(text)) return Number(text);
  if (!format) return undefined;
  const group = escapeForPattern(format.group);
  const decimal = escapeForPattern(format.decimal);
  if (!new RegExp(`^-?(?:\\d{1,3}(?:${group}\\d{3})+|\\d+)(?:${decimal}\\d+)?$`, "u").test(text)) return undefined;
  return Number(text.split(format.group).join("").replace(format.decimal, "."));
}

/** `B12` → row 12, column B; anything else is not an address. */
function fromAddress(address: unknown): { row: number; column: string } | undefined {
  if (typeof address !== "string") return undefined;
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/u.exec(address.trim());
  return match?.[1] && match[2] ? { row: Number(match[2]), column: match[1].toUpperCase() } : undefined;
}

function field(record: unknown, name: string | undefined): unknown {
  return name !== undefined && record !== null && typeof record === "object" ? (record as Record<string, unknown>)[name] : undefined;
}

function items(value: unknown, steps: CompiledTableRule["rows"]): readonly unknown[] {
  return steps ? selectPath(value, steps).flatMap((found) => (Array.isArray(found) ? found : [found])) : [];
}

function gridCells(result: unknown, rule: CompiledTableRule): GridCell[] {
  const cells: GridCell[] = [];
  items(result, rule.rows).forEach((row, index) => {
    if (row === null || typeof row !== "object") return;
    for (const [column, value] of Object.entries(row)) cells.push({ row: index, column, value });
  });
  for (const cell of items(result, rule.cells)) {
    const address = field(cell, rule.cell.address);
    const caption = rule.cell.addressPattern && typeof address === "string" ? rule.cell.addressPattern.exec(address)?.[1] : address;
    const at = rule.cell.address !== undefined ? fromAddress(caption) : undefined;
    const row = at?.row ?? numericValue(field(cell, rule.cell.row));
    const column = at?.column ?? field(cell, rule.cell.column);
    if (row === undefined || (typeof column !== "string" && typeof column !== "number")) continue;
    cells.push({ row, column: String(column), value: field(cell, rule.cell.value) });
  }
  return cells.sort((a, b) => a.row - b.row);
}

/** The kind of the first configured heading a title matches: equal, or the title starts with the heading and a space. */
function headingKind(title: unknown, columns: ReadonlyMap<string, ColumnKind>): ColumnKind | undefined {
  if (typeof title !== "string") return undefined;
  const words = normalizeWords(title);
  if (words === "") return undefined;
  for (const [heading, kind] of columns) if (words === heading || words.startsWith(`${heading} `)) return kind;
  return undefined;
}

/** Column → kind from the declared titles; the last title of a multi-level header is the most specific and wins. */
function headerKinds(result: unknown, rule: CompiledTableRule): Map<string, ColumnKind> {
  const kinds = new Map<string, ColumnKind>();
  if (!rule.headers) return kinds;
  for (const entry of items(result, rule.headers.path)) {
    const key = field(entry, rule.headers.key);
    const titles = field(entry, rule.headers.titles);
    if (typeof key !== "string" && typeof key !== "number") continue;
    const kind = (Array.isArray(titles) ? [...titles].reverse() : [titles]).map((title) => headingKind(title, rule.columns)).find((found) => found);
    if (kind) kinds.set(String(key), kind);
  }
  return kinds;
}

function bound(result: unknown, steps: CompiledTableRule["firstRow"]): number | undefined {
  return steps ? selectPath(result, steps).map((value) => numericValue(value)).find((found) => found !== undefined) : undefined;
}

/** Each cell with the kind its column has at that row; a later heading in a column replaces the one above it. */
function classify(result: unknown, rule: CompiledTableRule): { readonly cell: GridCell; readonly kind: ColumnKind | undefined }[] {
  const declared = headerKinds(result, rule);
  const headed = new Map<string, ColumnKind>();
  const out: { cell: GridCell; kind: ColumnKind | undefined }[] = [];
  for (const cell of gridCells(result, rule)) {
    const heading = headingKind(cell.value, rule.columns);
    if (heading) { headed.set(cell.column, heading); continue; }
    out.push({ cell, kind: declared.get(cell.column) ?? (rule.rows ? headingKind(cell.column, rule.columns) : undefined) ?? headed.get(cell.column) });
  }
  return out;
}

function collectTable(result: unknown, rule: CompiledTableRule, sink: CollectSink): void {
  const cells = classify(result, rule);
  const first = bound(result, rule.firstRow) ?? Number.NEGATIVE_INFINITY;
  const last = bound(result, rule.lastRow) ?? Number.POSITIVE_INFINITY;
  const sequenced = cells.filter(({ kind }) => kind === "sequence");
  const numbered = new Set(sequenced.filter(({ cell }) => {
    const value = numericValue(cell.value, rule.numberFormat);
    return value !== undefined && Number.isInteger(value) && value >= 1;
  }).map(({ cell }) => cell.row));
  for (const { cell, kind } of cells) {
    if (cell.row < first || cell.row > last || kind === "none" || kind === "sequence") continue;
    if (sequenced.length > 0 && !numbered.has(cell.row)) continue;
    const number = numericValue(cell.value, rule.numberFormat);
    if (kind) sink(kind, kind === "money" || kind === "coefficient" ? number ?? cell.value : cell.value);
    else if (rule.numbers && number !== undefined) sink(rule.numbers, number);
  }
}

/** Hands every value the tool's marks reach to `sink`. A tool without marks gives nothing. */
export function collectMarked(result: unknown, fields: CompiledToolFields, sink: CollectSink): void {
  for (const mark of fields.paths) {
    for (const value of selectPath(result, mark.steps)) {
      if (Array.isArray(value)) for (const item of value) sink(mark.kind, item);
      else sink(mark.kind, value);
    }
  }
  for (const table of fields.tables) collectTable(result, table, sink);
}
