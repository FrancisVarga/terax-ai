mod agent_detect;
mod da_filter;
// `pub(crate)` so the kv lifecycle (modules/kv) can reuse the Job Object to tie
// the kv-server sidecar's lifetime to Terax (kill-on-job-close).
#[cfg(windows)]
pub(crate) mod job;
mod session;
pub(crate) mod shell_init;
mod sink;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::sync::{MutexExt, RwLockExt};
use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

/// Raise the Windows multimedia timer resolution to 1ms for the process
/// lifetime. Without this the default ~15.6ms timer granularity rounds the
/// flusher's `thread::sleep(FLUSH_COALESCE)` (4ms) up to a full tick, adding
/// up to ~15ms of latency to coalesced output. Process-global; never paired
/// with `timeEndPeriod` because we want it for the whole run.
pub fn raise_timer_resolution() {
    #[cfg(windows)]
    {
        // SAFETY: timeBeginPeriod takes a millisecond value and has no
        // memory-safety contract; 1 is the minimum supported period.
        unsafe {
            windows_sys::Win32::Media::timeBeginPeriod(1);
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_user_spawn_cwd(&registry, cwd.as_deref(), &workspace).map_err(|e| {
        log::warn!("pty_open: cwd rejected: {e}");
        e
    })?;
    // On Android the process launches at `/`, which the app sandbox cannot
    // read — a shell started there fails every `ls` with `os error 13`. When no
    // explicit cwd was requested, fall back to the app's private data dir (the
    // only reliably writable location; resolved via Tauri's path API, since
    // Android sets neither `$HOME` nor `$TMPDIR` for the app process).
    // On Android the process launches at `/`, which the app sandbox cannot read
    // — a shell started there fails every `ls` with `os error 13`. The frontend
    // may also pass `/` (or another unwritable path) as the requested cwd, so we
    // can't just fill in a default when `cwd` is None: we must *override* any cwd
    // the app can't actually write to with the app's private data dir (the only
    // reliably writable location; Android sets neither `$HOME` nor `$TMPDIR`, so
    // Tauri's path API is the only source).
    #[cfg(target_os = "android")]
    let cwd = {
        use tauri::Manager;
        let writable = |s: &str| -> bool {
            let probe = std::path::Path::new(s).join(".terax-cwd-probe");
            std::fs::write(&probe, b"").map(|_| std::fs::remove_file(&probe).ok()).is_ok()
        };
        if cwd.as_deref().is_some_and(writable) {
            cwd
        } else {
            let p = app.path();
            let candidates = [
                ("app_data_dir", p.app_data_dir()),
                ("app_cache_dir", p.app_cache_dir()),
                ("app_local_data_dir", p.app_local_data_dir()),
            ];
            let mut resolved = None;
            for (name, res) in candidates {
                match res {
                    Ok(dir) => match std::fs::create_dir_all(&dir) {
                        Ok(()) => {
                            log::info!("pty_open: android cwd from {name}: {}", dir.display());
                            resolved = Some(dir.to_string_lossy().into_owned());
                            break;
                        }
                        Err(e) => {
                            log::warn!("pty_open: {name} {} not creatable: {e}", dir.display())
                        }
                    },
                    Err(e) => log::warn!("pty_open: {name} unavailable: {e}"),
                }
            }
            if resolved.is_none() {
                log::warn!("pty_open: no writable android dir resolved; PTY will use process cwd");
            }
            resolved
        }
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let sink: Arc<dyn sink::PtyOutputSink> =
        Arc::new(sink::TauriChannelSink::new(app, on_data, on_exit));
    let session = tauri::async_runtime::spawn_blocking(move || {
        session::spawn(id, cols, rows, cwd, workspace, sink).map(|(s, _)| s)
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write_safe().insert(id, session);
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .read_safe()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock_safe()
        .write_all(data.as_bytes())
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read_safe()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock_safe()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write_safe().remove(&id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock_safe().kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Detached: on Windows `ClosePseudoConsole` can block until conhost
        // drains, which would freeze this Tauri worker thread and stall IPC.
        // Keep a clone for the synchronous fallback so a failed spawn never
        // skips teardown (and never aborts the app, which `.expect()` would).
        let s_fallback = Arc::clone(&s);
        let spawn = thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                session::drop_session(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            });
        match spawn {
            // Spawn owns the only live teardown path now; drop our extra Arc.
            Ok(_) => drop(s_fallback),
            Err(e) => {
                // OS refused a thread (resource exhaustion): tear down inline
                // rather than aborting. May briefly block this worker, which is
                // strictly better than a crash.
                log::warn!("pty_close: drop-thread spawn failed for id={id}: {e}; dropping inline");
                session::drop_session(s_fallback);
            }
        }
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write_safe();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, s) in drained {
        if let Err(e) = s.killer.lock_safe().kill() {
            log::debug!("pty_close_all: kill id={id} returned {e}");
        }
        let s_fallback = Arc::clone(&s);
        let spawn = thread::Builder::new()
            .name(format!("terax-pty-drop-{id}"))
            .spawn(move || session::drop_session(s));
        match spawn {
            Ok(_) => drop(s_fallback),
            Err(e) => {
                log::warn!(
                    "pty_close_all: drop-thread spawn failed for id={id}: {e}; dropping inline"
                );
                session::drop_session(s_fallback);
            }
        }
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}
