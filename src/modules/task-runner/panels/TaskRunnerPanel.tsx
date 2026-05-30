import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ArrowExpand01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnsiLog } from "../components/AnsiLog";
import { buildTree } from "../lib/scan";
import type { PackageManifest, TaskScript, TreeNode } from "../lib/types";
import { useTaskRunnerStore } from "../store/taskRunnerStore";

const PM_BADGE: Record<string, string> = {
  npm: "text-red-500",
  pnpm: "text-amber-500",
  yarn: "text-sky-500",
  bun: "text-pink-500",
};

export function TaskRunnerPanel() {
  // Re-scan whenever the active workspace env changes (e.g. switching to WSL).
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  // The project root the rest of the app uses (active terminal cwd → explorer
  // root → launch dir → home), NOT the app launch dir. Subscribing to `live`
  // re-runs the scan when the user changes folders / terminal cwd. See
  // chatStore.live.getWorkspaceRoot in App.tsx.
  const live = useChatStore((s) => s.live);
  const root = live.getWorkspaceRoot();

  const tasks = useTaskRunnerStore((s) => s.tasks);
  const selectedId = useTaskRunnerStore((s) => s.selectedId);
  const run = useTaskRunnerStore((s) => s.run);
  const stop = useTaskRunnerStore((s) => s.stop);
  const remove = useTaskRunnerStore((s) => s.remove);
  const clearOutput = useTaskRunnerStore((s) => s.clearOutput);
  const select = useTaskRunnerStore((s) => s.select);
  const findRunning = useTaskRunnerStore((s) => s.findRunning);
  const setManifests = useTaskRunnerStore((s) => s.setManifests);
  const loadScan = useTaskRunnerStore((s) => s.loadScan);
  // Subscribe to the SWR scan cache for this root. The store serves the
  // last-known manifests instantly and only re-walks the filesystem when the
  // entry is stale, so re-opening the Tasks tab never re-flashes the spinner.
  const scan = useTaskRunnerStore((s) => (root ? s.scanCache[root] : undefined));

  // SWR: ensure the scan is warm on mount / root / env change. The store no-ops
  // when the cache is still fresh, so rapid sidebar toggles don't re-walk.
  useEffect(() => {
    if (root) void loadScan(root);
  }, [root, workspaceEnv, loadScan]);

  // The rescan button bypasses the TTL and forces a fresh filesystem walk.
  const rescan = useCallback(() => {
    if (root) void loadScan(root, true);
  }, [root, loadScan]);

  // Build the display tree only when the manifests reference actually changes
  // (the store keeps it stable across unchanged revalidations), so an identical
  // re-scan does not rebuild the tree or re-render the rows.
  const manifests = scan?.manifests;
  const tree = useMemo(() => (manifests ? buildTree(manifests) : []), [manifests]);

  // Publish the scanned manifests to the store's flat `manifests` field so the
  // command palette can list the same runnable scripts without re-scanning.
  // Keyed off the (referentially-stable) scan manifests, so it only fires when
  // a scan actually produces new data.
  useEffect(() => {
    setManifests(manifests ?? []);
  }, [manifests, setManifests]);

  // Derive the view status from the cache. Spinner shows only on the first scan
  // (no cache entry yet); a stale revalidation keeps the previous tree visible.
  const status: "loading" | "ready" | "empty" | "error" = !root
    ? "empty"
    : !scan || (scan.status === "loading" && scan.fetchedAt === 0)
      ? "loading"
      : scan.status;

  // Output detail pane sizing. `maximized` makes it fill the panel (hiding the
  // tree); otherwise `outputHeight` is a draggable pixel height. The drag
  // handle on the section's top border sets it live.
  const rootRef = useRef<HTMLDivElement>(null);
  const [outputHeight, setOutputHeight] = useState(224); // ~ old h-56
  const [maximized, setMaximized] = useState(false);

  const [resizing, setResizing] = useState(false);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      const rootBottom = root.getBoundingClientRect().bottom;
      // Capture the pointer on the handle so the drag keeps tracking even when
      // the cursor outruns the thin grip (the handle's hit area is small).
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      setResizing(true);
      // Lock the body cursor + kill text selection for the whole drag so a fast
      // drag over the log doesn't highlight output.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        // Height = distance from pointer to the panel bottom, clamped so the
        // tree keeps a usable sliver and the pane can't underflow its toolbar.
        const next = rootBottom - ev.clientY;
        setOutputHeight(Math.max(120, Math.min(next, root.clientHeight - 80)));
      };
      const onUp = () => {
        handle.releasePointerCapture?.(e.pointerId);
        setResizing(false);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      // With pointer capture the events fire on the handle element itself.
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [],
  );

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
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
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

      <div className={cn("min-h-0 flex-1 overflow-y-auto", maximized && "hidden")}>
        {status === "loading" ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            Scanning for package.json…
          </div>
        ) : status === "error" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-destructive">
            Scan failed.
            <br />
            <span className="text-muted-foreground">{scan?.error}</span>
          </div>
        ) : status === "empty" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No package.json with scripts found in this workspace.
          </div>
        ) : (
          <div className="p-1">
            {tree.map((node, i) => (
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
        <div
          className={cn(
            "flex min-h-0 flex-col border-t border-border/60",
            maximized ? "flex-1" : "shrink-0",
          )}
        >
          {/* Drag handle to resize the output pane (hidden when maximized).
              The hit area is a tall, transparent strip (-my-1 makes it overlap
              the neighboring borders without adding layout height) so it's easy
              to grab; the visible grip stays a thin pill. */}
          {selected && !maximized ? (
            <div
              onPointerDown={startResize}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize output"
              className={cn(
                "group relative z-10 -my-1 flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center",
                resizing && "cursor-row-resize",
              )}
            >
              <div
                className={cn(
                  "h-1 w-10 rounded-full transition-colors",
                  resizing
                    ? "bg-primary"
                    : "bg-border group-hover:bg-foreground/40",
                )}
              />
            </div>
          ) : null}
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
                <button
                  type="button"
                  onClick={() => setMaximized((v) => !v)}
                  title={maximized ? "Restore" : "Expand output"}
                  aria-label={maximized ? "Restore output" : "Expand output"}
                  aria-pressed={maximized}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </button>
              </div>
              <div
                // When maximized the log fills remaining space (flex-1). When
                // not, JS owns the height via state, so it must be shrink-0 with
                // an explicit pixel height — a flex-1 child would let flexbox
                // recompute the size and visually ignore the dragged value.
                className={cn("min-h-0", maximized ? "flex-1" : "shrink-0")}
                style={maximized ? undefined : { height: outputHeight }}
              >
                <AnsiLog
                  text={selected.output}
                  onClear={() => clearOutput(selected.id)}
                />
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
