//! External formatter sidecars.
//!
//! Some languages have no in-browser (WASM/Prettier) formatter but ship a
//! native CLI that reads source on stdin and writes the formatted result to
//! stdout. This module shells out to such a CLI when it is present on the
//! user's `PATH`, mirroring the "discover + cache availability + degrade
//! gracefully when absent" model used by the git integration
//! (`modules::git::process`).
//!
//! v1 covers Nix. The frontend calls `format_nix`; if no formatter is
//! installed the command returns `Ok(None)` and the editor falls back to
//! CodeMirror's reindent — the same behavior `.nix` had before this existed.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use shared_child::SharedChild;

use crate::modules::proc::hide_console;

/// Hard cap on a single format invocation. A formatter that hangs must not wedge
/// the editor's "Format Document" action.
const FORMAT_TIMEOUT_SECS: u64 = 15;

/// Reject pathologically large buffers before spawning — the editor already
/// gates huge files, this is a defensive backstop (8 MiB of source).
const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;

/// Cap captured stdout/stderr so a misbehaving formatter can't balloon memory.
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// Candidate Nix formatters in preference order. Each reads stdin and writes the
/// formatted document to stdout (all three support this with no arguments).
/// `nixfmt` is the de-facto nixpkgs standard, `alejandra` is the popular
/// opinionated alternative, `nixpkgs-fmt` is the older fallback.
const NIX_FORMATTERS: &[&str] = &["nixfmt", "alejandra", "nixpkgs-fmt"];

/// Availability is resolved once per formatter family and cached briefly so a
/// repeated "Format Document" doesn't re-probe `PATH` on every keystroke-driven
/// save. `None` once resolved = "no formatter installed".
struct Resolved {
    program: Option<String>,
    at: Instant,
}

const AVAILABILITY_TTL: Duration = Duration::from_secs(60);

static NIX_RESOLVED: OnceLock<Mutex<Option<Resolved>>> = OnceLock::new();

fn nix_cell() -> &'static Mutex<Option<Resolved>> {
    NIX_RESOLVED.get_or_init(|| Mutex::new(None))
}

/// Return the first formatter from `candidates` that responds to `--version`,
/// or `None` if none are on `PATH`.
fn discover(candidates: &[&str]) -> Option<String> {
    for &program in candidates {
        let mut cmd = Command::new(program);
        cmd.arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut cmd);
        // A clean spawn+exit (any exit code) means the binary exists and runs.
        // We only care that it is invokable, not the version string.
        if let Ok(mut child) = cmd.spawn() {
            let _ = child.wait();
            return Some(program.to_string());
        }
    }
    None
}

/// Resolve (and cache) the Nix formatter program name. Re-probes after the TTL
/// so installing a formatter mid-session is picked up without a restart.
fn resolve_nix_formatter() -> Option<String> {
    let mut guard = nix_cell().lock().ok()?;
    if let Some(r) = guard.as_ref() {
        if r.at.elapsed() < AVAILABILITY_TTL {
            return r.program.clone();
        }
    }
    let program = discover(NIX_FORMATTERS);
    *guard = Some(Resolved {
        program: program.clone(),
        at: Instant::now(),
    });
    program
}

/// Run `program` with `source` piped to stdin, returning formatted stdout.
///
/// Errors:
///   - `Err(msg)` when the formatter exits non-zero (e.g. a syntax error) or
///     times out — the message carries stderr so the editor can surface it.
fn run_formatter(program: &str, source: &str) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let child = Arc::new(
        SharedChild::spawn(&mut cmd).map_err(|e| format!("failed to start {program}: {e}"))?,
    );

    // Write the whole buffer to the child's stdin on a thread, then drop it to
    // signal EOF. A formatter that produces output larger than its input pipe
    // buffer would deadlock if we wrote stdin and read stdout on one thread.
    let mut stdin = child
        .take_stdin()
        .ok_or_else(|| format!("{program}: no stdin pipe"))?;
    let source_bytes = source.as_bytes().to_vec();
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&source_bytes);
        // stdin dropped here → EOF to the child.
    });

    let mut stdout_pipe = child
        .take_stdout()
        .ok_or_else(|| format!("{program}: no stdout pipe"))?;
    let mut stderr_pipe = child
        .take_stderr()
        .ok_or_else(|| format!("{program}: no stderr pipe"))?;
    let out_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let err_handle = thread::spawn(move || drain(&mut stderr_pipe));

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let dur = Duration::from_secs(FORMAT_TIMEOUT_SECS);
    let (exit_code, timed_out) = match rx.recv_timeout(dur) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(format!("{program}: {e}")),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(format!("{program}: wait thread disconnected"));
        }
    };

    let _ = writer.join();
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    if timed_out {
        return Err(format!("{program} timed out after {FORMAT_TIMEOUT_SECS}s"));
    }
    if exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        let detail = if detail.is_empty() {
            format!("{program} exited with {exit_code:?}")
        } else {
            detail
        };
        return Err(detail);
    }

    String::from_utf8(stdout).map_err(|_| format!("{program}: produced non-UTF-8 output"))
}

fn drain<R: std::io::Read>(reader: &mut R) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 * 1024);
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() < MAX_OUTPUT_BYTES {
                    let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                    out.extend_from_slice(&buf[..take]);
                }
            }
            Err(_) => break,
        }
    }
    out
}

/// Format a Nix source buffer with the first available native formatter.
///
/// Returns:
///   - `Ok(Some(formatted))` — a formatter ran and succeeded.
///   - `Ok(None)`            — no Nix formatter is installed; caller reindents.
///   - `Err(message)`        — a formatter ran but failed (syntax error, etc.);
///                             caller surfaces the message and leaves the buffer.
#[tauri::command]
pub fn format_nix(source: String) -> Result<Option<String>, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err("document too large for the Nix formatter".into());
    }
    let Some(program) = resolve_nix_formatter() else {
        return Ok(None);
    };
    run_formatter(&program, &source).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discover_returns_none_for_absent_binaries() {
        assert_eq!(
            discover(&["definitely-not-a-real-formatter-xyz123"]),
            None
        );
    }

    #[test]
    fn rejects_oversized_source() {
        let big = "a".repeat(MAX_SOURCE_BYTES + 1);
        let err = format_nix(big).unwrap_err();
        assert!(err.contains("too large"));
    }
}
