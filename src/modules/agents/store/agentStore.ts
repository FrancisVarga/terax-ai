import { create } from "zustand";
import type {
  AgentHistoryEntry,
  AgentNotification,
  AgentSession,
  AgentStatus,
  LocalAgentState,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;
const MAX_HISTORY = 100;
const HISTORY_STORAGE_KEY = "terax:agent-history";

let notifSeq = 0;
let historySeq = 0;

/**
 * Load persisted history. Restored entries are forced to a finished state:
 * after a restart no panes exist, so nothing may render as "active". Returns
 * newest-first, capped, and seeds `historySeq` past the largest stored id so
 * fresh entries keep unique ids.
 */
function loadHistory(): AgentHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: AgentHistoryEntry[] = [];
    for (const e of parsed) {
      if (
        !e ||
        typeof e.id !== "string" ||
        typeof e.leafId !== "number" ||
        typeof e.tabId !== "number" ||
        typeof e.agent !== "string" ||
        typeof e.startedAt !== "number"
      ) {
        continue;
      }
      const n = Number.parseInt(e.id.slice(1), 10);
      if (Number.isFinite(n) && n > historySeq) historySeq = n;
      entries.push({
        id: e.id,
        leafId: e.leafId,
        tabId: e.tabId,
        agent: e.agent,
        startedAt: e.startedAt,
        // Force finished: the pane from a previous run no longer exists.
        endedAt: typeof e.endedAt === "number" ? e.endedAt : e.startedAt,
      });
    }
    return entries.slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

/** Persist and return the same array, for inline use inside reducers. */
function persist(history: AgentHistoryEntry[]): AgentHistoryEntry[] {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // ignore quota / serialization failures
  }
  return history;
}

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  history: AgentHistoryEntry[];
  localAgent: LocalAgentState;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string) => void;
  setStatus: (leafId: number, status: AgentStatus) => void;
  finish: (leafId: number) => void;
  setLocalAgent: (state: LocalAgentState) => void;
  pushNotification: (
    n: Omit<AgentNotification, "id" | "at" | "read">,
  ) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
  clearHistory: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  history: loadHistory(),
  localAgent: null,
  notifications: [],

  start: (leafId, tabId, agent) =>
    set((s) => {
      const now = Date.now();
      const entry: AgentHistoryEntry = {
        id: `h${++historySeq}`,
        leafId,
        tabId,
        agent,
        startedAt: now,
        endedAt: null,
      };
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
        history: persist([entry, ...s.history].slice(0, MAX_HISTORY)),
      };
    }),

  setStatus: (leafId, status) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev || prev.status === status) return s;
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
          },
        },
      };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      const now = Date.now();
      // Stamp endedAt on the most recent still-live entry for this pane so the
      // history row stops being clickable once the agent's pane is gone.
      let stamped = false;
      const history = s.history.map((h) => {
        if (!stamped && h.leafId === leafId && h.endedAt === null) {
          stamped = true;
          return { ...h, endedAt: now };
        }
        return h;
      });
      return { sessions: next, history: persist(history) };
    }),

  setLocalAgent: (state) =>
    set((s) => {
      const a = s.localAgent;
      if (a === state) return s;
      if (a && state && a.status === state.status && a.agent === state.agent) {
        return s;
      }
      return { localAgent: state };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) };
    }),

  clearNotifications: () => set({ notifications: [] }),

  // Keep still-live runs; only drop completed history records.
  clearHistory: () =>
    set((s) => {
      if (s.history.every((h) => h.endedAt === null)) return s;
      return { history: persist(s.history.filter((h) => h.endedAt === null)) };
    }),
}));
