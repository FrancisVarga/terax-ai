# rmux-spike (Phase 0, issue #109)

Throwaway spike proving the terminal-rmux daemon architecture before any
production code. Standalone crate, intentionally NOT a member of the src-tauri
workspace (a member would share the lockfile and trip the build.rs externalBin
assertion).

## Binaries

- `rmux-spike-daemon <rendezvous>` — opens one pty shell, owns it via its own
  Windows Job Object (KILL_ON_JOB_CLOSE), fans output bytes to loopback TCP
  clients. Writes `{daemon_pid}\n{port}\n{shell_pid}` to the rendezvous file.
- `rmux-spike-spawner <daemon-exe> <rendezvous>` — launches the daemon DETACHED
  then exits, modeling Terax starting the daemon. Tries
  CREATE_BREAKAWAY_FROM_JOB, falls back to plain detached spawn on
  ERROR_ACCESS_DENIED (parent job forbids breakaway).
- `rmux-spike-bench [lines]` — connect-first then flood; measures Transport A
  (loopback) first-byte + drain latency.

## Findings (Windows 11, 2026-06-04)

- SURVIVAL: spawner exits, daemon + shell stay alive. PROVEN.
- REAPING: kill daemon -> shell gone within <100ms via Job Object. No orphan.
- BREAKAWAY: CREATE_BREAKAWAY_FROM_JOB denied (os error 5) under the dev job;
  plain DETACHED_PROCESS spawn survives anyway. The production launcher must do
  this try/fallback.
- TRANSPORT A latency: loopback first-byte ~4ms; throughput is shell-generation
  bound (pwsh), not transport bound. Loopback HTTP+SSE is fast enough for v1.

Decision: Transport A (loopback HTTP+SSE). Daemon spawn = detached with
breakaway-or-fallback.
