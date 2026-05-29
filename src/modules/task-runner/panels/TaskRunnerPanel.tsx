import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnsiLog } from "../components/AnsiLog";
import { buildTree, scanManifests } from "../lib/scan";
import type { PackageManifest, TaskScript, TreeNode } from "../lib/types";
import { useTaskRunnerStore } from "../store/taskRunnerStore";

type ScanState =
  | { status: "loading" }
  | { status: "ready"; tree: TreeNode[]; count: number }
  | { status: "empty" }
  | { status: "error"; message: string };

const PM_BADGE: Record<string, string> = {
  npm: "text-red-500",
  pnpm: "text-amber-500",
  yarn: "text-sky-500",
  bun: "text-pink-500",
};

export function TaskRunnerPanel() {
  const [scan, setScan] = useState<ScanState>({ status: "loading" });
  // Re-scan whenever the active workspace env changes (e.g. switching to WSL).
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  // The project root the rest of the app uses (active terminal cwd → explorer
  // root → launch dir → home), NOT the app launch dir. Subscribing to `live`
  // re-runs the scan when the user changes folders / terminal cwd. See
  // chatStore.live.getWorkspaceRoot in App.tsx.
  const live = useChatStore((s) => s.live);

  const tasks = useTaskRunnerStore((s) => s.tasks);
  const selectedId = useTaskRunnerStore((s) => s.selectedId);
  const run = useTaskRunnerStore((s) => s.run);
  const stop = useTaskRunnerStore((s) => s.stop);
  const remove = useTaskRunnerStore((s) => s.remove);
  const select = useTaskRunnerStore((s) => s.select);
  const findRunning = useTaskRunnerStore((s) => s.findRunning);

  const rescan = useCallback(async () => {
    setScan({ status: "loading" });
    try {
      const root = live.getWorkspaceRoot();
      if (!root) {
        setScan({ status: "empty" });
        return;
      }
      const manifests = await scanManifests(root);
      if (manifests.length === 0) {
        setScan({ status: "empty" });
        return;
      }
      setScan({
        status: "ready",
        tree: buildTree(manifests),
        count: manifests.length,
      });
    } catch (e) {
      setScan({ status: "error", message: String(e) });
    }
  }, [live]);

  useEffect(() => {
    void rescan();
  }, [rescan, workspaceEnv]);

  const selected = selectedId ? tasks[selectedId] : null;
  const runningCount = useMemo(
    () => Object.values(tasks).filter((t) => t.status === "running").length,
    [tasks],
  );

  const onRun = useCallback(
    (manifest: PackageManifest, script: TaskScript) => {
      void run(manifest, script);
    },
    [run],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">Tasks</span>
        {runningCount > 0 ? (
          <span className="rounded-full bg-primary/10 px-1.5 text-[10px] normal-case text-primary">
            {runningCount} running
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void rescan()}
          aria-label="Rescan for package.json"
          title="Rescan workspace"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {scan.status === "loading" ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            Scanning for package.json…
          </div>
        ) : scan.status === "error" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-destructive">
            Scan failed.
            <br />
            <span className="text-muted-foreground">{scan.message}</span>
          </div>
        ) : scan.status === "empty" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No package.json with scripts found in this workspace.
          </div>
        ) : (
          <div className="p-1">
            {scan.tree.map((node, i) => (
              <TreeNodeRow
                key={i}
                node={node}
                depth={0}
                onRun={onRun}
                findRunning={findRunning}
              />
            ))}
          </div>
        )}
      </div>

      {/* Running tasks + live output detail */}
      {Object.keys(tasks).length > 0 ? (
        <div className="flex min-h-0 shrink-0 flex-col border-t border-border/60">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-1.5 py-1.5">
            {Object.values(tasks)
              .sort((a, b) => b.startedAt - a.startedAt)
              .map((t) => {
                const active = t.id === selectedId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => select(t.id)}
                    aria-pressed={active}
                    className={cn(
                      "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
                      active
                        ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        t.status === "running"
                          ? "animate-pulse bg-emerald-500"
                          : t.exitCode === 0
                            ? "bg-muted-foreground"
                            : "bg-destructive",
                      )}
                    />
                    <span className="max-w-28 truncate">{t.script}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Remove task"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(t.id);
                      }}
                      className="opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={11} />
                    </span>
                  </button>
                );
              })}
          </div>

          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                  {selected.pkgName} · {selected.command}
                </span>
                {selected.status === "running" ? (
                  <button
                    type="button"
                    onClick={() => void stop(selected.id)}
                    title="Stop task"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <HugeiconsIcon icon={StopIcon} size={11} strokeWidth={2} />
                    Stop
                  </button>
                ) : (
                  <span
                    className={cn(
                      "rounded px-1.5 text-[10px] tabular-nums",
                      selected.exitCode === 0
                        ? "text-muted-foreground"
                        : "text-destructive",
                    )}
                  >
                    exit {selected.exitCode ?? "?"}
                  </span>
                )}
              </div>
              <div className="h-48 min-h-0">
                <AnsiLog text={selected.output} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  onRun,
  findRunning,
}: {
  node: TreeNode;
  depth: number;
  onRun: (m: PackageManifest, s: TaskScript) => void;
  findRunning: (dir: string, script: string) => { id: string } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pad = { paddingLeft: 8 + depth * 12 };

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={pad}
          className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={13}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="truncate">{node.name}</span>
        </button>
        {open
          ? node.children.map((c, i) => (
              <TreeNodeRow
                key={i}
                node={c}
                depth={depth + 1}
                onRun={onRun}
                findRunning={findRunning}
              />
            ))
          : null}
      </div>
    );
  }

  return (
    <PackageRow manifest={node.manifest} depth={depth} onRun={onRun} findRunning={findRunning} />
  );
}

function PackageRow({
  manifest,
  depth,
  onRun,
  findRunning,
}: {
  manifest: PackageManifest;
  depth: number;
  onRun: (m: PackageManifest, s: TaskScript) => void;
  findRunning: (dir: string, script: string) => { id: string } | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pad = { paddingLeft: 8 + depth * 12 };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pad}
        className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left transition-colors hover:bg-accent/60"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={13}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {manifest.name}
        </span>
        <span
          className={cn(
            "shrink-0 text-[9px] font-semibold uppercase",
            PM_BADGE[manifest.packageManager],
          )}
        >
          {manifest.packageManager}
        </span>
      </button>
      {open
        ? manifest.scripts.map((script) => {
            const running = findRunning(manifest.dir, script.name);
            return (
              <div
                key={script.name}
                style={{ paddingLeft: 8 + (depth + 1) * 12 }}
                className="group flex items-center gap-2 rounded py-0.5 pr-2 hover:bg-accent/40"
              >
                <button
                  type="button"
                  onClick={() => onRun(manifest, script)}
                  title={script.command}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                    running
                      ? "text-emerald-500"
                      : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
                  )}
                >
                  <HugeiconsIcon
                    icon={running ? StopIcon : PlayIcon}
                    size={12}
                    strokeWidth={2}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                  {script.name}
                </span>
                <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-[10px] text-muted-foreground/70">
                  {script.command}
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
}
