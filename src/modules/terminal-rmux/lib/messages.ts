import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  busPublish,
  inboxAck,
  inboxList,
  type BusMessage,
  type BusTarget,
  type DaemonPaneId,
  type PublishResult,
} from "./rmux-client";

/**
 * Newest-first sort helper for an inbox list. The daemon hands back messages in
 * insertion order; the viewer wants the most recent at the top, so both the
 * fetched snapshot and the live-appended messages are kept sorted by id desc
 * (id is the daemon's monotonic message counter, a stable proxy for ts).
 */
function byNewest(a: BusMessage, b: BusMessage): number {
  return b.id - a.id;
}

/**
 * Merge an incoming live message into a pane's existing list without
 * duplicating: the same message can arrive both from the `terax:rmux-message`
 * push AND a concurrent refresh() snapshot, so de-dupe on message id. Returns the
 * list newest-first.
 */
function mergeMessage(list: BusMessage[], msg: BusMessage): BusMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [msg, ...list].sort(byNewest);
}

type MessagesState = {
  /** Per-pane inbox snapshots, keyed by daemon pane id. */
  inboxes: Record<DaemonPaneId, BusMessage[]>;
  /** Total unread count across panes — drives the floating button's badge. It
   *  is bumped by live pushes and recomputed on refresh/ack so it can never
   *  drift from the actual inbox contents. */
  unread: number;
  /** True once the event subscription is live, so subscribe() is idempotent
   *  under React StrictMode's double-mount. */
  subscribed: boolean;
  /** Set once a published message has been delivered or an inbox_list returned
   *  a non-empty result, OR a live message arrived: any of these proves a
   *  connected daemon, which is how the coordinator gates its button. */
  daemonSeen: boolean;

  refresh: (paneId: DaemonPaneId) => Promise<void>;
  ack: (paneId: DaemonPaneId, ids?: number[]) => Promise<void>;
  publish: (
    from: DaemonPaneId,
    to: BusTarget,
    type: string,
    payload: unknown,
    inject: boolean,
  ) => Promise<PublishResult>;
  /** Subscribe to the `terax:rmux-message` Tauri event. Idempotent; returns an
   *  unlisten so callers can tear down on unmount (the store also guards against
   *  a double subscribe so a leaked listener can't double-count). */
  subscribe: () => Promise<UnlistenFn>;
};

/** Sum of message counts across every pane inbox — the canonical unread value. */
function totalUnread(inboxes: Record<DaemonPaneId, BusMessage[]>): number {
  let sum = 0;
  for (const list of Object.values(inboxes)) sum += list.length;
  return sum;
}

/**
 * State for the RmuxMessagesCoordinator: per-pane bus inboxes plus the live
 * subscription that feeds them. The degrade contract mirrors useSessionsStore —
 * reads (refresh) never throw at React (the backend returns an empty inbox when
 * the daemon is off); writes (publish/ack) DO reject and callers toast.
 *
 * The live path: the backend bridges every `FRAME_MSG` on a pane's attach stream
 * to a `terax:rmux-message` Tauri event whose payload is the serialized
 * BusMessage. `subscribe()` listens for it and appends each message to the
 * `to`-addressed pane's list (using the message's own routing target when it is a
 * concrete pane id, else its `from` is irrelevant — the event only fires for
 * panes THIS webview has attached, so we bucket by the delivered pane). Since the
 * event payload does not name the receiving pane explicitly, we bucket by the
 * message `to` when it is a numeric pane id, and otherwise fall back to a
 * broadcast bucket so the message is still visible.
 */
export const useMessagesStore = create<MessagesState>((set, get) => ({
  inboxes: {},
  unread: 0,
  subscribed: false,
  daemonSeen: false,

  refresh: async (paneId) => {
    try {
      const messages = await inboxList(paneId);
      set((s) => {
        const inboxes = { ...s.inboxes, [paneId]: [...messages].sort(byNewest) };
        return {
          inboxes,
          unread: totalUnread(inboxes),
          // A successful non-empty read proves a connected daemon. An empty read
          // is ambiguous (daemon off, or daemon on with an empty inbox), so it
          // does not flip the gate on its own.
          daemonSeen: s.daemonSeen || messages.length > 0,
        };
      });
    } catch {
      // Reads must never throw at React; an inbox_list failure (daemon error)
      // leaves the existing snapshot untouched and shows nothing new.
    }
  },

  ack: async (paneId, ids) => {
    await inboxAck(paneId, ids);
    // Re-read so the cleared (or partially cleared) inbox and the unread count
    // reflect the daemon's post-ack truth rather than an optimistic guess.
    await get().refresh(paneId);
  },

  publish: async (from, to, type, payload, inject) => {
    const result = await busPublish(from, to, type, payload, inject);
    // A delivered publish proves the daemon is connected, so reveal the button
    // even if no inbox has been read yet.
    set({ daemonSeen: true });
    return result;
  },

  subscribe: async () => {
    // Guard the double-mount: a second subscribe() must not register a second
    // listener (which would double-count every message). Hand back a no-op
    // unlisten so the caller's cleanup stays uniform.
    if (get().subscribed) return () => {};
    set({ subscribed: true });
    const unlisten = await listen<BusMessage>("terax:rmux-message", (event) => {
      const msg = event.payload;
      // Bucket the live message by its routing target when that is a concrete
      // pane id; broadcasts / session / window targets land in a shared "*"
      // bucket (keyed by the broadcast sentinel) so they remain visible without
      // a pane scope. The event only fires for panes this webview attached, so
      // this never invents inboxes for panes we are not watching.
      const key: DaemonPaneId = typeof msg.to === "number" ? msg.to : msg.from;
      set((s) => {
        const inboxes = {
          ...s.inboxes,
          [key]: mergeMessage(s.inboxes[key] ?? [], msg),
        };
        return {
          inboxes,
          unread: totalUnread(inboxes),
          daemonSeen: true,
        };
      });
    });
    return () => {
      unlisten();
      set({ subscribed: false });
    };
  },
}));

/** Flatten every pane inbox into one newest-first list (the viewer's "all"). */
export function allMessages(
  inboxes: Record<DaemonPaneId, BusMessage[]>,
): BusMessage[] {
  return Object.values(inboxes)
    .flat()
    .sort((a, b) => b.id - a.id);
}
