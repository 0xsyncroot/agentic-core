import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Proves an edit touched comments only. For each TS/JS file the version at a base revision and the working file are
// compiled with `ts.transpileModule(removeComments)`; equal output means the emitted code is the same token for token.
// Emit erases types, so the parsed tree is also printed without comments, types kept: an edit to a parameter's type, an
// interface field or a type alias changes what the compiler checks and is DIFFERENT even though the emit is the same.
// The parser decides what is a comment, so a regex literal ending in `\/` is never mistaken for one (a raw scanner is).
//
// Comments that tools read are code for this purpose: `@ts-*` directives, triple-slash references, lint and coverage
// pragmas and bundler annotations change the build without changing the emit, so their multiset must match too.
//
// Usage: node scripts/comment-identity.mjs [--base <rev>] <file|directory>...  (base defaults to HEAD)
// A directory stands for every TS/JS file under it that differs from the base, untracked files included.
// Exit 0 when every file is IDENTICAL or SKIPPED (not TS/JS); 1 on DIFFERENT, ADDED, DELETED or a syntax error.

const CODE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
const DIRECTIVE = /^(?:@ts-|eslint-|prettier-ignore|[@#]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore|webpack[A-Z]\w*:|c8 ignore|istanbul ignore|node:coverage|@jsx|@preserve|@license)/u;

const compilerOptions = {
  removeComments: true,
  allowJs: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
};

/** The comment-free emit of one file plus its syntax errors, as the compiler reports them. */
export function emit(text, fileName) {
  const output = ts.transpileModule(text, { fileName, compilerOptions, reportDiagnostics: true });
  const errors = (output.diagnostics ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  return { code: output.outputText, errors };
}

const scriptKind = (fileName) => /\.[cm]?tsx?$/u.test(fileName) ? (fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  : fileName.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** The parsed tree printed back without comments, types included. */
export function typedTree(text, fileName) {
  return printer.printFile(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind(fileName)));
}

/** Every comment the parser sees, found at each token's leading and trailing positions. */
export function comments(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) found.set(range.pos, text.slice(range.pos, range.end));
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, comment]) => comment);
}

/** A comment some tool reads: a line of its body opens with a directive, or it is `/*!` or a triple-slash reference. */
const isDirective = (comment) => comment.startsWith("/*!") || /^\/\/\/\s*<(?:reference|amd)/u.test(comment)
  || comment.replace(/^\/[/*]+|\*\/$/gu, "").split("\n").some((line) => DIRECTIVE.test(line.trim().replace(/^\*+\s*/u, "")));

const directives = (text, fileName) => comments(text, fileName).filter(isDirective).sort();

/**
 * Compares two versions of one file. `before` or `after` is undefined when the file is absent on that side.
 * Returns { status, detail } with status IDENTICAL | DIFFERENT | ADDED | DELETED | SKIPPED.
 */
export function compare(before, after, fileName) {
  if (!CODE_EXTENSIONS.has(extname(fileName))) return { status: "SKIPPED", detail: "not a TS/JS file" };
  if (before === undefined && after === undefined) return { status: "SKIPPED", detail: "absent on both sides" };
  if (before === undefined) return { status: "ADDED", detail: "a comment-only edit adds no code file" };
  if (after === undefined) return { status: "DELETED", detail: "a comment-only edit deletes no code file" };
  const old = emit(before, fileName);
  const now = emit(after, fileName);
  if (now.errors.length > old.errors.length) return { status: "DIFFERENT", detail: `syntax error: ${now.errors[0]}` };
  if (old.code !== now.code) return { status: "DIFFERENT", detail: firstDifference(old.code, now.code) };
  const oldTree = typedTree(before, fileName);
  const nowTree = typedTree(after, fileName);
  if (oldTree !== nowTree) return { status: "DIFFERENT", detail: `types: ${firstDifference(oldTree, nowTree)}` };
  const oldDirectives = directives(before, fileName);
  const newDirectives = directives(after, fileName);
  if (oldDirectives.join("\n") !== newDirectives.join("\n")) {
    const lost = oldDirectives.filter((line) => !newDirectives.includes(line));
    const gained = newDirectives.filter((line) => !oldDirectives.includes(line));
    return { status: "DIFFERENT", detail: `tool directive comments changed: -${JSON.stringify(lost)} +${JSON.stringify(gained)}` };
  }
  return { status: "IDENTICAL", detail: `${now.code.length} chars emitted` };
}

function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  const line = left.findIndex((text, index) => text !== right[index]);
  const at = line === -1 ? left.length : line;
  return `emit line ${at + 1}: ${JSON.stringify(left[at] ?? "<end>")} → ${JSON.stringify(right[at] ?? "<end>")}`;
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

function atBase(root, base, path) {
  try {
    return git(root, ["show", `${base}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Repository-relative paths the arguments name: files as given, directories as their changed TS/JS files. */
export function expand(root, base, targets) {
  const paths = new Set();
  for (const target of targets) {
    const path = relative(root, resolve(root, target)).split("\\").join("/");
    if (existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()) {
      paths.add(path);
      continue;
    }
    const changed = git(root, ["diff", "--name-only", "--no-renames", base, "--", path]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", path]);
    for (const file of `${changed}\n${untracked}`.split("\n")) {
      if (file && CODE_EXTENSIONS.has(extname(file))) paths.add(file);
    }
  }
  return [...paths].sort();
}

/** Runs the comparison over `targets` and returns one row per file. */
export function checkIdentity(root, base, targets) {
  return expand(root, base, targets).map((path) => {
    const file = resolve(root, path);
    const after = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    return { path, ...compare(atBase(root, base, path), after, path) };
  });
}

const PASSING = new Set(["IDENTICAL", "SKIPPED"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  const base = at === -1 ? "HEAD" : args[at + 1];
  const targets = at === -1 ? args : args.filter((_, index) => index !== at && index !== at + 1);
  if (!base || targets.length === 0) {
    console.error("usage: node scripts/comment-identity.mjs [--base <rev>] <file|directory>...");
    process.exit(2);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const rows = checkIdentity(root, base, targets.map((target) => resolve(target)));
  for (const row of rows) console.log(`${row.status.padEnd(9)} ${row.path}  (${row.detail})`);
  const failed = rows.filter((row) => !PASSING.has(row.status));
  const identical = rows.filter((row) => row.status === "IDENTICAL").length;
  console.log(`${rows.length} files vs ${base}: ${identical} identical, ${failed.length} failing`);
  process.exit(failed.length === 0 ? 0 : 1);
}
