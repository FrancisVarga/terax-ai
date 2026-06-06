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
  /**
   * Set true the first time a valid OSC 7704 payload (matching this leaf's
   * nonce) is seen — i.e. the injected hook actually reached the remote shell,
   * installed, and echoed back. The injector polls this to stop re-typing the
   * hook: the install is racy (the first attempt can land in the *local* shell
   * before ssh has handed off stdin), so we retry until this acks. Defaults to
   * false; never reset for the life of the binding.
   */
  acked?: boolean;
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
 * Mark a binding as acked — called from the OSC 7704 handler the first time a
 * nonce-matching payload arrives, proving the injected hook reached the remote
 * shell. The injector's retry loop polls `getRemoteCwdBinding(leafId)?.acked`
 * to stop re-typing. No-op if the leaf has no binding (already unbound).
 */
export function markRemoteCwdAcked(leafId: number): void {
  const b = bindings.get(leafId);
  if (b) b.acked = true;
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
 * hook. Emits two self-guarded statements on one typed line:
 *
 *   1. a POSIX form  (bash / zsh / sh)  guarded by `if command -v od …; then`
 *   2. a fish form   (fish ≥ 3)         guarded by `if set -q FISH_VERSION`
 *
 * Each shell parses only its own statement and errors benignly on the other
 * (the non-matching block lives inside a single-quoted `eval` string, so it is
 * never parsed by the wrong shell — at worst one "unknown command" line). This
 * is best-effort: `su`/`sudo -i`, subshells, nested `ssh`, PowerShell or cmd
 * remotes may not carry the hook — the explorer simply stops following cwd.
 *
 * The hook prints OSC 7704 with the leaf nonce and a percent-encoded `$PWD`.
 * Percent-encoding is done in-shell (od + tr + sed over each byte) so paths
 * with spaces, `%`, or unicode round-trip through decodeURIComponent on the JS
 * side. The hook runs once on install (so the explorer follows immediately) and
 * then on every subsequent prompt — that first echo is also the injector's ack
 * that the hook reached the remote shell (see markRemoteCwdAcked / connectSsh).
 *
 * IMPORTANT: keep the install idempotent. The injector retries this command
 * until the OSC 7704 ack arrives, so it may run 2–3× on the remote; re-defining
 * the functions and the `*__terax_pwd7704*` PROMPT_COMMAND guard make repeats
 * harmless.
 */
export function buildRemoteCwdHookCommand(nonce: string): string {
  // --- POSIX body (bash / zsh / sh). Single logical line. ---
  const posixBody = [
    `__terax_enc(){ od -An -tx1 -v 2>/dev/null | tr -d ' \\n' | sed 's/../%&/g'; }`,
    `__terax_pwd7704(){ printf '\\033]7704;${nonce};%s\\033\\\\' "$(printf %s "$PWD" | __terax_enc)"; }`,
    `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook precmd __terax_pwd7704 2>/dev/null || precmd_functions+=(__terax_pwd7704); else case "$PROMPT_COMMAND" in *__terax_pwd7704*) :;; *) PROMPT_COMMAND="__terax_pwd7704\${PROMPT_COMMAND:+; $PROMPT_COMMAND}";; esac; fi`,
    `__terax_pwd7704`,
  ].join("; ");

  // --- fish body. fish has no POSIX `(){}`/`[ ]`/`case`; uses function…end,
  // `--on-event fish_prompt` for the precmd hook, and `string escape`-free
  // percent-encoding via the same external od|tr|sed pipeline. ---
  const fishBody = [
    `function __terax_enc; od -An -tx1 -v 2>/dev/null | tr -d ' \\n' | sed 's/../%&/g'; end`,
    `function __terax_pwd7704 --on-event fish_prompt; printf '\\033]7704;${nonce};%s\\033\\\\' (printf %s "$PWD" | __terax_enc); end`,
    `__terax_pwd7704`,
  ].join("; ");

  // Each body is wrapped as a single-quoted `eval` argument so the *other*
  // shell never parses the function-definition syntax — it stays inert inside
  // the quoted string and at worst fails at *runtime* (eval can't parse it),
  // which is recoverable, instead of aborting the whole command line at PARSE
  // time. That distinction matters for fish: fish's parser is eager, so a
  // `if … then … fi` POSIX block would parse-abort the entire line and the
  // fish block (second statement) would never run. Using the `&&` form keeps
  // both blocks parseable by both shells:
  //   • POSIX shell: runs the POSIX eval (installs); the fish `… ; end` line
  //     runs `set` (ok) then hits `end` as an unknown command — benign runtime
  //     error, POSIX block already installed.
  //   • fish: `command -v od && eval 'POSIX…'` runs, but eval'ing POSIX
  //     `(){}` fails at runtime (harmless); then `set -q FISH_VERSION && eval
  //     'fish…'` installs the fish hook.
  // `eval` runs in the CURRENT shell so the hook persists (unlike `sh -c`, a
  // throwaway subshell).
  const posixEscaped = posixBody.replace(/'/g, `'\\''`);
  // Inside fish single quotes only \' and \\ are special; escape both.
  const fishEscaped = fishBody.replace(/\\/g, `\\\\`).replace(/'/g, `\\'`);
  const posix = `command -v od >/dev/null 2>&1 && eval '${posixEscaped}'`;
  const fish = `set -q FISH_VERSION && eval '${fishEscaped}'`;
  return `${posix}; ${fish}`;
}
