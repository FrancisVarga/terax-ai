import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  PlayIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo } from "react";
import type { WorkflowDef, WorkflowRun } from "../lib/gh";
import { useActionsStore, type TrackedRun } from "../store/actionsStore";

export function GitHubActionsPanel() {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const live = useChatStore((s) => s.live);
  const root = live.getWorkspaceRoot();

  const tracked = useActionsStore((s) => s.tracked);
  const dispatch = useActionsStore((s) => s.dispatch);
  const forget = useActionsStore((s) => s.forget);
  const loadMeta = useActionsStore((s) => s.loadMeta);
  const loadRuns = useActionsStore((s) => s.loadRuns);

  // Read the per-cwd caches. `undefined` means "never loaded for this root".
  const meta = useActionsStore((s) => (root ? s.metaCache[root] : undefined));
  const runs = useActionsStore((s) => (root ? s.runsCache[root] : undefined));

  // SWR: on mount / root change / env change, ask the store to ensure the
  // caches are warm. The store no-ops when the cache is still fresh, so rapid
  // sidebar tab toggles do not spawn `gh`.
  useEffect(() => {
    if (!root) return;
    void loadMeta(root);
    void loadRuns(root);
  }, [root, workspaceEnv, loadMeta, loadRuns]);

  const reload = useCallback(() => {
    if (!root) return;
    void loadMeta(root, true);
    void loadRuns(root, true);
  }, [root, loadMeta, loadRuns]);

  const onRun = useCallback(
    (w: WorkflowDef) => {
      if (!root) return;
      void dispatch({
        workflowFile: w.path.replace(/^\.github\/workflows\//, ""),
        workflowName: w.name,
        cwd: root,
      });
    },
    [dispatch, root],
  );

  const trackedList = useMemo(
    () => Object.values(tracked).sort((a, b) => b.startedAt - a.startedAt),
    [tracked],
  );

  // Derive the header/empty-state from the cached meta (default to loading).
  const status = !root ? "no-repo" : (meta?.status ?? "loading");
  const refreshing = Boolean(meta?.loading || runs?.loading);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1 truncate">
          {meta?.repo?.nameWithOwner ?? "GitHub Actions"}
        </span>
        <button
          type="button"
          onClick={reload}
          aria-label="Reload workflows"
          title="Reload workflows"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={13}
            strokeWidth={1.75}
            className={cn(refreshing && "animate-spin")}
          />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            Loading workflows…
          </div>
        ) : status === "no-repo" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No GitHub repository here.
            <br />
            Open a folder whose <code>gh</code> context is a GitHub repo.
          </div>
        ) : status === "error" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-destructive">
            Could not load workflows.
            <br />
            <span className="text-muted-foreground">{meta?.error}</span>
          </div>
        ) : status === "empty" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No active workflows in <code>.github/workflows</code>.
          </div>
        ) : (
          <div className="p-1">
            {(meta?.workflows ?? []).map((w) => (
              <WorkflowRow key={w.id} workflow={w} onRun={() => onRun(w)} />
            ))}
          </div>
        )}
      </div>

      {trackedList.length > 0 ? (
        <div className="flex shrink-0 flex-col border-t border-border/60">
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Dispatched
          </div>
          <div className="max-h-48 overflow-y-auto px-1 pb-1">
            {trackedList.map((run) => (
              <TrackedRunRow key={run.id} run={run} onForget={() => forget(run.id)} />
            ))}
          </div>
        </div>
      ) : null}

      {root && status !== "no-repo" && (runs?.runs.length ?? 0) > 0 ? (
        <RecentRuns runs={runs!.runs} />
      ) : null}
    </div>
  );
}

/**
 * Cached recent-run history (any workflow, any trigger), distinct from the
 * "Dispatched" section which only shows runs this app kicked off. Served from
 * the store cache, so it renders instantly on tab re-open.
 */
function RecentRuns({ runs }: { runs: WorkflowRun[] }) {
  return (
    <div className="flex shrink-0 flex-col border-t border-border/60">
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        History
      </div>
      <div className="max-h-56 overflow-y-auto px-1 pb-1">
        {runs.map((run) => (
          <RecentRunRow key={run.databaseId} run={run} />
        ))}
      </div>
    </div>
  );
}

function RecentRunRow({ run }: { run: WorkflowRun }) {
  const done = run.status === "completed";
  const ok = run.conclusion === "success";

  return (
    <button
      type="button"
      onClick={() => void openUrl(run.url).catch(() => {})}
      title={`${run.displayTitle} — open on GitHub`}
      className="group flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent/40"
    >
      {!done ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={13}
          className="shrink-0 animate-spin text-emerald-500"
        />
      ) : (
        <HugeiconsIcon
          icon={ok ? CheckmarkCircle02Icon : AlertCircleIcon}
          size={13}
          className={cn("shrink-0", ok ? "text-emerald-500" : "text-destructive")}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground/90">
          {run.workflowName}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {run.headBranch} ·{" "}
          {done ? (run.conclusion ?? "completed") : run.status.replace(/_/g, " ")}
        </span>
      </div>
      <HugeiconsIcon
        icon={Clock01Icon}
        size={11}
        className="shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

function WorkflowRow({
  workflow,
  onRun,
}: {
  workflow: WorkflowDef;
  onRun: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded py-1 pl-2 pr-2 hover:bg-accent/40">
      <button
        type="button"
        onClick={onRun}
        title={`Run ${workflow.name}`}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
      >
        <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
      </button>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
        {workflow.name}
      </span>
      <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-[10px] text-muted-foreground/70">
        {workflow.path.replace(/^\.github\/workflows\//, "")}
      </span>
    </div>
  );
}

function TrackedRunRow({
  run,
  onForget,
}: {
  run: TrackedRun;
  onForget: () => void;
}) {
  const done = run.status === "completed";
  const ok = run.conclusion === "success";
  const failed = run.error || (done && !ok);

  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/40">
      {run.error ? (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={13}
          className="shrink-0 text-destructive"
        />
      ) : !done ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={13}
          className="shrink-0 animate-spin text-emerald-500"
        />
      ) : (
        <HugeiconsIcon
          icon={ok ? CheckmarkCircle02Icon : AlertCircleIcon}
          size={13}
          className={cn("shrink-0", ok ? "text-emerald-500" : "text-destructive")}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground/90">
          {run.workflowName}
        </span>
        <span
          className={cn(
            "truncate text-[10px]",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {run.error
            ? run.error
            : run.status === "dispatching"
              ? "dispatching…"
              : done
                ? (run.conclusion ?? "completed")
                : run.status.replace(/_/g, " ")}
        </span>
      </div>
      {run.url ? (
        <button
          type="button"
          onClick={() => void openUrl(run.url!).catch(() => {})}
          aria-label="Open run on GitHub"
          title="Open run on GitHub"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={12} strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onForget}
        aria-label="Dismiss run"
        title="Dismiss"
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} />
      </button>
    </div>
  );
}
