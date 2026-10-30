import { execFile } from "node:child_process";
import { access, copyFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * A real filesystem path, not a URL path.
 *
 * `URL.pathname` on Windows yields `/D:/project/...` — a leading slash before the drive letter,
 * which esbuild and child processes cannot resolve. It only ever looks correct on POSIX, so the
 * conversion has to be explicit everywhere a path leaves this file.
 */
const path = (url) => fileURLToPath(url);
import { build } from "esbuild";

const rawJavaScript = new URL("dist/agentic-chat-widget.raw.js", import.meta.url);
const rawTypes = new URL("dist/agentic-chat-widget.raw.d.ts", import.meta.url);
const outputJavaScript = new URL("dist/agentic-chat-widget.js", import.meta.url);
const outputModule = new URL("dist/agentic-chat-widget.esm.js", import.meta.url);
const outputTypes = new URL("dist/agentic-chat-widget.d.ts", import.meta.url);
const widgetDirectory = new URL("./", import.meta.url);
const typescriptCli = new URL("../../node_modules/typescript/bin/tsc", import.meta.url);
const staleArtifacts = [
  new URL("dist/agentic-chat-widget.js.map", import.meta.url),
  new URL("dist/agentic-chat-widget.d.ts.map", import.meta.url),
  new URL("dist/agentic-chat-widget.raw.js.map", import.meta.url),
  new URL("dist/agentic-chat-widget.raw.d.ts.map", import.meta.url),
];

try {
  await Promise.all([access(rawJavaScript), access(rawTypes)]);
} catch {
  await promisify(execFile)(process.execPath, [path(typescriptCli), "-b", "--force", "tsconfig.json"], { cwd: path(widgetDirectory) });
}

await build({
  entryPoints: [path(rawJavaScript)],
  outfile: path(outputJavaScript),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  // Minified because this file is downloaded by every user of the host application, and the
  // widget is not the thing they came for.
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

/**
 * An ES module entry over the same bundle.
 *
 * The widget is written as a classic script that publishes `globalThis.AgentChat`, which is
 * what a plain `<script>` host needs. A Vue, React or Vite application imports instead, and
 * asking it to add a script tag and then reach for a global is the kind of integration step
 * that gets done wrong once and debugged twice. This re-exports the same object — one bundle,
 * one global, two ways in — and the emitted .d.ts keeps typing both.
 */
await writeFile(outputModule, [
  'import "./agentic-chat-widget.js";',
  "const api = globalThis.AgentChat;",
  'if (!api) throw new Error("agentic-chat-widget bundle did not install globalThis.AgentChat");',
  "export const AgentChat = api;",
  "export default api;",
  "",
].join("\n"), "utf8");
await copyFile(rawTypes, outputTypes);
await Promise.all([
  rm(rawJavaScript, { force: true }),
  rm(rawTypes, { force: true }),
  ...staleArtifacts.map((artifact) => rm(artifact, { force: true })),
]);
