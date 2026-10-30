import { readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import type { SourceAnchor } from "./legacy-replica.js";

/**
 * The code an anchor names, printed from the syntax tree without comments: what the replica must track. A comment edit or a
 * reformat prints the same; any change to the code itself prints differently.
 *
 * The anchor is the smallest node of its kind whose source contains the marker. No such node, or two of the same size, is an
 * error: the anchor no longer says which code it means.
 */
export function anchoredCode(text: string, anchor: SourceAnchor): string {
  const source = ts.createSourceFile(anchor.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kind = ts.SyntaxKind[anchor.kind as keyof typeof ts.SyntaxKind];
  if (kind === undefined) throw new Error(`unknown syntax kind ${anchor.kind}`);
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === kind && node.getText(source).includes(anchor.marker)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const width = Math.min(...found.map((node) => node.getWidth(source)));
  const smallest = found.filter((node) => node.getWidth(source) === width);
  if (smallest.length !== 1) throw new Error(`${anchor.file}: ${smallest.length} ${anchor.kind} nodes hold "${anchor.marker}"`);
  return ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, smallest[0]!, source);
}

export const anchorKey = (anchor: SourceAnchor): string => `${anchor.file} ${anchor.kind} ${anchor.marker}`;

/** The frozen copy of an anchor's file, in `sources` (legacy-sources/). */
export const frozenSource = (sources: URL, anchor: SourceAnchor): string => readFileSync(new URL(basename(anchor.file), sources), "utf8");

/** Every anchor's code, keyed by anchor, read from the frozen copies in `sources`. */
export function snapshotAnchors(sources: URL, anchors: readonly SourceAnchor[]): Record<string, string> {
  return Object.fromEntries(anchors.map((anchor) => [anchorKey(anchor), anchoredCode(frozenSource(sources, anchor), anchor)]));
}
