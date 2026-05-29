import type { GitChangedFile, GitStatusSnapshot } from "@/modules/ai/lib/native";

/**
 * Tree git-decoration: maps the flat changed-file list from `git status` onto
 * the path-keyed explorer tree.
 *
 * Files render a single status letter (M / A / D / U / R) with a status color;
 * collapsed folders that contain a change roll the change up to a dot so the
 * dirty subtree is visible without expanding it (VS Code semantics).
 *
 * Pure on purpose: the snapshot in, the lookups out. No React, no IPC.
 */

export type GitDecorationStatus = "modified" | "added" | "deleted" | "untracked";

export type GitDecoration = {
  /** Per-file status, keyed by absolute forward-slash path. */
  files: Map<string, GitDecorationStatus>;
  /** Absolute forward-slash dirs that contain at least one changed file. */
  dirtyDirs: Set<string>;
};

const EMPTY: GitDecoration = { files: new Map(), dirtyDirs: new Set() };

export function emptyGitDecoration(): GitDecoration {
  return EMPTY;
}

/**
 * Structural equality for two decorations. Lets the hook keep a stable object
 * reference when a refresh produces an identical result (e.g. saving a file
 * already marked Modified), so the tree skips a re-render entirely.
 *
 * Cheap by construction: size check first, then a single pass over `files`
 * (which subsumes `dirtyDirs` — equal file sets always yield equal dir sets).
 */
export function sameGitDecoration(a: GitDecoration, b: GitDecoration): boolean {
  if (a === b) return true;
  if (a.files.size !== b.files.size) return false;
  if (a.dirtyDirs.size !== b.dirtyDirs.size) return false;
  for (const [path, status] of a.files) {
    if (b.files.get(path) !== status) return false;
  }
  return true;
}

/**
 * Collapse the index/worktree status pair into one tree status. A staged-only
 * add still reads as "added"; a worktree delete reads as "deleted". Untracked
 * is its own bucket so it can share the "added" green while staying labelable.
 */
function classify(file: GitChangedFile): GitDecorationStatus {
  if (file.untracked) return "untracked";
  const code = (status: string) => status.trim().toUpperCase();
  const index = code(file.indexStatus);
  const worktree = code(file.worktreeStatus);
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  // Renames/copies/type-changes/modifications all surface as "modified".
  return "modified";
}

/** Join an absolute repo root with a repo-relative, forward-slash git path. */
function joinRepoPath(repoRoot: string, relative: string): string {
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const rel = relative.startsWith("/") ? relative.slice(1) : relative;
  return rel ? `${root}/${rel}` : root;
}

/**
 * Ancestor dirs of `absPath` between the file and the repo root, exclusive of
 * both. The root itself is never yielded (the explorer renders it as a header,
 * not a tree row), and the walk never climbs above the repo.
 */
function* ancestors(absPath: string, root: string): Generator<string> {
  let cur = absPath;
  while (true) {
    const slash = cur.lastIndexOf("/");
    if (slash <= 0) return;
    cur = cur.slice(0, slash);
    if (cur === root || !cur.startsWith(`${root}/`)) return;
    yield cur;
  }
}

/**
 * Build the decoration index from a status snapshot. `repoRoot` comes from the
 * snapshot itself; the tree's own paths must share that canonical (forward
 * slash) form for the lookups to hit.
 */
export function buildGitDecoration(
  status: GitStatusSnapshot | null,
): GitDecoration {
  if (!status || status.changedFiles.length === 0) return EMPTY;
  const repoRoot = status.repoRoot;
  const files = new Map<string, GitDecorationStatus>();
  const dirtyDirs = new Set<string>();

  for (const file of status.changedFiles) {
    const abs = joinRepoPath(repoRoot, file.path);
    files.set(abs, classify(file));
    for (const dir of ancestors(abs, repoRoot)) dirtyDirs.add(dir);
  }

  return { files, dirtyDirs };
}

/** Single-letter badge for a file status. */
export function statusLetter(status: GitDecorationStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "untracked":
      return "U";
  }
}

/**
 * Tailwind text-color class for a status. Kept here so file rows and the
 * folder rollup dot share one source of truth.
 */
export function statusColorClass(status: GitDecorationStatus): string {
  switch (status) {
    case "modified":
      return "text-amber-500";
    case "added":
    case "untracked":
      return "text-emerald-500";
    case "deleted":
      return "text-rose-500";
  }
}
