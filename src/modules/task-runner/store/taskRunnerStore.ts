import { native } from "@/modules/ai/lib/native";
import { create } from "zustand";
import { scanManifests, runInvocation } from "../lib/scan";
import type { PackageManifest, RunningTask, TaskScript } from "../lib/types";

const POLL_INTERVAL_MS = 400;
// Cap retained output per task so a chatty `dev` server can't grow the heap
// unbounded. The backend ring buffer is the source of truth; this is display.
const MAX_OUTPUT_CHARS = 512 * 1024;
/**
 * Stale-while-revalidate window for the cached manifest scan. Within this window
 * a panel mount serves the cache without re-walking the filesystem; past it, the
 * stale tree is still shown immediately while a background re-scan runs.
 */
const SCAN_TTL_MS = 30_000;

let taskSeq = 0;
/** Active poll timers keyed by task id, kept outside the store (not state). */
const pollers = new Map<string, ReturnType<typeof setInterval>>();

/** Default scan-cache entry used before the first scan resolves. */
const EMPTY_SCAN: ScanCache = {
  status: "loading",
  manifests: [],
  error: undefined,
  fetchedAt: 0,
  loading: false,
};

/**
 * Cached package.json scan for one workspace root. The panel reads this
 * synchronously so re-opening the Tasks tab is instant; it is revalidated in
 * the background once older than {@link SCAN_TTL_MS}.
 */
export type ScanCache = {
  status: "loading" | "ready" | "empty" | "error";
  /** Discovered manifests (source of the tree); empty unless `status==="ready"`. */
  manifests: PackageManifest[];
  error?: string;
  /** Epoch ms of the last completed scan; 0 while first loading. */
  fetchedAt: number;
  /** True while a scan is in flight, to coalesce concurrent revalidations. */
  loading: boolean;
};

/**
 * Whether two manifest lists are identical for the fields the tree renders.
 * Used to suppress a no-op cache write on revalidation: an unchanged scan keeps
 * the existing `manifests` reference so the derived tree is not rebuilt and the
 * panel does not re-render — "revalidate only when there is new data".
 */
function manifestsEqual(a: PackageManifest[], b: PackageManifest[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    if (
      m.path !== o.path ||
      m.name !== o.name ||
      m.packageManager !== o.packageManager ||
      m.remoteAlias !== o.remoteAlias ||
      m.scripts.length !== o.scripts.length
    ) {
      return false;
    }
    return m.scripts.every(
      (s, j) => s.name === o.scripts[j].name && s.command === o.scripts[j].command,
    );
  });
}

type TaskRunnerState = {
  tasks: Record<string, RunningTask>;
  /** Task id whose output is shown in the detail pane. */
  selectedId: string | null;
  /** Per-workspace-root cache of the package.json scan (SWR). */
  scanCache: Record<string, ScanCache>;
  /**
   * Ensure the manifest scan for `root` is loaded. Serves cache when fresh,
   * revalidates in the background when stale, and skips the state write when a
   * re-scan returns the same manifests. `force` bypasses the TTL (rescan button).
   */
  loadScan: (root: string, force?: boolean) => Promise<void>;
  run: (manifest: PackageManifest, script: TaskScript) => Promise<void>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => void;
  /** Empty a task's displayed output. The backend ring buffer + read cursor are
   *  left intact, so live polling resumes from where it was — only the cache of
   *  already-shown bytes is dropped. */
  clearOutput: (id: string) => void;
  select: (id: string | null) => void;
  /** Re-key an existing run+script pair: returns its id if already running. */
  findRunning: (dir: string, script: string) => RunningTask | undefined;
};

function appendOutput(prev: string, chunk: string): string {
  const next = prev + chunk;
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  // Drop from the front, snapping to the next newline so we don't cut a line
  // (and an ANSI escape) mid-sequence.
  const overflow = next.length - MAX_OUTPUT_CHARS;
  const nl = next.indexOf("\n", overflow);
  return next.slice(nl >= 0 ? nl + 1 : overflow);
}

export const useTaskRunnerStore = create<TaskRunnerState>((set, get) => {
  /** Poll the backend ring buffer for one task and fold new bytes in. Routes to
   * the SSH backend when the task carries a remote alias, else the local one. */
  const tick = async (id: string) => {
    const task = get().tasks[id];
    if (!task) return;
    let res;
    try {
      res = task.remoteAlias
        ? await native.sshBgLogs(task.handle, task.offset)
        : await native.shellBgLogs(task.handle, task.offset);
    } catch {
      return; // transient; next tick retries
    }
    set((s) => {
      const cur = s.tasks[id];
      if (!cur) return s;
      return {
        tasks: {
          ...s.tasks,
          [id]: {
            ...cur,
            output: res.bytes ? appendOutput(cur.output, res.bytes) : cur.output,
            offset: res.next_offset,
            status: res.exited ? "exited" : "running",
            exitCode: res.exited ? res.exit_code : cur.exitCode,
          },
        },
      };
    });
    if (res.exited) {
      const timer = pollers.get(id);
      if (timer) {
        clearInterval(timer);
        pollers.delete(id);
      }
    }
  };

  const patchScan = (root: string, p: Partial<ScanCache>) =>
    set((s) => {
      const cur = s.scanCache[root] ?? EMPTY_SCAN;
      return { scanCache: { ...s.scanCache, [root]: { ...cur, ...p } } };
    });

  return {
    tasks: {},
    selectedId: null,
    scanCache: {},

    loadScan: async (root, force = false) => {
      if (!root) return;
      const cached = get().scanCache[root];
      // Coalesce concurrent scans, and serve a fresh cache without re-walking.
      if (cached?.loading) return;
      if (
        !force &&
        cached &&
        cached.status !== "loading" &&
        Date.now() - cached.fetchedAt < SCAN_TTL_MS
      ) {
        return;
      }

      // First-ever scan shows the spinner; revalidations keep the stale tree.
      patchScan(root, cached ? { loading: true } : { ...EMPTY_SCAN, loading: true });
      try {
        const manifests = await scanManifests(root);
        const status = manifests.length > 0 ? "ready" : "empty";
        // Revalidate only when there is new data: if the re-scan matches the
        // cached manifests, keep the existing array reference so the panel's
        // derived tree (memoized on `manifests`) is not rebuilt.
        const prev = get().scanCache[root];
        const unchanged =
          prev != null &&
          prev.status === status &&
          prev.error === undefined &&
          manifestsEqual(prev.manifests, manifests);
        patchScan(
          root,
          unchanged
            ? { fetchedAt: Date.now(), loading: false }
            : {
                status,
                manifests,
                error: undefined,
                fetchedAt: Date.now(),
                loading: false,
              },
        );
      } catch (e) {
        // Keep any stale tree on failure; record the reason + stop the spinner.
        patchScan(root, {
          status: get().scanCache[root]?.manifests.length ? "ready" : "error",
          error: String(e instanceof Error ? e.message : e),
          fetchedAt: Date.now(),
          loading: false,
        });
      }
    },

    findRunning: (dir, script) =>
      Object.values(get().tasks).find(
        (t) => t.dir === dir && t.script === script && t.status === "running",
      ),

    run: async (manifest, script) => {
      // Re-running an in-flight task just re-focuses it.
      const existing = get().findRunning(manifest.dir, script.name);
      if (existing) {
        set({ selectedId: existing.id });
        return;
      }
      const command = runInvocation(manifest.packageManager, script.name);
      // Remote manifests dispatch over SSH (cwd = remote abs path); local ones
      // use the local background-process backend.
      const handle = manifest.remoteAlias
        ? await native.sshBgSpawn(manifest.remoteAlias, command, manifest.dir)
        : await native.shellBgSpawn(command, manifest.dir);
      const id = `t${++taskSeq}`;
      const task: RunningTask = {
        id,
        handle,
        dir: manifest.dir,
        pkgName: manifest.name,
        script: script.name,
        command,
        startedAt: Date.now(),
        status: "running",
        exitCode: null,
        output: "",
        offset: 0,
        remoteAlias: manifest.remoteAlias,
      };
      set((s) => ({ tasks: { ...s.tasks, [id]: task }, selectedId: id }));
      const timer = setInterval(() => void tick(id), POLL_INTERVAL_MS);
      pollers.set(id, timer);
      void tick(id); // immediate first read so output appears without delay
    },

    stop: async (id) => {
      const task = get().tasks[id];
      if (!task) return;
      try {
        await (task.remoteAlias
          ? native.sshBgKill(task.handle)
          : native.shellBgKill(task.handle));
      } catch {
        /* already gone */
      }
      // Drain one final time to capture trailing output + exit code.
      await tick(id);
    },

    remove: (id) => {
      const timer = pollers.get(id);
      if (timer) {
        clearInterval(timer);
        pollers.delete(id);
      }
      const task = get().tasks[id];
      if (task?.status === "running") {
        void (task.remoteAlias
          ? native.sshBgKill(task.handle)
          : native.shellBgKill(task.handle)
        ).catch(() => {});
      }
      set((s) => {
        const { [id]: _drop, ...rest } = s.tasks;
        return {
          tasks: rest,
          selectedId: s.selectedId === id ? null : s.selectedId,
        };
      });
    },

    clearOutput: (id) =>
      set((s) => {
        const cur = s.tasks[id];
        if (!cur) return s;
        return { tasks: { ...s.tasks, [id]: { ...cur, output: "" } } };
      }),

    select: (id) => set({ selectedId: id }),
  };
});
