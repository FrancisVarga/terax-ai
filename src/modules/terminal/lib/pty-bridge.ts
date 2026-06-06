import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

// How a session's close() tears down the backend pane:
// - "kill": pty_close, the shell dies (the only behavior pre-rmux).
// - "detach": pty_detach, the daemon keeps the shell running and returns its
//   pane id so it can be reattached later. Only meaningful for daemon-backed
//   panes; pty_detach falls through to a kill for in-process panes.
export type CloseMode = "kill" | "detach";

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  closeMode: CloseMode = "kill",
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    onData,
    onExit,
  });

  return buildSession(id, closeMode, releaseHandlers);
}

// Reattach to an EXISTING daemon pane previously detached via pty_detach (or
// surfaced by the session switcher). The backend replays the pane's ring on
// connect, then streams live output. Wiring is identical to openPty so the
// returned PtySession is indistinguishable from a freshly opened one; close()
// always detaches (never kills) because a reattached pane is meant to outlive
// the local view.
export async function attachExistingPty(
  daemonPaneId: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_attach_existing", {
    daemonPaneId,
    onData,
    onExit,
  });

  return buildSession(id, "detach", releaseHandlers);
}

// Resolve the daemon pane id a local pty id forwards to. Returns null for an
// in-process pty (no daemon mapping) or one whose mapping is gone. Used once per
// rmux leaf to surface the daemon pane id in its titlebar — never on a hot path.
export async function rmuxPaneOf(localPtyId: number): Promise<number | null> {
  const paneId = await invoke<number | null>("rmux_pane_of", { id: localPtyId });
  return paneId ?? null;
}

function buildSession(
  id: number,
  closeMode: CloseMode,
  releaseHandlers: () => void,
): PtySession {
  let closed = false;
  return {
    id,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke(closeMode === "detach" ? "pty_detach" : "pty_close", {
          id,
        });
      } finally {
        releaseHandlers();
      }
    },
  };
}
