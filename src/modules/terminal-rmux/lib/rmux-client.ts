import {
  markRmuxLeaf,
  reattachSession,
  unmarkRmuxLeaf,
} from "@/modules/terminal";

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

// TODO(#132): the rmux daemon exposes session grouping over HTTP
// (POST /session/new, POST /session/{id}/window/new, POST /window/{id}/split,
// GET /session/list, POST /session/{id}/kill), but terax does NOT yet register
// Tauri commands that proxy them. The SessionSwitcher needs those commands to
// list/create/kill sessions. Until they exist, this client can only drive the
// flows backed by the two commands that ARE registered today: pty_detach (via
// the terminal session's close path) and pty_attach_existing (via
// reattachSession). When the session.* commands land, add typed wrappers here:
//   export async function listSessions(): Promise<Session[]> {
//     return invoke<Session[]>("rmux_session_list");
//   }
// and similar for new/window/split/kill.

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
