import {
  markRmuxLeaf,
  reattachSession,
  unmarkRmuxLeaf,
} from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";

// Typed views of the rmux daemon's session/window/pane tree, as returned by the
// daemon's GET /session/list HTTP verb (#130). These mirror the daemon JSON
// (snake_case ids) so the future SessionSwitcher (#132) can render the tree
// without re-deriving the shapes. They are declared here NOW even though no
// Tauri command surfaces them yet (see the TODO below) so the switcher can be
// typed against a stable contract.
export type DaemonPaneId = number;
export type DaemonWindowId = number;
export type DaemonSessionId = number;

export type Pane = {
  pane_id: DaemonPaneId;
  cwd?: string;
};

export type Window = {
  window_id: DaemonWindowId;
  panes: Pane[];
};

export type Session = {
  session_id: DaemonSessionId;
  name?: string;
  windows: Window[];
};

// Shapes returned by the create verbs (the daemon hands back the ids it minted
// so callers can attach/split without re-listing). Mirror the daemon JSON.
export type NewSessionResult = {
  session_id: DaemonSessionId;
  window_id: DaemonWindowId;
  pane_id: DaemonPaneId;
};

export type NewWindowResult = {
  window_id: DaemonWindowId;
  pane_id: DaemonPaneId;
};

export type SplitWindowResult = {
  pane_id: DaemonPaneId;
};

export type SplitDir = "row" | "col";

// The session/window verbs, proxied by the rmux::* Tauri commands (#130, #132).
// `rmux_session_list` returns [] when the daemon is not connected (flag off or
// not staged), so listSessions degrades to an empty tree rather than throwing —
// the switcher renders its empty state. The mutating verbs DO reject when the
// daemon is absent; callers surface that as a toast.
export function listSessions(): Promise<Session[]> {
  return invoke<Session[]>("rmux_session_list");
}

export function newSession(
  name: string,
  cwd?: string,
): Promise<NewSessionResult> {
  return invoke<NewSessionResult>("rmux_session_new", { name, cwd });
}

export function renameSession(
  id: DaemonSessionId,
  name: string,
): Promise<void> {
  return invoke<void>("rmux_session_rename", { id, name });
}

export function killSession(id: DaemonSessionId): Promise<void> {
  return invoke<void>("rmux_session_kill", { id });
}

export function newWindow(
  sessionId: DaemonSessionId,
  name?: string,
): Promise<NewWindowResult> {
  return invoke<NewWindowResult>("rmux_window_new", {
    sessionId,
    name,
  });
}

export function splitWindow(
  windowId: DaemonWindowId,
  dir: SplitDir,
): Promise<SplitWindowResult> {
  return invoke<SplitWindowResult>("rmux_window_split", {
    windowId,
    dir,
  });
}

// --- Message bus (#137/#138) ---
// Typed views of the daemon's #136 bus, surfaced by the rmux_bus_* / rmux_inbox_*
// Tauri commands. The wire shapes mirror the daemon JSON (a BusMessage as emitted
// on the `terax:rmux-message` event and stored in each pane's inbox).

/**
 * A single bus message, exactly as the daemon serializes it: on the live push
 * (`terax:rmux-message` event payload) and in the durable per-pane inbox. `from`
 * and `to` are daemon pane ids / routing values; `payload` is arbitrary JSON the
 * sender chose, so it is `unknown` here and callers narrow before reading it.
 */
export type BusMessage = {
  id: number;
  from: DaemonPaneId;
  /** The routing value the sender published with (see BusTarget). */
  to: BusTarget;
  type: string;
  payload: unknown;
  inject: boolean;
  /** Daemon timestamp (epoch ms) the message was published. */
  ts: number;
};

/**
 * A publish target, matching the daemon's routing union: a concrete pane id, all
 * panes of a named session, all panes of a named window, or "*" to broadcast to
 * every pane. Passed straight through to the backend as the command's `to` arg
 * (the Rust side takes it as an untyped JSON `Value`).
 */
export type BusTarget =
  | DaemonPaneId
  | { session: string }
  | { window: string }
  | "*";

/** Daemon JSON returned by /bus/publish via rmux_bus_publish. */
export type PublishResult = {
  delivered: number;
  message_id: number;
};

/** Daemon JSON returned by rmux_inbox_list (`{messages:[]}` when daemon off). */
type InboxListResult = {
  messages: BusMessage[];
};

/**
 * Publish a bus message. `from` is the sender's daemon pane id (the daemon
 * accepts any value, so the compose form may let the user pick it). Rejects when
 * the daemon is not connected (a write) — callers toast the error.
 */
export function busPublish(
  from: DaemonPaneId,
  to: BusTarget,
  type: string,
  payload: unknown,
  inject: boolean,
): Promise<PublishResult> {
  return invoke<PublishResult>("rmux_bus_publish", {
    from,
    to,
    type,
    payload,
    inject,
  });
}

/**
 * Snapshot a pane's inbox (non-draining). Returns the messages array, degrading
 * to `[]` when the daemon is not connected (the backend returns `{messages:[]}`)
 * so a poller shows "no messages" instead of erroring — mirrors listSessions.
 */
export async function inboxList(paneId: DaemonPaneId): Promise<BusMessage[]> {
  const result = await invoke<InboxListResult>("rmux_inbox_list", { paneId });
  return result.messages;
}

/**
 * Ack (drain) inbox messages for a pane. `ids` present drains exactly those;
 * `ids` absent drains the whole inbox. Rejects when the daemon is absent (a
 * write).
 */
export function inboxAck(
  paneId: DaemonPaneId,
  ids?: number[],
): Promise<void> {
  return invoke<void>("rmux_inbox_ack", { paneId, ids });
}

// Reattach a known daemon pane into a mounted leaf. The leaf is marked rmux by
// reattachSession so its subsequent close detaches (keeping the daemon shell
// alive) instead of killing. Returns true once the pane is streaming into the
// leaf.
export function reattachPane(
  leafId: number,
  daemonPaneId: DaemonPaneId,
): Promise<boolean> {
  return reattachSession(leafId, daemonPaneId);
}

// Opt a leaf into detach-on-close without reattaching an existing pane. Used
// when a leaf opens a fresh daemon-backed pane (the eager openPty path reads
// the rmux mark to choose detach mode) so closing the tab leaves the shell
// running in the daemon for later reattach.
export function markPaneDetachable(leafId: number): void {
  markRmuxLeaf(leafId);
}

// Reverse markPaneDetachable: the leaf's close reverts to a kill. Call when a
// leaf should stop surviving close (e.g. an explicit "kill pane" action).
export function unmarkPaneDetachable(leafId: number): void {
  unmarkRmuxLeaf(leafId);
}
