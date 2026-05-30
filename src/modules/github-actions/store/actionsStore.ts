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
};

/**
 * Route a completion notification through the same focus-aware path the agent
 * notifications use (OS notification when unfocused, in-app toast otherwise),
 * gated by the user's `agentNotifications` pref, plus an optional chime gated
 * by `notificationSound`. Centralized so the policy can't drift.
 */
function notifyCompletion(run: TrackedRun): void {
  const prefs = usePreferencesStore.getState();
  const ok = run.conclusion === "success";
  const title = `${run.workflowName} ${ok ? "succeeded" : run.conclusion ?? "finished"}`;
  const body = run.url ?? undefined;

  if (prefs.notificationSound) playCompletionSound(ok);

  if (!prefs.agentNotifications) return;
  // In a non-React (store) context we read focus synchronously; the route is
  // toast-when-focused / OS-notify-when-not, same policy as agent signals.
  const focused = typeof document !== "undefined" ? document.hasFocus() : true;
  if (focused) {
    showAgentToast({
      agent: "GitHub Actions",
      title,
      body,
      onActivate: () => {
        if (run.url) void openUrl(run.url).catch(() => {});
      },
    });
  } else {
    void osNotify(title, body ?? run.workflowName);
  }
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

  const finalize = (id: string) => {
    stopPoller(id);
    const run = get().tracked[id];
    if (run) notifyCompletion(run);
    // A dispatched run just reached a terminal state; refresh the history list
    // so the Runs view reflects it without waiting for the next TTL window.
    void get().loadRuns(get().tracked[id]?.cwd ?? "", true).catch(() => {});
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
  };
});
