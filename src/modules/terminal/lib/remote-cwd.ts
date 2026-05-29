/**
 * Remote (SSH) cwd tracking over an app-private OSC sequence.
 *
 * The local cwd is tracked via OSC 7, but OSC 7 emitted while a command runs is
 * deliberately rejected (untrusted command output — see osc-handlers.ts). An
 * interactive `ssh <alias>` is one long-running local command, so the remote
 * shell's OSC 7 is always dropped, and it carries the remote *hostname*, not the
 * `~/.ssh/config` alias the explorer keys its `ssh://alias/path` roots on.
 *
 * To follow the remote shell's `cd`, we inject a tiny precmd hook over the ssh
 * connection that emits a distinct app-private sequence:
 *
 *     ESC ]7704 ; <nonce> ; <percent-encoded-abs-path> ST
 *
 * - OSC 7704 is app-private, so it is intentionally NOT gated by the in-command
 *   guard (a normal program never emits it).
 * - The <nonce> is a per-leaf random token known only to the hook we injected.
 *   The handler accepts a payload only if the nonce matches the leaf's token.
 *   This blocks generic escape-sequence spoofing (a `cat` of an attacker file
 *   that happens to contain a 7704 sequence) and stale scrollback replay. It is
 *   not a defense against a fully hostile remote host — but browsing such a host
 *   over already-authenticated SFTP is the user's own trust decision.
 */

/** Per-leaf binding: which alias this leaf's remote cwd belongs to + its nonce. */
type Binding = {
  alias: string;
  nonce: string;
  /** Called with an `ssh://alias/abs/path` URI whenever the remote cwd changes. */
  onRemoteCwd: (uri: string) => void;
};

const bindings = new Map<number, Binding>();

/** Crypto-random hex token. Unguessable so injected-hook output is the only
 *  thing that can satisfy the handler's nonce check. */
export function newRemoteCwdNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bindRemoteCwd(leafId: number, binding: Binding): void {
  bindings.set(leafId, binding);
}

export function unbindRemoteCwd(leafId: number): void {
  bindings.delete(leafId);
}

export function getRemoteCwdBinding(leafId: number): Binding | undefined {
  return bindings.get(leafId);
}

/**
 * Validate + normalize a percent-encoded remote path from an OSC 7704 payload.
 * Returns the decoded absolute POSIX path, or null if it is relative, contains
 * control characters, or fails to decode — never trust the payload blindly.
 */
export function decodeRemoteCwd(encoded: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // Must be an absolute POSIX path.
  if (!path.startsWith("/")) return null;
  // Reject control chars (NUL, ESC, newlines, etc.) — a clean cwd never has them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  // Collapse accidental double slashes (but keep the leading one).
  path = path.replace(/\/{2,}/g, "/");
  // Drop a trailing slash except for root.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * The shell snippet typed into the remote ssh session to install the precmd
 * hook. POSIX-shell first (bash/sh), with a zsh `precmd` branch. Best-effort:
 * unknown shells, `su`/`sudo -i`, subshells, and nested `ssh` may not carry the
 * hook — the explorer simply stops following cwd in those cases.
 *
 * The hook prints OSC 7704 with the leaf nonce and a percent-encoded `$PWD`.
 * Percent-encoding is done in-shell (od + sed over each byte) so paths with
 * spaces, `%`, or unicode round-trip through decodeURIComponent on the JS side.
 */
export function buildRemoteCwdHookCommand(nonce: string): string {
  // The hook body. Single logical line of POSIX shell. Uses only POSIX builtins
  // + od/sed/tr in the bash/sh branch; a zsh-specific branch registers a
  // precmd. `__terax_enc` percent-encodes $PWD byte-by-byte so it is locale-
  // and charset-safe.
  const body = [
    `__terax_enc(){ od -An -tx1 -v 2>/dev/null | tr -d ' \\n' | sed 's/../%&/g'; }`,
    `__terax_pwd7704(){ printf '\\033]7704;${nonce};%s\\033\\\\' "$(printf %s "$PWD" | __terax_enc)"; }`,
    `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook precmd __terax_pwd7704 2>/dev/null || precmd_functions+=(__terax_pwd7704); else case "$PROMPT_COMMAND" in *__terax_pwd7704*) :;; *) PROMPT_COMMAND="__terax_pwd7704\${PROMPT_COMMAND:+; $PROMPT_COMMAND}";; esac; fi`,
    `__terax_pwd7704`,
  ].join("; ");

  // Wrap the body as a single-quoted argument to `eval`, gated by a POSIX
  // `command -v` shell check. The point is cross-shell safety: on a POSIX shell
  // (bash/zsh/sh) this evaluates the body in the CURRENT shell (so the precmd
  // hook persists, unlike `sh -c` which would run in a throwaway subshell). On
  // PowerShell / cmd / fish the function-definition syntax `(){}` is never
  // parsed — it lives inside the single-quoted string — so the worst case is a
  // single "command not recognized" line instead of a multi-line ParserError.
  const escaped = body.replace(/'/g, `'\\''`);
  return `command -v od >/dev/null 2>&1 && eval '${escaped}'`;
}
