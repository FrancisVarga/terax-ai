import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell — which fires between commands — should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
  // True once any OSC 133 marker has been seen on this terminal. Lets the OSC 7
  // cwd handler know shell integration is live, so it can defer the
  // "session ready to type" signal to OSC 133;B instead of firing it early
  // (OSC 7 is emitted *before* the prompt finishes — see profile.ps1).
  sawPrompt: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false, sawPrompt: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  // Fired on OSC 133;B — the prompt has finished drawing and the shell is now
  // draining stdin. This is the only safe moment to programmatically type a
  // command: gating on OSC 7 (cwd) instead races shell startup and drops the
  // leading character (e.g. `claude` → `laude`). See profile.ps1 prompt order.
  onPromptInputReady?: () => void,
): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    // Any 133 marker means shell integration is live; the cwd handler uses this
    // to stop treating OSC 7 as the readiness signal.
    if (state) state.sawPrompt = true;
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
      onPromptInputReady?.();
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

/**
 * App-private OSC 7704 — remote (SSH) cwd. Payload: `<nonce>;<percent-encoded
 * abs path>`. Unlike OSC 7 this is NOT gated by the in-command guard: an
 * interactive ssh session is one long-running local command, so its remote
 * shell hook always fires "in command". The per-leaf nonce (verified by the
 * caller) replaces the in-command guard as the trust check — only output from
 * the hook we injected, carrying the matching nonce, is honored. See
 * remote-cwd.ts.
 */
export function registerRemoteCwdHandler(
  term: Terminal,
  onPayload: (nonce: string, encodedPath: string) => void,
): () => void {
  const d = term.parser.registerOscHandler(7704, (data) => {
    const sep = data.indexOf(";");
    if (sep === -1) return true;
    const nonce = data.slice(0, sep);
    const encodedPath = data.slice(sep + 1);
    if (nonce && encodedPath) onPayload(nonce, encodedPath);
    return true;
  });
  return () => d.dispose();
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}
