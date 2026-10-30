import { parsePath, type PathStep } from "./path.js";

/**
 * What a personal value is, which decides how its variants are formed and which label replaces it. A `coefficient` is a
 * person's salary factor or rate: a small decimal that no money minimum would keep, so it is masked by its marked value alone.
 */
export type PersonalKind = "person-name" | "money" | "identifier" | "coefficient";
/**
 * A table column's kind. `none` keeps a column visible even where numeric cells would otherwise count as money; `sequence` is
 * the row-number column: once a table has one, only rows holding a whole number from 1 in it are data rows, so headings, group
 * captions and totals are never collected.
 */
export type ColumnKind = PersonalKind | "none" | "sequence";
export const PERSONAL_KINDS: readonly PersonalKind[] = ["person-name", "money", "identifier", "coefficient"];

/**
 * A table inside a tool result: `rows` (objects whose keys are column titles, or arrays whose positions are columns) or
 * addressed `cells`. A column's kind comes from its titles (`headers`, or the row key), else from a cell above it in the same
 * column whose text is a configured heading. Numeric cells of a column without a kind take `numbers`.
 */
export interface PersonalTableRule {
  readonly rows?: string;
  readonly cells?: string;
  /**
   * Field names inside one cell: row and column numbers, or an A1 address, and the value. `addressPattern` is a regular
   * expression over the address field whose single capture group is the A1 address, for cells that carry it inside a caption.
   */
  readonly cell?: {
    readonly row?: string; readonly column?: string; readonly address?: string; readonly addressPattern?: string; readonly value: string;
  };
  /** Cell text written with these group and decimal separators is read as a number, as the tool's screen or file shows it. */
  readonly numberFormat?: NumberFormat;
  /** Column titles: objects at `path`, each naming its column by `key` and its titles by `titles` (text or list of text). */
  readonly headers?: { readonly path: string; readonly key: string; readonly titles: string };
  /** Paths to the first and last data row; rows outside them are headings or totals. */
  readonly firstRow?: string;
  readonly lastRow?: string;
  /** Normalised heading → kind. A title matches when it equals the heading or starts with it and a space. */
  readonly columns: Readonly<Record<string, ColumnKind>>;
  readonly numbers?: PersonalKind;
}

export interface NumberFormat { readonly group: string; readonly decimal: string }

/**
 * Personal marks of one tool's result, filed under its tool id or under `prefix*` for every tool id that starts with the prefix.
 * Paths are dot-separated keys; `[]` walks an array, `*` any key, `**` any depth.
 */
export interface ToolPersonalFields {
  readonly paths?: Readonly<Record<string, PersonalKind>>;
  readonly tables?: readonly PersonalTableRule[];
}

/**
 * The structured masking configuration a product supplies: which result fields hold personal values, the words labels use, and
 * the forms numbers and names take in the product's language. Values are only ever taken from tool results through these marks.
 */
export interface PersonalFieldConfig {
  readonly labels: Readonly<Record<PersonalKind, string>>;
  /** Money below `atLeast` is not personal (counts, days, rates); `units` are scale words written after a number. */
  readonly money: { readonly atLeast: number; readonly units?: readonly { readonly word: string; readonly factor: number }[] };
  /** Words written before a given name; a name of fewer than `minWords` words is not collected. */
  readonly names: { readonly honorifics: readonly string[]; readonly minWords: number };
  readonly tools: Readonly<Record<string, ToolPersonalFields>>;
}

export interface CompiledTableRule {
  readonly rows?: readonly PathStep[];
  readonly cells?: readonly PathStep[];
  readonly cell: { readonly row?: string; readonly column?: string; readonly address?: string; readonly addressPattern?: RegExp; readonly value: string };
  readonly numberFormat?: NumberFormat;
  readonly headers?: { readonly path: readonly PathStep[]; readonly key: string; readonly titles: string };
  readonly firstRow?: readonly PathStep[];
  readonly lastRow?: readonly PathStep[];
  readonly columns: ReadonlyMap<string, ColumnKind>;
  readonly numbers?: PersonalKind;
}

export interface CompiledToolFields {
  readonly paths: readonly { readonly steps: readonly PathStep[]; readonly kind: PersonalKind }[];
  readonly tables: readonly CompiledTableRule[];
}

export interface CompiledPersonalFields {
  readonly labels: Readonly<Record<PersonalKind, string>>;
  readonly moneyAtLeast: number;
  readonly units: readonly { readonly word: string; readonly factor: number }[];
  readonly honorifics: readonly (readonly string[])[];
  readonly minWords: number;
  readonly tools: ReadonlyMap<string, CompiledToolFields>;
  /** Keys ending in `*`, longest prefix first. */
  readonly toolPrefixes: readonly { readonly prefix: string; readonly fields: CompiledToolFields }[];
}

/** The marks of one tool: its exact key, else the longest `prefix*` key it starts with, so the most specific entry wins. */
export function toolFieldsOf(fields: CompiledPersonalFields, toolId: string): CompiledToolFields | undefined {
  return fields.tools.get(toolId) ?? fields.toolPrefixes.find((entry) => toolId.startsWith(entry.prefix))?.fields;
}

/** Lowercase NFC words of a heading or a name, joined by one space: punctuation and brackets are not part of a title. */
export function normalizeWords(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

function kindOf(value: unknown, where: string, column: boolean): ColumnKind {
  if ((PERSONAL_KINDS as readonly unknown[]).includes(value) || (column && (value === "none" || value === "sequence"))) return value as ColumnKind;
  throw new Error(`${where}: unknown kind ${JSON.stringify(value)}`);
}

function compileAddressPattern(source: string, field: string | undefined, where: string): RegExp {
  if (field === undefined) throw new Error(`${where}: addressPattern needs an address field`);
  let pattern: RegExp;
  try { pattern = new RegExp(source, "u"); } catch { throw new Error(`${where}: invalid addressPattern ${JSON.stringify(source)}`); }
  const groups = (new RegExp(`${source}|`, "u").exec("")?.length ?? 1) - 1;
  if (groups !== 1) throw new Error(`${where}: addressPattern needs exactly one capture group`);
  return pattern;
}

function compileTable(rule: PersonalTableRule, where: string): CompiledTableRule {
  if ((rule.rows === undefined) === (rule.cells === undefined)) throw new Error(`${where}: a table names exactly one of rows or cells`);
  const { addressPattern, ...cell } = rule.cell ?? { value: "value" };
  if (rule.cells !== undefined && cell.address === undefined && (cell.row === undefined || cell.column === undefined)) {
    throw new Error(`${where}: cells need row and column fields, or an address field`);
  }
  const pattern = addressPattern !== undefined ? compileAddressPattern(addressPattern, cell.address, where) : undefined;
  const format = rule.numberFormat;
  if (format && (!/^\D$/u.test(format.group) || !/^\D$/u.test(format.decimal) || format.group === format.decimal)) {
    throw new Error(`${where}: numberFormat needs two different one-character separators`);
  }
  const columns = new Map<string, ColumnKind>();
  for (const [heading, kind] of Object.entries(rule.columns)) {
    const words = normalizeWords(heading);
    if (words === "") throw new Error(`${where}: empty column heading`);
    columns.set(words, kindOf(kind, `${where}.columns.${heading}`, true));
  }
  return {
    ...(rule.rows !== undefined ? { rows: parsePath(rule.rows) } : {}),
    ...(rule.cells !== undefined ? { cells: parsePath(rule.cells) } : {}),
    cell: { ...cell, ...(pattern ? { addressPattern: pattern } : {}) },
    ...(format ? { numberFormat: format } : {}),
    ...(rule.headers ? { headers: { path: parsePath(rule.headers.path), key: rule.headers.key, titles: rule.headers.titles } } : {}),
    ...(rule.firstRow !== undefined ? { firstRow: parsePath(rule.firstRow) } : {}),
    ...(rule.lastRow !== undefined ? { lastRow: parsePath(rule.lastRow) } : {}),
    columns,
    ...(rule.numbers !== undefined ? { numbers: kindOf(rule.numbers, `${where}.numbers`, false) as PersonalKind } : {}),
  };
}

/** Validates a product's configuration once at boot; every later read trusts the compiled form. */
export function compilePersonalFields(config: PersonalFieldConfig): CompiledPersonalFields {
  for (const kind of PERSONAL_KINDS) {
    if (typeof config.labels?.[kind] !== "string" || config.labels[kind].trim() === "") throw new Error(`labels.${kind}: a label is required`);
  }
  if (!Number.isFinite(config.money?.atLeast) || config.money.atLeast < 1) throw new Error("money.atLeast must be a number of at least 1");
  const units = (config.money.units ?? []).map((unit) => {
    if (normalizeWords(unit.word) === "" || !(unit.factor > 1)) throw new Error(`money.units: invalid unit ${JSON.stringify(unit)}`);
    return { word: normalizeWords(unit.word), factor: unit.factor };
  });
  if (!Number.isInteger(config.names?.minWords) || config.names.minWords < 1) throw new Error("names.minWords must be a positive integer");
  const honorifics = config.names.honorifics.map((word) => normalizeWords(word).split(" ")).filter((words) => words[0] !== "");
  const tools = new Map<string, CompiledToolFields>();
  const toolPrefixes: { prefix: string; fields: CompiledToolFields }[] = [];
  for (const [toolId, fields] of Object.entries(config.tools)) {
    const paths = Object.entries(fields.paths ?? {}).map(([path, kind]) => ({
      steps: parsePath(path), kind: kindOf(kind, `tools.${toolId}.paths.${path}`, false) as PersonalKind,
    }));
    const compiled = { paths, tables: (fields.tables ?? []).map((table, index) => compileTable(table, `tools.${toolId}.tables[${index}]`)) };
    if (!toolId.endsWith("*")) { tools.set(toolId, compiled); continue; }
    const prefix = toolId.slice(0, -1);
    if (prefix === "" || prefix.includes("*")) throw new Error(`tools.${toolId}: a tool key may end in * after a non-empty prefix`);
    toolPrefixes.push({ prefix, fields: compiled });
  }
  toolPrefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  return { labels: config.labels, moneyAtLeast: config.money.atLeast, units, honorifics, minWords: config.names.minWords, tools, toolPrefixes };
}
