import { native } from "@/modules/ai/lib/native";
import type {
  PackageManager,
  PackageManifest,
  TaskScript,
  TreeNode,
} from "./types";

// Surface these first when present — the everyday verbs. Anything else keeps
// its declared order after this block.
const SCRIPT_PRIORITY = ["dev", "start", "build", "test", "lint", "preview"];

const PM_FROM_FIELD: Record<string, PackageManager> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn",
  bun: "bun",
};

/** Split an absolute manifest path into its containing directory. */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : path;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/**
 * Detect the package manager. The `packageManager` field (Corepack) is the
 * most authoritative signal; otherwise we fall back to a sibling lockfile.
 * Caller passes the set of sibling filenames it already globbed.
 */
function detectPm(
  pkgManagerField: unknown,
  siblingLockfiles: Set<string>,
): PackageManager {
  if (typeof pkgManagerField === "string") {
    const name = pkgManagerField.split("@")[0]?.trim().toLowerCase();
    if (name && PM_FROM_FIELD[name]) return PM_FROM_FIELD[name];
  }
  if (siblingLockfiles.has("bun.lockb") || siblingLockfiles.has("bun.lock"))
    return "bun";
  if (siblingLockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (siblingLockfiles.has("yarn.lock")) return "yarn";
  return "npm";
}

/** Build the `<pm> run <script>` invocation. npm needs `run`; all accept it. */
export function runInvocation(pm: PackageManager, script: string): string {
  // `start` and `test` are first-class npm verbs but `run` works everywhere
  // and keeps the mapping uniform.
  return `${pm} run ${script}`;
}

function parseScripts(raw: unknown): TaskScript[] {
  if (!raw || typeof raw !== "object") return [];
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ name, command: v as string }));
  entries.sort((a, b) => {
    const ai = SCRIPT_PRIORITY.indexOf(a.name);
    const bi = SCRIPT_PRIORITY.indexOf(b.name);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Walk the workspace from `root`, find every `package.json` (gitignore-aware,
 * node_modules pruned by the backend glob), parse scripts, and detect the
 * package manager. Manifests with zero scripts are dropped — nothing to run.
 */
export async function scanManifests(root: string): Promise<PackageManifest[]> {
  const [pkgs, lockfiles] = await Promise.all([
    native.glob({ pattern: "**/package.json", root, maxResults: 500 }),
    native.glob({
      pattern: "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lockb,bun.lock}",
      root,
      maxResults: 500,
    }),
  ]);

  // Index lockfile basenames by their containing directory so PM detection is
  // a cheap per-manifest set lookup instead of a re-walk.
  const locksByDir = new Map<string, Set<string>>();
  for (const hit of lockfiles.hits) {
    const dir = dirOf(hit.path);
    let set = locksByDir.get(dir);
    if (!set) locksByDir.set(dir, (set = new Set()));
    set.add(baseName(hit.path));
  }

  const out: PackageManifest[] = [];
  await Promise.all(
    pkgs.hits.map(async (hit) => {
      const res = await native.readFile(hit.path).catch(() => null);
      if (!res || res.kind !== "text") return;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(res.content);
      } catch {
        return; // malformed manifest — skip rather than crash the scan
      }
      const scripts = parseScripts(json.scripts);
      if (scripts.length === 0) return;
      const dir = dirOf(hit.path);
      out.push({
        path: hit.path,
        dir,
        rel: hit.rel,
        name:
          typeof json.name === "string" && json.name.trim()
            ? json.name.trim()
            : baseName(dir),
        packageManager: detectPm(
          json.packageManager,
          locksByDir.get(dir) ?? new Set(),
        ),
        scripts,
      });
    }),
  );

  // Root manifest first, then shallowest, then alphabetical — keeps the tree
  // stable across rescans.
  out.sort((a, b) => {
    const ad = a.rel.split("/").length;
    const bd = b.rel.split("/").length;
    if (ad !== bd) return ad - bd;
    return a.rel.localeCompare(b.rel);
  });
  return out;
}

/**
 * Group manifests into a directory tree. Each manifest's parent directories
 * (relative to root) become nesting `dir` nodes, collapsing single-child
 * chains so `packages/app` shows as one segment rather than two empty levels.
 */
export function buildTree(manifests: PackageManifest[]): TreeNode[] {
  type Dir = { name: string; rel: string; dirs: Map<string, Dir>; pkgs: PackageManifest[] };
  const rootDir: Dir = { name: "", rel: "", dirs: new Map(), pkgs: [] };

  for (const m of manifests) {
    const parts = m.rel.split("/").slice(0, -1); // drop "package.json"
    let cur = rootDir;
    let relAcc = "";
    for (const part of parts) {
      relAcc = relAcc ? `${relAcc}/${part}` : part;
      let next = cur.dirs.get(part);
      if (!next) {
        next = { name: part, rel: relAcc, dirs: new Map(), pkgs: [] };
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.pkgs.push(m);
  }

  const toNodes = (dir: Dir): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const child of dir.dirs.values()) {
      const childNodes = toNodes(child);
      // Collapse a dir that holds exactly one nested dir and no package of its
      // own (e.g. an empty intermediate folder).
      nodes.push({
        kind: "dir",
        name: child.name,
        rel: child.rel,
        children: childNodes,
      });
    }
    for (const pkg of dir.pkgs) {
      nodes.push({ kind: "pkg", manifest: pkg });
    }
    return nodes;
  };

  return toNodes(rootDir);
}
