import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import type { AgentNotification, AgentStatus } from "@/modules/agents/lib/types";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import {
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

type Props = {
  onActivate: (tabId: number, leafId: number) => void;
  onActivateLocal: () => void;
};

const NOTIF_LABEL: Record<AgentNotification["kind"], string> = {
  attention: "needs input",
  finished: "finished",
  error: "failed",
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

function StatusRow({
  agent,
  status,
  onClick,
}: {
  agent: string;
  status: AgentStatus;
  onClick: () => void;
}) {
  const waiting = status === "waiting";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <AgentIcon
        agent={agent}
        size={16}
        className="shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate text-sm text-foreground">{agent}</span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          waiting ? "font-medium text-primary" : "text-muted-foreground",
        )}
      >
        {waiting ? <span className="size-1.5 rounded-full bg-primary" /> : null}
        {waiting ? "waiting" : "working"}
      </span>
    </button>
  );
}

function NotificationRow({
  n,
  onClick,
}: {
  n: AgentNotification;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {n.kind === "finished" ? (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={15}
            strokeWidth={1.75}
            className="text-muted-foreground"
          />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full",
              n.kind === "error" ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {n.agent}{" "}
        <span className="text-muted-foreground">{NOTIF_LABEL[n.kind]}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {relativeTime(n.at)}
      </span>
    </button>
  );
}

/**
 * Always-visible agents view for the right sidebar. Subscribes to the same
 * Zustand `useAgentStore` singleton as the header `NotificationBell`, so it
 * mirrors live session/notification state without prop threading.
 */
export function AgentsPanel({ onActivate, onActivateLocal }: Props) {
  const sessions = useAgentStore((s) => s.sessions);
  const localAgent = useAgentStore((s) => s.localAgent);
  const notifications = useAgentStore((s) => s.notifications);

  const active = useMemo(() => Object.values(sessions), [sessions]);
  const activeCount = active.length + (localAgent ? 1 : 0);
  const empty = activeCount === 0 && notifications.length === 0;

  const activateNotification = (n: AgentNotification) => {
    if (n.source === "local") onActivateLocal();
    else onActivate(n.tabId, n.leafId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Agents
        {activeCount > 0 ? (
          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums normal-case tracking-normal text-muted-foreground">
            {activeCount} active
          </span>
        ) : null}
      </div>
      {empty ? (
        <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
          No agent activity yet.
          <br />
          Run the Terax agent or Claude Code to track it here.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {localAgent ? (
            <StatusRow
              agent={localAgent.agent}
              status={localAgent.status}
              onClick={onActivateLocal}
            />
          ) : null}
          {active.map((s) => (
            <StatusRow
              key={s.leafId}
              agent={s.agent}
              status={s.status}
              onClick={() => onActivate(s.tabId, s.leafId)}
            />
          ))}
          {activeCount > 0 && notifications.length > 0 ? (
            <div className="mx-2 my-1 h-px bg-border/50" />
          ) : null}
          {notifications.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onClick={() => activateNotification(n)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
