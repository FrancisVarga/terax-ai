/** A single runnable npm-style script from a package.json `scripts` block. */
export type TaskScript = {
  /** Script key, e.g. "dev", "build", "test". */
  name: string;
  /** The command the script runs, e.g. "vite build". */
  command: string;
};

/**
 * A `package.json` discovered anywhere in the workspace tree. `dir` is the
 * absolute directory containing the manifest — tasks run with this as cwd.
 */
export type PackageManifest = {
  /** Absolute path to the package.json file. */
  path: string;
  /** Absolute directory holding the manifest (the run cwd). */
  dir: string;
  /** Path relative to the workspace root, e.g. "packages/app/package.json". */
  rel: string;
  /** `name` field, or the directory name when absent. */
  name: string;
  /** Detected package manager based on lockfiles / packageManager field. */
  packageManager: PackageManager;
  /** Parsed runnable scripts, sorted with common ones first. */
  scripts: TaskScript[];
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * A live (or finished) task. `handle` is the backend `shell_bg_*` id used to
 * tail logs and kill. `output` is the accumulated ANSI byte stream.
 */
export type RunningTask = {
  /** Stable client id, also the map key. */
  id: string;
  /** Backend background-process handle from `shellBgSpawn`. */
  handle: number;
  /** Absolute dir the task runs in. */
  dir: string;
  /** Manifest display name for the header. */
  pkgName: string;
  /** Script name, e.g. "dev". */
  script: string;
  /** The full shell command, e.g. "pnpm run dev". */
  command: string;
  startedAt: number;
  status: "running" | "exited";
  exitCode: number | null;
  /** Accumulated raw output (ANSI preserved). */
  output: string;
  /** Cursor into the backend ring buffer for incremental reads. */
  offset: number;
};

/** Tree node: either a manifest leaf or a grouping directory. */
export type TreeNode =
  | { kind: "dir"; name: string; rel: string; children: TreeNode[] }
  | { kind: "pkg"; manifest: PackageManifest };
