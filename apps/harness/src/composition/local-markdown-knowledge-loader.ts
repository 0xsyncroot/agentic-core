import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { KnowledgeDocument } from "@0xsyncroot/contracts";
import { createKnowledgeDocument } from "@0xsyncroot/plugins-base";

const MAX_DOCUMENT_BYTES = 1_000_000;

async function markdownFiles(path: string): Promise<string[]> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return path.endsWith(".md") && info.size <= MAX_DOCUMENT_BYTES ? [path] : [];
  if (!info.isDirectory()) return [];

  const files: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".md") && (await lstat(child)).size <= MAX_DOCUMENT_BYTES) {
      files.push(child);
    }
  }
  return files;
}

export async function loadLocalMarkdownKnowledge(
  configuredRoots: readonly string[],
  workspace = resolve(process.cwd()),
): Promise<readonly KnowledgeDocument[]> {
  const documents: KnowledgeDocument[] = [];
  const workspaceRoot = await realpath(resolve(workspace));
  for (const configuredRoot of configuredRoots) {
    const candidate = resolve(workspaceRoot, configuredRoot);
    if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${sep}`)) {
      throw new Error(`Knowledge root escapes the trusted workspace: ${configuredRoot}`);
    }
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`Knowledge root must not be a symbolic link: ${configuredRoot}`);
    }
    const root = await realpath(candidate);
    if (root !== workspaceRoot && !root.startsWith(`${workspaceRoot}${sep}`)) {
      throw new Error(`Knowledge root resolves outside the trusted workspace: ${configuredRoot}`);
    }
    for (const file of await markdownFiles(root)) {
      const content = await readFile(file, "utf8");
      const sourceRef = relative(workspace, file).split(sep).join("/");
      documents.push(createKnowledgeDocument({
        id: sourceRef,
        title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(file, ".md"),
        content,
        sourceRef,
        classification: "internal",
      }));
    }
  }
  return documents;
}
