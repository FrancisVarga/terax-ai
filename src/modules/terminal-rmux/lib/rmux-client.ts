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
