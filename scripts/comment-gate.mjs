import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { SKIPPED_DIRECTORIES } from "./skipped-directories.mjs";

// Code comments state the rule the code keeps and why, true at any time (AGENTS.md). A comment that carries a calendar day,
// quotes the project owner or names a review round is history: it belongs in an incidents file and in the commit.
//
// Only comments are read, and the TypeScript parser decides what a comment is: a date inside a string, test data or a test
// name is code and never flagged, and a regex literal ending in `\/` is not misread as the start of a line comment.

/** The trees whose comments are held to the rule. */
export const ROOTS = ["packages", "apps", "products", "mcp-servers", "scripts", "demo"];

const CODE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/u;

/** A link to an incident file names the incident by its date; the link is the way history is meant to be reached. */
const INCIDENT_LINK = /(?:products\/[\w-]+\/)?docs\/incidents\/20\d\d-\d\d-\d\d-[\w.-]+\.md/gu;

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * A calendar day in the forms people write one: ISO (time included), day/month/year with `/` or `.`, and English month names.
 * A month alone is not flagged: payroll periods are months, and comments describe them as data.
 */
const DATE_TOKEN = new RegExp([
  String.raw`(?<![\p{L}\d])20\d\d-[01]\d-[0-3]\d(?!\d)`,
  String.raw`(?<![\d/.])[0-3]?\d[/.][01]?\d[/.]20\d\d(?!\d)`,
  String.raw`\b[0-3]?\d ${MONTH}\.? 20\d\d\b`,
  String.raw`\b${MONTH}\.? [0-3]?\d(?:st|nd|rd|th)?, 20\d\d\b`,
].join("|"), "u");

/** Words the project owner was quoted with, followed by the quote. */
const OWNER_QUOTE = /(?:\bproduct owner\b|\bowner\b|chủ dự án|chủ sản phẩm)(?:\s*,\s*[^:"“”\n]{0,40})?\s*(?::|\(|\bsaid\b|\bwrote\b|\basked\b|\bnói\b|\bhỏi\b)\s*["“]/iu;

/**
 * Names of review, probe, audit, critic and QA rounds, the finding or run they name, and paths into a wave's working
 * directory. A bare letter-and-number such as "(N4)" is not one of them: the same shape is a cell ("A1"), a cache level
 * ("L1") or an eval group ("P1"), so only the forms below, which say whose round it is, are flagged.
 */
const ROUND_NAMES = [
  /\b(?:audit|review|critic)[- ]probe\b/iu,
  /\b[Pp]robe [A-Z]\d*(?:-[a-z])?\b/u,
  /\b[Ll]ive\s*\(\s*(?:20\d\d|[A-Z]+-?\d)/u,
  /\bcritic(?:-\w+)? r\d+\b/u,
  /(?<![\w-])\.wave\//u,
  /\b(?:QA|[Aa]udit)(?:-r\d+)? (?:[A-Z]\d+\b|lượt \d)/u,
  /\baudit(?:[A-Z]|\d+)\b/u,
  /\bP\d-\d+\b/u,
  /\b[A-Z]\d+-run\d+\b/u,
];

/**
 * What in one comment breaks the rule, as `{ offset, kind, token }` with the offset inside the comment.
 * `allowed` lists exact passages the comment may keep (a dated fact the code depends on); they are removed before testing.
 */
export function commentFindings(comment, allowed = []) {
  let text = comment.replace(INCIDENT_LINK, (link) => " ".repeat(link.length));
  for (const passage of allowed) text = text.split(passage).join(" ".repeat(passage.length));
  const findings = [];
  const date = DATE_TOKEN.exec(text);
  if (date) findings.push({ offset: date.index, kind: "date", token: date[0] });
  const quote = OWNER_QUOTE.exec(text);
  if (quote) findings.push({ offset: quote.index, kind: "quote of the owner", token: quote[0] });
  const round = ROUND_NAMES.map((pattern) => pattern.exec(text)).find(Boolean);
  if (round) findings.push({ offset: round.index, kind: "review round name", token: round[0] });
  return findings;
}

/** Every comment of one TS/JS source as `{ text, lineOf(offset) }`, from the leading and trailing comment ranges of every token. */
export function sourceComments(text, fileName) {
  const kind = /\.[cm]?tsx?$/u.test(fileName) ? (fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    : fileName.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
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
  const lineStarts = ts.computeLineStarts(text);
  const lineOf = (pos) => ts.computeLineAndCharacterOfPosition(lineStarts, pos).line + 1;
  return [...found.entries()].sort(([a], [b]) => a - b)
    .map(([pos, comment]) => ({ text: comment, lineOf: (offset) => lineOf(pos + offset) }));
}

/**
 * Repository-relative source files under ROOTS. In a git checkout the list is git's (tracked plus untracked, minus what
 * `.gitignore` keeps out), so generated output is out by the same rule that keeps it out of commits; elsewhere (an
 * archive, which carries no generated output) a directory walk.
 */
export function sourceFiles(root) {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS],
      { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).split("\0");
  } catch {
    listed = ROOTS.flatMap((top) => walk(resolve(root, top), top));
  }
  return [...new Set(listed)].filter((path) => CODE_FILE.test(path) && existsSync(resolve(root, path))).sort();
}

function walk(directory, relative) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walk(resolve(directory, entry.name), path));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Violations of the comment rule under `root`, plus the exceptions no comment needed.
 * `exceptions` is a list of `{ path, passage, reason }`: in that file, that exact passage may stay in a comment.
 */
export function commentViolations(root, exceptions) {
  const allowedBy = new Map();
  for (const exception of exceptions) {
    allowedBy.set(exception.path, [...allowedBy.get(exception.path) ?? [], exception.passage]);
  }
  const used = new Set();
  const violations = [];
  for (const path of sourceFiles(root)) {
    const allowed = allowedBy.get(path) ?? [];
    for (const comment of sourceComments(readFileSync(resolve(root, path), "utf8"), path)) {
      for (const passage of allowed) if (comment.text.includes(passage)) used.add(`${path}\0${passage}`);
      for (const finding of commentFindings(comment.text, allowed)) {
        violations.push(`${path}:${comment.lineOf(finding.offset)} comment carries a ${finding.kind} (${JSON.stringify(finding.token.trim())}); `
          + "state the rule the code keeps and move the story to an incidents file");
      }
    }
  }
  const unused = exceptions.filter((exception) => !used.has(`${exception.path}\0${exception.passage}`));
  return { violations, unused };
}
