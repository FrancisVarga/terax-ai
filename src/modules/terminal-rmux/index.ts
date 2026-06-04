// terminal-rmux: the daemon-backed (rmux) variant of the terminal stack. It is
// a THIN wrapper over modules/terminal: it reuses TerminalPane, PaneTreeView,
// panes.ts and the full useTerminalSession machinery unchanged, injecting only
// the close=detach behavior per leaf. No terminal session logic is duplicated.
//
// FLAG GATING (caller's responsibility): RmuxTerminalStack must only be mounted
// when the rmux daemon is enabled (backend env TERAX_RMUX_DAEMON=1). With the
// flag off, pty_open is in-process, so pty_detach falls through to a kill and
// the detach intent is lost. The SessionSwitcher (#132) owns deciding when to
// mount this stack vs the in-process TerminalStack.
export {
  RmuxTerminalStack,
  type RmuxTerminalStackHandle,
} from "./RmuxTerminalStack";
export { SessionSwitcher } from "./SessionSwitcher";
export {
  markPaneDetachable,
  reattachPane,
  unmarkPaneDetachable,
  listSessions,
  newSession,
  renameSession,
  killSession,
  newWindow,
  splitWindow,
  type DaemonPaneId,
  type DaemonSessionId,
  type DaemonWindowId,
  type NewSessionResult,
  type NewWindowResult,
  type Pane,
  type Session,
  type SplitDir,
  type SplitWindowResult,
  type Window,
} from "./lib/rmux-client";
export {
  activeWindow,
  displayName,
  paneCount,
  useSessionsStore,
} from "./lib/sessions";
