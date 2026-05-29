import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import type { AgentHistoryEntry } from "@/modules/agents/lib/types";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

type Props = {
  onActivate: (tabId: number, leafId: number) => void;
};

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function HistoryRow({
  entry,
  active,
  onClick,
}: {
  entry: AgentHistoryEntry;
  active: boolean;
  onClick?: () => void;
}) {
  const rowClass =
    "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left";
  const body = (
    <>
      <AgentIcon
        agent={entry.agent}
        size={16}
        className="shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {entry.agent}
      </span>
      {active ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
          <span className="size-1.5 rounded-full bg-primary" />
          active
        </span>
      ) : (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {relativeTime(entry.endedAt ?? entry.startedAt)}
        </span>
      )}
    </>
  );

  if (active) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(rowClass, "transition-colors hover:bg-accent")}
      >
        {body}
      </button>
    );
  }
  return <div className={cn(rowClass, "cursor-default opacity-70")}>{body}</div>;
}

/**
 * Right-sidebar Session History view. Lists every agent run (newest first)
 * from the shared `useAgentStore`. A run is "active" when its pane still
 * exists in the live `sessions` map — clicking an active row re-focuses that
 * pane via `onActivate`. Finished runs render as non-clickable records.
 */
export function SessionHistoryPanel({ onActivate }: Props) {
  const history = useAgentStore((s) => s.history);
  const sessions = useAgentStore((s) => s.sessions);
  const clearHistory = useAgentStore((s) => s.clearHistory);

  const hasFinished = useMemo(
    () => history.some((h) => h.endedAt !== null),
    [history],
  );

  const isActive = (entry: AgentHistoryEntry) =>
    entry.endedAt === null && sessions[entry.leafId] !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">Session History</span>
        {hasFinished ? (
          <button
            type="button"
            onClick={clearHistory}
            aria-label="Clear finished sessions"
            title="Clear finished sessions"
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {history.length === 0 ? (
        <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
          No agent sessions yet.
          <br />
          Runs appear here once an agent starts.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {history.map((entry) => {
            const active = isActive(entry);
            return (
              <HistoryRow
                key={entry.id}
                entry={entry}
                active={active}
                onClick={
                  active
                    ? () => onActivate(entry.tabId, entry.leafId)
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
