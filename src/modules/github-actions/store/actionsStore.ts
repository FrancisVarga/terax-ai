import { playCompletionSound } from "@/lib/sound";
import { osNotify } from "@/modules/agents/lib/notify";
import { showAgentToast } from "@/modules/agents/components/AgentToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { isRemote } from "@/modules/explorer/lib/remote";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import {
  GhError,
  getRun,
  listRuns,
  listWorkflows,
  resolveRepo,
  runWorkflow,
  type RepoInfo,
  type RunConclusion,
  type RunStatus,
  type WorkflowDef,
  type WorkflowRun,
} from "../lib/gh";

/** How often to poll a dispatched run for status changes. */
const POLL_INTERVAL_MS = 4000;
/** Give up adopting a freshly-dispatched run after this long (GitHub lag). */
const ADOPT_TIMEOUT_MS = 60_000;
/**
 * Stale-while-revalidate window for cached repo/workflow/run lists. Within this
 * window a read serves the cache without spawning `gh`; past it, the cache is
 * still served immediately but a background refresh is kicked off.
 */
const META_TTL_MS = 30_000;
/** Recent runs to fetch for the history view. */
const RUNS_LIMIT = 20;

/** Default cache entries used before the first fetch resolves. */
const EMPTY_META: MetaCache = {
  status: "loading",
  repo: null,
  workflows: [],
  fetchedAt: 0,
  loading: false,
};
const EMPTY_RUNS: RunsCache = { runs: [], fetchedAt: 0, loading: false };

let trackSeq = 0;
/** Poll timers keyed by tracked-run client id, kept outside zustand state. */
const pollers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * How often the background watcher polls a repo's recent runs for *any* run
 * (push, PR, manual on github.com, …), not just runs this app dispatched. Slower
 * than the per-run dispatch poll because it watches the whole repo passively.
 */
const WATCH_INTERVAL_MS = 15_000;

/** A run's last-seen lifecycle state, for diffing successive watch snapshots. */
type SeenRun = { status: RunStatus; conclusion: RunConclusion };

/**
 * Per-cwd watcher state, kept outside zustand (like {@link pollers}) — it is
 * bookkeeping, not reactive UI state.
 *  - `timer`: the poll interval for this cwd.
 *  - `seen`: runId → last-known status/conclusion, used to fire a notification
 *    only on a *transition* (new run appears → "started"; run reaches a failing
 *    conclusion → "error"), never twice for the same edge.
 *  - `primed`: false until the first snapshot has seeded `seen`. The first poll
 *    seeds silently so we don't announce every already-in-flight run as if it
 *    had just started the moment the watcher attaches.
 */
type Watcher = {
  timer: ReturnType<typeof setInterval>;
  seen: Map<number, SeenRun>;
  primed: boolean;
};
const watchers = new Map<string, Watcher>();

/** Conclusions we treat as an "error" worth notifying about. */
const FAILED_CONCLUSIONS = new Set<RunConclusion>([
  "failure",
  "timed_out",
  "startup_failure",
]);

/**
 * Whether two workflow lists are identical (same ids/name/path/state in order).
 * Used to suppress a no-op cache write on revalidation, so a refetch that
 * returns the same data keeps the existing array reference and React skips the
 * re-render — "revalidate only when there is new data".
 */
function workflowsEqual(a: WorkflowDef[], b: WorkflowDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) => {
    const o = b[i];
    return (
      w.id === o.id &&
      w.name === o.name &&
      w.path === o.path &&
      w.state === o.state
    );
  });
}

/** Same idea for the recent-runs list: a run is identified by its mutable fields. */
function runsEqual(a: WorkflowRun[], b: WorkflowRun[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return (
      r.databaseId === o.databaseId &&
      r.status === o.status &&
      r.conclusion === o.conclusion &&
      r.url === o.url
    );
  });
}

/** A workflow run we dispatched and are watching to completion. */
export type TrackedRun = {
  /** Stable client id (map key) — distinct from GitHub's run id. */
  id: string;
  /** Display name of the workflow that was dispatched. */
  workflowName: string;
  /** Workflow file/id passed to `gh workflow run`. */
  workflowFile: string;
  /** Git ref dispatched against, if any. */
  ref?: string;
  /** The cwd the run was launched from (a GitHub repo working dir). */
  cwd: string;
  /** GitHub's numeric run id once adopted; null while we're still finding it. */
  runId: number | null;
  /** Latest known status; "dispatching" before GitHub confirms a run exists. */
  status: "dispatching" | WorkflowRun["status"];
  conclusion: WorkflowRun["conclusion"];
  url: string | null;
  startedAt: number;
  /** Newest run id for this workflow at dispatch time; a newer run is "ours". */
  baselineRunId: number;
  /** Set when adoption/polling failed so the row can show the reason. */
  error?: string;
};

/**
 * Cached repo identity + active workflow list for one working dir. The panel
 * reads this synchronously so re-opening the sidebar tab is instant; it is
 * revalidated in the background once older than {@link META_TTL_MS}.
 */
export type MetaCache = {
  status: "loading" | "ready" | "empty" | "no-repo" | "error";
  repo: RepoInfo | null;
  workflows: WorkflowDef[];
  error?: string;
  /** Epoch ms of the last successful (or terminal) fetch; 0 while first loading. */
  fetchedAt: number;
  /** True while a fetch is in flight, to coalesce concurrent revalidations. */
  loading: boolean;
};

/** Cached recent-run history for one working dir (for the Runs/History view). */
export type RunsCache = {
  runs: WorkflowRun[];
  error?: string;
  fetchedAt: number;
  loading: boolean;
};

type ActionsState = {
  /** Tracked dispatched runs, keyed by client id, newest dispatch first when sorted. */
  tracked: Record<string, TrackedRun>;
  /** Repo + workflow-list cache, keyed by working dir. */
  metaCache: Record<string, MetaCache>;
  /** Recent-run-history cache, keyed by working dir. */
  runsCache: Record<string, RunsCache>;
  /**
   * Ensure repo + workflows for `cwd` are loaded. Serves cache when fresh,
   * revalidates in the background when stale. `force` bypasses the TTL (used by
   * the manual reload button). Remote roots resolve to a `no-repo` cache entry.
   */
  loadMeta: (cwd: string, force?: boolean) => Promise<void>;
  /** Same SWR contract for the recent-run history list. */
  loadRuns: (cwd: string, force?: boolean) => Promise<void>;
  /**
   * Dispatch `workflowFile` on `ref` from `cwd`, then poll until the run
   * completes. `baselineRunId` is the newest existing run id for that workflow
   * at dispatch time so we can tell our new run apart from older ones.
   */
  dispatch: (args: {
    workflowFile: string;
    workflowName: string;
    ref?: string;
    cwd: string;
  }) => Promise<void>;
  /** Stop watching a tracked run (does not cancel it on GitHub). */
  forget: (id: string) => void;
  /**
   * Start a background watcher for `cwd` that polls *all* recent workflow runs
   * (not just app-dispatched ones) and fires a notification when a run starts
   * or fails. Idempotent per cwd, and a no-op for remote / empty roots. Returns
   * a disposer that stops the watcher; calling {@link watchActions} again for
   * the same cwd reuses the existing watcher and returns a disposer for it.
   */
  watchActions: (cwd: string) => () => void;
};

/**
 * Route one GitHub-Actions notification through the same focus-aware path the
 * agent notifications use (OS notification when unfocused, in-app toast
 * otherwise), gated by the user's `agentNotifications` pref, plus an optional
 * chime gated by `notificationSound`. Centralized so every event — completion,
 * start, error — shares one policy that can't drift.
 *
 * `tone` controls the chime contour: ascending for good, descending for bad,
 * none to stay silent (a "started" event has no outcome yet, so it doesn't
 * chime even when sound is on).
 */
function notify(opts: {
  title: string;
  body?: string;
  url?: string | null;
  tone: "good" | "bad" | "none";
}): void {
  const prefs = usePreferencesStore.getState();

  if (prefs.notificationSound && opts.tone !== "none") {
    playCompletionSound(opts.tone === "good");
  }

  if (!prefs.agentNotifications) return;
  // In a non-React (store) context we read focus synchronously; the route is
  // toast-when-focused / OS-notify-when-not, same policy as agent signals.
  const focused = typeof document !== "undefined" ? document.hasFocus() : true;
  if (focused) {
    showAgentToast({
      agent: "GitHub Actions",
      title: opts.title,
      body: opts.body,
      onActivate: () => {
        if (opts.url) void openUrl(opts.url).catch(() => {});
      },
    });
  } else {
    void osNotify(opts.title, opts.body ?? opts.title);
  }
}

/** A dispatched run reached a terminal state — announce success/failure. */
function notifyCompletion(run: TrackedRun): void {
  const ok = run.conclusion === "success";
  notify({
    title: `${run.workflowName} ${ok ? "succeeded" : run.conclusion ?? "finished"}`,
    body: run.url ?? undefined,
    url: run.url,
    tone: ok ? "good" : "bad",
  });
}

export const useActionsStore = create<ActionsState>((set, get) => {
  /** One poll cycle for a tracked run: adopt the run if needed, else refresh it. */
  const tick = async (id: string) => {
    const cur = get().tracked[id];
    if (!cur) return;

    try {
      // Phase 1: not yet adopted — look for a run newer than the baseline.
      if (cur.runId === null) {
        if (Date.now() - cur.startedAt > ADOPT_TIMEOUT_MS) {
          patch(id, {
            error: "Timed out waiting for the run to appear on GitHub.",
          });
          stopPoller(id);
          return;
        }
        const runs = await listRuns(cur.cwd, 20);
        const mine = runs.find(
          (r) =>
            r.workflowName === cur.workflowName &&
            r.databaseId > (cur.baselineRunId ?? 0),
        );
        if (!mine) return; // not visible yet; keep polling
        patch(id, {
          runId: mine.databaseId,
          status: mine.status,
          conclusion: mine.conclusion,
          url: mine.url,
        });
        if (mine.status === "completed") finalize(id);
        return;
      }

      // Phase 2: adopted — refresh the single run until it completes.
      const run = await getRun(cur.cwd, cur.runId);
      patch(id, {
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
      });
      if (run.status === "completed") finalize(id);
    } catch (e) {
      // Transient errors (network, rate limit) are swallowed; the next tick
      // retries. A GhError is more likely terminal (auth/repo), so surface it.
      if (e instanceof GhError) {
        patch(id, { error: e.message });
        stopPoller(id);
      }
    }
  };

  const patch = (id: string, p: Partial<TrackedRun>) =>
    set((s) => {
      const cur = s.tracked[id];
      if (!cur) return s;
      return { tracked: { ...s.tracked, [id]: { ...cur, ...p } } };
    });

  const stopPoller = (id: string) => {
    const t = pollers.get(id);
    if (t) {
      clearInterval(t);
      pollers.delete(id);
    }
  };

  const stopWatcher = (cwd: string) => {
    const w = watchers.get(cwd);
    if (w) {
      clearInterval(w.timer);
      watchers.delete(cwd);
    }
  };

  const finalize = (id: string) => {
    stopPoller(id);
    const run = get().tracked[id];
    if (run) notifyCompletion(run);
    // A dispatched run just reached a terminal state; refresh the history list
    // so the Runs view reflects it without waiting for the next TTL window.
    void get().loadRuns(get().tracked[id]?.cwd ?? "", true).catch(() => {});
  };

  /**
   * One watch cycle for `cwd`: fetch recent runs and diff them against the last
   * snapshot in `w.seen`.
   *  - First cycle (`!w.primed`): seed `seen` silently and prime — we are
   *    attaching mid-stream, so pre-existing runs are not "new starts".
   *  - A run id absent from `seen`, not already completed → just started.
   *  - A run that crosses into a failing conclusion → errored. We key the
   *    "did we already notify this failure" decision on the stored conclusion
   *    so a run that was already failing when we attached never double-fires.
   * The watcher only *reads* gh; it never mutates the SWR caches the panel owns.
   */
  const watchTick = async (cwd: string) => {
    const w = watchers.get(cwd);
    if (!w) return;
    let runs: WorkflowRun[];
    try {
      runs = await listRuns(cwd, RUNS_LIMIT);
    } catch {
      // Transient (network/rate-limit) or terminal (auth/repo). Either way keep
      // the watcher alive and retry next cycle; the panel surfaces hard errors.
      return;
    }

    const prevSeen = w.seen;
    const nextSeen = new Map<number, SeenRun>();
    for (const r of runs) {
      nextSeen.set(r.databaseId, {
        status: r.status,
        conclusion: r.conclusion,
      });

      if (!w.primed) continue; // first snapshot: seed only, announce nothing.

      const before = prevSeen.get(r.databaseId);
      const failing =
        r.status === "completed" && FAILED_CONCLUSIONS.has(r.conclusion);

      if (!before) {
        // A run id we have never seen. If it is already finished it completed
        // between two polls — only announce the failing case (a missed error),
        // not a success we never watched start.
        if (r.status !== "completed") {
          notify({
            title: `${r.workflowName} started`,
            body: `${r.headBranch} · ${r.displayTitle}`,
            url: r.url,
            tone: "none",
          });
        } else if (failing) {
          notify({
            title: `${r.workflowName} ${r.conclusion ?? "failed"}`,
            body: `${r.headBranch} · ${r.displayTitle}`,
            url: r.url,
            tone: "bad",
          });
        }
      } else if (failing && !FAILED_CONCLUSIONS.has(before.conclusion)) {
        // Known run that just transitioned into a failing conclusion.
        notify({
          title: `${r.workflowName} ${r.conclusion ?? "failed"}`,
          body: `${r.headBranch} · ${r.displayTitle}`,
          url: r.url,
          tone: "bad",
        });
      }
    }

    w.seen = nextSeen;
    w.primed = true;
  };

  const patchMeta = (cwd: string, p: Partial<MetaCache>) =>
    set((s) => {
      const cur = s.metaCache[cwd] ?? EMPTY_META;
      return { metaCache: { ...s.metaCache, [cwd]: { ...cur, ...p } } };
    });

  const patchRuns = (cwd: string, p: Partial<RunsCache>) =>
    set((s) => {
      const cur = s.runsCache[cwd] ?? EMPTY_RUNS;
      return { runsCache: { ...s.runsCache, [cwd]: { ...cur, ...p } } };
    });

  return {
    tracked: {},
    metaCache: {},
    runsCache: {},

    loadMeta: async (cwd, force = false) => {
      if (!cwd) return;
      const cached = get().metaCache[cwd];
      // Coalesce concurrent loads, and serve fresh cache without touching gh.
      if (cached?.loading) return;
      if (
        !force &&
        cached &&
        cached.status !== "loading" &&
        Date.now() - cached.fetchedAt < META_TTL_MS
      ) {
        return;
      }

      // Remote roots have no local gh context — record that terminally.
      if (isRemote(cwd)) {
        patchMeta(cwd, {
          status: "no-repo",
          repo: null,
          workflows: [],
          error: undefined,
          fetchedAt: Date.now(),
          loading: false,
        });
        return;
      }

      // First-ever load shows a spinner; revalidations keep the stale view.
      patchMeta(cwd, cached ? { loading: true } : { ...EMPTY_META, loading: true });
      try {
        const repo = await resolveRepo(cwd);
        const workflows = (await listWorkflows(cwd)).filter(
          (w) => w.state === "active",
        );
        const status = workflows.length > 0 ? "ready" : "empty";
        // Revalidate only when there is new data: if the fetch matches the
        // cached repo + workflow list, keep the existing `workflows` reference
        // (so subscribers don't re-render) and just reset the TTL + spinner.
        const prev = get().metaCache[cwd];
        const unchanged =
          prev?.status === status &&
          prev.repo?.nameWithOwner === repo.nameWithOwner &&
          prev.error === undefined &&
          workflowsEqual(prev.workflows, workflows);
        patchMeta(
          cwd,
          unchanged
            ? { fetchedAt: Date.now(), loading: false }
            : {
                status,
                repo,
                workflows,
                error: undefined,
                fetchedAt: Date.now(),
                loading: false,
              },
        );
      } catch (e) {
        const noRepo =
          e instanceof GhError && /not a (git|github) repo/i.test(e.message);
        patchMeta(cwd, {
          status: noRepo ? "no-repo" : "error",
          error: noRepo
            ? undefined
            : String(e instanceof Error ? e.message : e),
          fetchedAt: Date.now(),
          loading: false,
        });
      }
    },

    loadRuns: async (cwd, force = false) => {
      if (!cwd || isRemote(cwd)) return;
      const cached = get().runsCache[cwd];
      if (cached?.loading) return;
      if (!force && cached && Date.now() - cached.fetchedAt < META_TTL_MS) {
        return;
      }
      patchRuns(cwd, { loading: true });
      try {
        const runs = await listRuns(cwd, RUNS_LIMIT);
        // Revalidate only when there is new data: an identical run list keeps
        // its array reference so the History view doesn't re-render.
        const prev = get().runsCache[cwd];
        const unchanged =
          prev != null && prev.error === undefined && runsEqual(prev.runs, runs);
        patchRuns(
          cwd,
          unchanged
            ? { fetchedAt: Date.now(), loading: false }
            : {
                runs,
                error: undefined,
                fetchedAt: Date.now(),
                loading: false,
              },
        );
      } catch (e) {
        // Keep the stale list on failure; just record the reason + stop spinner.
        patchRuns(cwd, {
          error: String(e instanceof Error ? e.message : e),
          fetchedAt: Date.now(),
          loading: false,
        });
      }
    },

    dispatch: async ({ workflowFile, workflowName, ref, cwd }) => {
      // Snapshot the newest existing run id for this workflow so the poller can
      // distinguish the run we are about to create from prior ones.
      let baselineRunId = 0;
      try {
        const existing = await listRuns(cwd, 20);
        baselineRunId = existing
          .filter((r) => r.workflowName === workflowName)
          .reduce((m, r) => Math.max(m, r.databaseId), 0);
      } catch {
        /* no prior runs / transient — baseline 0 is fine */
      }

      const id = `gh${++trackSeq}`;
      const tracked: TrackedRun = {
        id,
        workflowName,
        workflowFile,
        ref,
        cwd,
        runId: null,
        status: "dispatching",
        conclusion: null,
        url: null,
        startedAt: Date.now(),
        baselineRunId,
      };
      set((s) => ({ tracked: { ...s.tracked, [id]: tracked } }));

      try {
        await runWorkflow(cwd, workflowFile, ref);
      } catch (e) {
        patch(id, {
          status: "completed",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      const timer = setInterval(() => void tick(id), POLL_INTERVAL_MS);
      pollers.set(id, timer);
      void tick(id); // first poll soon after dispatch
    },

    forget: (id) => {
      stopPoller(id);
      set((s) => {
        const { [id]: _drop, ...rest } = s.tracked;
        return { tracked: rest };
      });
    },

    watchActions: (cwd) => {
      // Remote / empty roots have no local gh context to watch.
      if (!cwd || isRemote(cwd)) return () => {};

      const existing = watchers.get(cwd);
      if (existing) {
        // Already watching this cwd — hand back a disposer for the live watcher
        // rather than spinning up a second timer.
        return () => stopWatcher(cwd);
      }

      const w: Watcher = {
        timer: setInterval(() => void watchTick(cwd), WATCH_INTERVAL_MS),
        seen: new Map(),
        primed: false,
      };
      watchers.set(cwd, w);
      void watchTick(cwd); // seed the baseline immediately (primes silently).
      return () => stopWatcher(cwd);
    },
  };
});
