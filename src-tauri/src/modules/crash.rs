//! Process-wide crash capture for the Rust side.
//!
//! The release profile builds with `panic = "abort"` (see Cargo.toml), so a
//! panic in *any* thread — the main thread, a tokio worker, a PTY reader, the
//! bunqueue watchdog — terminates the process immediately with no unwind and no
//! message anywhere. Installed users just saw the window vanish.
//!
//! `std::panic::set_hook` still fires *before* the abort, so we install a hook
//! that synchronously writes the panic location, payload, thread name, and a
//! backtrace to a `crash.log` in the OS log directory before the process dies.
//! The write is plain `std::fs` (not the `log` crate) on purpose: the log
//! plugin's async file writer may not flush before `abort()` truncates us, but
//! a direct synchronous write inside the hook is guaranteed to hit disk.
//!
//! The hook must be installed before `tauri::Builder` runs so panics during
//! startup (plugin init, the `setup` closure, spawned threads) are covered.
//! Because there is no `AppHandle` yet, the log dir is resolved independently
//! via `dirs`, matching where `tauri-plugin-log`'s `LogDir` target writes.

use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::panic;
use std::path::PathBuf;

/// Bundle identifier from tauri.conf.json. Tauri derives the per-app data/log
/// dir from this, so we mirror it to land `crash.log` beside the plugin logs.
const IDENTIFIER: &str = "app.crynta.terax";

/// Resolve the same directory `tauri-plugin-log`'s `LogDir` target writes to,
/// without an `AppHandle` (the hook installs before the app is built).
///
/// - Windows: `%LOCALAPPDATA%\{identifier}\logs`
/// - macOS:   `~/Library/Logs/{identifier}`
/// - Linux:   `{XDG_DATA_HOME or ~/.local/share}/{identifier}/logs`
fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(IDENTIFIER))
    }
    #[cfg(target_os = "windows")]
    {
        // app_log_dir() => local_data_dir()/{identifier}/logs on Windows.
        dirs::data_local_dir().map(|d| d.join(IDENTIFIER).join("logs"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::data_dir().map(|d| d.join(IDENTIFIER).join("logs"))
    }
}

/// Coerce the panic payload into a string. The payload is `&str` for
/// `panic!("literal")` and `String` for `panic!("{}", x)`; anything else falls
/// back to a placeholder.
fn payload_str(info: &panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Install the panic hook. Idempotent in effect — call once, early, from `run`.
///
/// Sets `RUST_BACKTRACE=1` (unless the user already set it) so the captured
/// backtrace is populated; without it `Backtrace::force_capture` still works,
/// but honoring the env keeps behavior predictable for power users who set it
/// to `full`.
pub fn install_hook() {
    if std::env::var_os("RUST_BACKTRACE").is_none() {
        // SAFETY: set before any worker threads are spawned (called at the top
        // of `run`, before `tauri::Builder`). No concurrent env access yet.
        std::env::set_var("RUST_BACKTRACE", "1");
    }

    // Preserve the default hook so panics still print to stderr in dev.
    let default_hook = panic::take_hook();

    panic::set_hook(Box::new(move |info| {
        let payload = payload_str(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let backtrace = Backtrace::force_capture();

        // Best-effort durable write. Never panic inside the hook (would abort
        // before we finish) — every step is fallible and swallowed.
        if let Some(dir) = log_dir() {
            let _ = fs::create_dir_all(&dir);
            let path = dir.join("crash.log");
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(
                    file,
                    "==== PANIC ====\nthread: {thread}\nlocation: {location}\nmessage: {payload}\nbacktrace:\n{backtrace}\n"
                );
                let _ = file.flush();
            }
        }

        // Also route through the log plugin so it lands in the rotating app log
        // when the writer is alive (dev / non-abort panics).
        log::error!(
            target: "panic",
            "thread '{thread}' panicked at {location}: {payload}\n{backtrace}"
        );

        // Chain the default hook (stderr print) for dev visibility.
        default_hook(info);
    }));
}
