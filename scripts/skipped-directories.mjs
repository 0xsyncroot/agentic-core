// Directory names the repository scripts skip at any depth: tool state, git worktrees and build output hold no sources of ours.
export const SKIPPED_DIRECTORIES = new Set([
  ".agents", ".codegraph", ".codewiki", ".codex", ".git", ".kilo", ".kilocode", ".local", ".wave", "coverage", "dist", "node_modules",
]);
