import { native } from "@/modules/ai/lib/native";
import { create } from "zustand";
import { runInvocation, scanManifests } from "../lib/scan";
import type { PackageManifest, RunningTask, TaskScript } from "../lib/types";

const POLL_INTERVAL_MS = 400;
// Cap retained output per task so a chatty `dev` server can't grow the heap
// unbounded. The backend ring buffer is the source of truth; this is display.
const MAX_OUTPUT_CHARS = 512 * 1024;

let taskSeq = 0;
/** Active poll timers keyed by task id, kept outside the store (not state). */
const pollers = new Map<string, ReturnType<typeof setInterval>>();

type TaskRunnerState = {
  tasks: Record<string, RunningTask>;
  /**
   * Manifests discovered by the most recent workspace scan. Owned here (not in
   * the panel's local state) so the command palette can list runnable scripts
   * without re-scanning — the panel writes via {@link setManifests}, the palette
   * reads. Both then drive the same {@link run}.
   */
  manifests: PackageManifest[];
  /** Task id whose output is shown in the detail pane. */
  selectedId: string | null;
  run: (manifest: PackageManifest, script: TaskScript) => Promise<void>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  /** Publish the latest scan result so the palette stays in sync with the panel. */
  setManifests: (manifests: PackageManifest[]) => void;
  /**
   * Scan `root` for manifests and publish them. Lets the command palette
   * populate runnable scripts on demand without the Tasks panel being mounted.
   * Swallows errors (best-effort) — the palette just shows no tasks on failure.
   */
  scan: (root: string) => Promise<void>;
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

  return {
    tasks: {},
    manifests: [],
    selectedId: null,

    setManifests: (manifests) => set({ manifests }),

    scan: async (root) => {
      try {
        set({ manifests: await scanManifests(root) });
      } catch {
        set({ manifests: [] });
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

    select: (id) => set({ selectedId: id }),
  };
});
