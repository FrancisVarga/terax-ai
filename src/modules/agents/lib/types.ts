export type AgentStatus = "working" | "waiting";

export type AgentSource = "terminal" | "local";

export type AgentSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent: string | null;
};

export type AgentSession = {
  leafId: number;
  tabId: number;
  agent: string;
  status: AgentStatus;
  startedAt: number;
  lastActivityAt: number;
  attentionSince: number | null;
};

/**
 * One past or current agent run, retained for the Session History list.
 * `endedAt` is null while the run is still live. `leafId`/`tabId` let an
 * active entry re-focus its pane; once `endedAt` is set the pane is gone
 * and the entry becomes a non-clickable history record.
 */
export type AgentHistoryEntry = {
  id: string;
  leafId: number;
  tabId: number;
  agent: string;
  startedAt: number;
  endedAt: number | null;
};

export type AgentNotification = {
  id: string;
  source: AgentSource;
  leafId: number;
  tabId: number;
  agent: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
};

export type NotificationKind = "attention" | "finished" | "error";

export type LocalAgentState = {
  agent: string;
  status: AgentStatus;
} | null;
