import { create } from "zustand";
import {
  killSession,
  listSessions,
  newSession,
  newWindow,
  renameSession,
  splitWindow,
  type DaemonSessionId,
  type DaemonWindowId,
  type NewSessionResult,
  type Session,
  type SplitDir,
} from "./rmux-client";

/** Count of panes across every window of a session (the row's "N panes"). */
export function paneCount(session: Session): number {
  return session.windows.reduce((sum, w) => sum + w.panes.length, 0);
}

/** A session's first window, the one "attach" targets. Undefined if it has none. */
export function activeWindow(session: Session): Session["windows"][number] | undefined {
  return session.windows[0];
}

type SessionsState = {
  sessions: Session[];
  loading: boolean;
  /** Last refresh error (null = ok). Surfaced inline, never thrown at React. */
  error: string | null;
  /** True once a refresh has resolved at least once, so the empty state only
   *  shows after a real (empty) list, not during the first in-flight load. */
  loaded: boolean;
  /** Optimistic name overrides keyed by session id, applied on top of the
   *  fetched tree until refresh confirms (or a failed rename rolls back). */
  optimisticNames: Record<DaemonSessionId, string>;

  refresh: () => Promise<void>;
  create: (name: string, cwd?: string) => Promise<NewSessionResult>;
  rename: (id: DaemonSessionId, name: string) => Promise<void>;
  kill: (id: DaemonSessionId) => Promise<void>;
  newWindow: (id: DaemonSessionId, name?: string) => Promise<void>;
  split: (windowId: DaemonWindowId, dir: SplitDir) => Promise<void>;
};

/**
 * State for the SessionSwitcher: the daemon session tree plus the action
 * wrappers that mutate it then re-list. `rmux_session_list` returns [] when the
 * daemon is not connected (rmux flag off, or sidecar not staged), so `refresh`
 * never throws for that case — it resolves to an empty tree and the switcher
 * shows its empty state. The mutating verbs DO reject when the daemon is absent;
 * callers (the panel) catch and toast those.
 */
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  loaded: false,
  optimisticNames: {},

  refresh: async () => {
    set({ loading: true });
    try {
      const sessions = await listSessions();
      // Drop optimistic overrides the server has now caught up with; keep only
      // those still mid-flight (a name the fetched tree does not yet reflect).
      set((s) => {
        const optimisticNames: Record<number, string> = {};
        for (const [idStr, name] of Object.entries(s.optimisticNames)) {
          const id = Number(idStr);
          const live = sessions.find((x) => x.session_id === id);
          if (live && live.name !== name) optimisticNames[id] = name;
        }
        return { sessions, loading: false, error: null, loaded: true, optimisticNames };
      });
    } catch (e) {
      set({ loading: false, error: String(e), loaded: true });
    }
  },

  create: async (name, cwd) => {
    const result = await newSession(name, cwd);
    await get().refresh();
    return result;
  },

  rename: async (id, name) => {
    const prev = get().sessions.find((s) => s.session_id === id)?.name;
    // Optimistic: show the new name immediately, roll back on failure.
    set((s) => ({ optimisticNames: { ...s.optimisticNames, [id]: name } }));
    try {
      await renameSession(id, name);
      await get().refresh();
    } catch (e) {
      set((s) => {
        const optimisticNames = { ...s.optimisticNames };
        if (prev === undefined) delete optimisticNames[id];
        else optimisticNames[id] = prev;
        return { optimisticNames };
      });
      throw e;
    }
  },

  kill: async (id) => {
    await killSession(id);
    await get().refresh();
  },

  newWindow: async (id, name) => {
    await newWindow(id, name);
    await get().refresh();
  },

  split: async (windowId, dir) => {
    await splitWindow(windowId, dir);
    await get().refresh();
  },
}));

/** The display name for a session, preferring an in-flight optimistic rename. */
export function displayName(
  session: Session,
  optimisticNames: Record<DaemonSessionId, string>,
): string {
  return (
    optimisticNames[session.session_id] ??
    session.name ??
    `session ${session.session_id}`
  );
}
