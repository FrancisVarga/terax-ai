import { playCompletionSound } from "@/lib/sound";
import { osNotify } from "@/modules/agents/lib/notify";
import { showAgentToast } from "@/modules/agents/components/AgentToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import {
  GhError,
  getRun,
  listRuns,
  runWorkflow,
  type WorkflowRun,
} from "../lib/gh";

/** How often to poll a dispatched run for status changes. */
const POLL_INTERVAL_MS = 4000;
/** Give up adopting a freshly-dispatched run after this long (GitHub lag). */
const ADOPT_TIMEOUT_MS = 60_000;

let trackSeq = 0;
/** Poll timers keyed by tracked-run client id, kept outside zustand state. */
const pollers = new Map<string, ReturnType<typeof setInterval>>();

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

type ActionsState = {
  /** Tracked dispatched runs, keyed by client id, newest dispatch first when sorted. */
  tracked: Record<string, TrackedRun>;
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
  };

  return {
    tracked: {},

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
