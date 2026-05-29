import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Loading03Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useTaskRunnerStore } from "../store/taskRunnerStore";

/**
 * A status-bar surface for the task runner that is visible from every view —
 * the Tasks panel only mounts when the right sidebar shows it, but tasks keep
 * running in the background (store singleton + off-React poll timers). This pill
 * shows the running count from anywhere and a popover to stop / dismiss / jump
 * to a task. `onOpenTask` focuses the Tasks panel and selects the task.
 */
export function BackgroundTasksIndicator({
  onOpenTask,
}: {
  /** Focus the Tasks panel and select `id` (App wires this to the sidebar). */
  onOpenTask: (id: string) => void;
}) {
  const tasks = useTaskRunnerStore((s) => s.tasks);
  const stop = useTaskRunnerStore((s) => s.stop);
  const remove = useTaskRunnerStore((s) => s.remove);

  // Newest first; running tasks always sort above finished ones.
  const list = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => {
        const ar = a.status === "running" ? 1 : 0;
        const br = b.status === "running" ? 1 : 0;
        if (ar !== br) return br - ar;
        return b.startedAt - a.startedAt;
      }),
    [tasks],
  );
  const runningCount = useMemo(
    () => list.filter((t) => t.status === "running").length,
    [list],
  );

  // Nothing spawned yet → no footprint in the status bar.
  if (list.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Background tasks"
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors",
            runningCount > 0
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {runningCount > 0 ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={11}
              strokeWidth={2}
              className="animate-spin"
            />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground" />
          )}
          <span className="tabular-nums">
            {runningCount > 0 ? `${runningCount} running` : `${list.length} task${list.length === 1 ? "" : "s"}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 gap-0 rounded-xl p-1"
      >
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Background tasks
        </div>
        <div className="max-h-72 overflow-y-auto">
          {list.map((t) => (
            <div
              key={t.id}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/60"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  t.status === "running"
                    ? "animate-pulse bg-emerald-500"
                    : t.exitCode === 0
                      ? "bg-muted-foreground"
                      : "bg-destructive",
                )}
              />
              <button
                type="button"
                onClick={() => onOpenTask(t.id)}
                className="flex min-w-0 flex-1 flex-col items-start text-left"
              >
                <span className="w-full truncate text-[12px] text-foreground">
                  {t.script}
                </span>
                <span className="w-full truncate font-mono text-[10px] text-muted-foreground">
                  {t.pkgName} · {t.command}
                  {t.status !== "running" ? ` · exit ${t.exitCode ?? "?"}` : ""}
                </span>
              </button>
              {t.status === "running" ? (
                <button
                  type="button"
                  onClick={() => void stop(t.id)}
                  title="Stop task"
                  aria-label="Stop task"
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => remove(t.id)}
                  title="Dismiss"
                  aria-label="Dismiss task"
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
