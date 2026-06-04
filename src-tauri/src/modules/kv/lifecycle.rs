//! App-side lifecycle for the embedded KV server (issue #97).
//!
//! Supervises the `kv-server` sidecar (packaged) or runs the serve loop
//! in-process (dev, no sidecar staged). Mirrors `modules/bunqueue`: opt-in pref,
//! ring-buffer log capture, watchdog with crash-loop backoff, status/restart
//! commands. Spawn + Job Object follow `modules/otel` + `modules/pty/job`.
//!
//! Resolution, sidecar-first:
//!   1. PACKAGED: spawn `kv-server --port <p> --data-dir <d> [--requirepass <p>]`
//!      next to the app exe (the Tauri `externalBin`).
//!   2. DEV FALLBACK: no sidecar staged -> run `core::server::bind_and_serve` on
//!      the Tauri runtime. Same store/codec/dispatch, no child process.
//!
//! Loopback only (127.0.0.1). Opt-in: stays down until the `kvEnabled` pref is
//! read at boot or the Settings toggle flips it on.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use shared_child::SharedChild;
use tauri::Manager;

use super::core::server::{Broadcaster, ServerCtx};
use super::core::store::Store;
use crate::modules::shell::ringbuffer::BoundedRingBuffer;
use crate::modules::sync::MutexExt;

/// Default Redis port. Dev builds use a +1 offset so a `tauri dev` instance and
/// an installed release do not fight over 6379 (bunqueue uses the same trick).
pub const DEFAULT_PORT: u16 = if cfg!(debug_assertions) { 6380 } else { 6379 };

const RING_CAP: usize = 256 * 1024;
const SIDECAR_BASE: &str = "kv-server";

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
const WATCHDOG_MAX_INTERVAL: Duration = Duration::from_secs(60);
const CRASH_LOOP_MIN_UPTIME_MS: u64 = 5_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A running sidecar child process plus captured output. `None` child means the
/// server is running in-process (dev fallback) rather than as a child.
struct ManagedProc {
    command: String,
    port: u16,
    started_at_ms: u64,
    child: Option<Arc<SharedChild>>,
    buffer: Mutex<BoundedRingBuffer>,
    exited: AtomicBool,
    exit_code: AtomicI32,
}

impl ManagedProc {
    fn kill(&self) {
        if let Some(c) = &self.child {
            let _ = c.kill();
        }
    }
}

impl Drop for ManagedProc {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Tauri-managed state for the KV server.
pub struct KvState {
    proc: Mutex<Option<Arc<ManagedProc>>>,
    /// In-process server context (dev fallback). Held so the data CRUD commands
    /// can reach the store directly when there is no sidecar. `None` in packaged
    /// mode (data lives in the child; the UI reaches it over loopback).
    inproc: Mutex<Option<Arc<ServerCtx>>>,
    enabled: AtomicBool,
    port: AtomicU16,
    data_dir: Mutex<Option<PathBuf>>,
    requirepass: Mutex<Option<String>>,
}

impl Default for KvState {
    fn default() -> Self {
        KvState {
            proc: Mutex::new(None),
            inproc: Mutex::new(None),
            enabled: AtomicBool::new(false),
            port: AtomicU16::new(DEFAULT_PORT),
            data_dir: Mutex::new(None),
            requirepass: Mutex::new(None),
        }
    }
}

impl KvState {
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Acquire)
    }
    pub fn requirepass(&self) -> Option<String> {
        self.requirepass.lock_safe().clone()
    }
    fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir.lock_safe().clone()
    }
}

#[derive(Serialize)]
pub struct KvStatus {
    pub running: bool,
    pub command: Option<String>,
    pub port: u16,
    /// Connection URL clients use (`redis://127.0.0.1:<port>`).
    pub url: String,
    pub data_path: Option<String>,
    /// True when running as a sidecar child; false when in-process (dev).
    pub sidecar: bool,
    pub auth: bool,
    pub started_at_ms: Option<u64>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct KvLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
}

/// Locate the sidecar next to the app exe (Tauri strips the triple suffix).
fn find_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        format!("{SIDECAR_BASE}.exe")
    } else {
        SIDECAR_BASE.to_string()
    };
    let candidate = dir.join(name);
    candidate.is_file().then_some(candidate)
}

/// Set config before boot. `port` 0 keeps the current/default.
pub fn set_config(state: &KvState, port: Option<u16>, data_dir: Option<PathBuf>, requirepass: Option<String>) {
    if let Some(p) = port {
        if p != 0 {
            state.port.store(p, Ordering::Release);
        }
    }
    if let Some(ref d) = data_dir {
        if let Some(parent) = d.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    *state.data_dir.lock_safe() = data_dir;
    *state.requirepass.lock_safe() = requirepass;
}

fn server_running(state: &KvState) -> bool {
    state
        .proc
        .lock_safe()
        .as_ref()
        .map(|p| !p.exited.load(Ordering::Acquire))
        .unwrap_or(false)
}

/// Spawn the sidecar child, wiring stdout/stderr into the ring buffer and
/// tracking exit on a background thread. On Windows the child is assigned to a
/// Job Object so it dies with Terax.
fn spawn_sidecar(state: &KvState, exe: &PathBuf) -> Result<Arc<ManagedProc>, String> {
    let port = state.port();
    let mut cmd = Command::new(exe);
    cmd.arg("--port").arg(port.to_string());
    let mut display = format!("{} --port {port}", exe.display());
    if let Some(d) = state.data_dir() {
        cmd.arg("--data-dir").arg(&d);
        display.push_str(&format!(" --data-dir {}", d.display()));
    }
    if let Some(pass) = state.requirepass() {
        cmd.arg("--requirepass").arg(&pass);
        display.push_str(" --requirepass ***");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(
        SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn {}: {e}", exe.display()))?,
    );

    // Windows: tie the child's lifetime to Terax via a Job Object so a Terax
    // crash kills the sidecar (no orphan kv-server.exe).
    #[cfg(windows)]
    {
        if let Ok(job) = crate::modules::pty::job::PtyJob::create_for(child.id()) {
            // Leak the job handle for the process lifetime: dropping it would
            // kill the child immediately. It is reclaimed by the OS on exit.
            std::mem::forget(job);
        }
    }

    let proc = Arc::new(ManagedProc {
        command: display,
        port,
        started_at_ms: now_ms(),
        child: Some(child.clone()),
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
    });

    if let Some(out) = child.take_stdout() {
        spawn_pipe_reader(proc.clone(), out);
    }
    if let Some(err) = child.take_stderr() {
        spawn_pipe_reader(proc.clone(), err);
    }

    {
        let proc_ref = proc.clone();
        let wait_child = child.clone();
        thread::spawn(move || {
            let code = wait_child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            proc_ref.exit_code.store(code, Ordering::Release);
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}

/// Start the in-process server (dev fallback) on the Tauri runtime. Returns a
/// `ManagedProc` with no child plus the shared `ServerCtx` (stored so the data
/// CRUD commands can reach the store directly).
fn start_in_process(state: &KvState) -> Result<(Arc<ManagedProc>, Arc<ServerCtx>), String> {
    let port = state.port();
    let store = Arc::new(Store::new());
    let ctx = Arc::new(ServerCtx {
        store,
        broadcaster: Arc::new(Broadcaster::new()),
        requirepass: state.requirepass(),
    });
    let serve_ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::core::server::bind_and_serve(port, serve_ctx).await {
            log::warn!("kv in-process server stopped: {e}");
        }
    });
    let proc = Arc::new(ManagedProc {
        command: format!("(in-process) port {port}"),
        port,
        started_at_ms: now_ms(),
        child: None,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
    });
    Ok((proc, ctx))
}

fn spawn_pipe_reader<R: std::io::Read + Send + 'static>(proc: Arc<ManagedProc>, mut pipe: R) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => proc.buffer.lock_safe().push(&buf[..n]),
                Err(_) => break,
            }
        }
    });
}

/// Idempotent start: bring the server up if down (sidecar-first, dev fallback).
pub fn start_on_boot(state: &KvState) {
    let mut guard = state.proc.lock_safe();
    if guard.as_ref().map(|p| !p.exited.load(Ordering::Acquire)).unwrap_or(false) {
        return;
    }
    match find_sidecar() {
        Some(exe) => match spawn_sidecar(state, &exe) {
            Ok(proc) => {
                log::info!("kv-server sidecar started (redis://127.0.0.1:{})", proc.port);
                *guard = Some(proc);
                *state.inproc.lock_safe() = None;
            }
            Err(e) => log::warn!("kv-server sidecar did not start: {e}"),
        },
        None => match start_in_process(state) {
            Ok((proc, ctx)) => {
                log::info!("kv in-process server started (redis://127.0.0.1:{})", proc.port);
                *guard = Some(proc);
                *state.inproc.lock_safe() = Some(ctx);
            }
            Err(e) => log::warn!("kv in-process server did not start: {e}"),
        },
    }
}

fn shutdown(state: &KvState) {
    if let Some(proc) = state.proc.lock_safe().take() {
        proc.kill();
    }
    *state.inproc.lock_safe() = None;
}

fn ensure_running(state: &KvState) -> bool {
    if !state.enabled.load(Ordering::Acquire) {
        return false;
    }
    if !server_running(state) {
        start_on_boot(state);
    }
    server_running(state)
}

/// Read the persisted `kvEnabled` pref, defaulting to false (opt-in).
fn read_enabled_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri_plugin_store::StoreExt;
    match app.store("terax-settings.json") {
        Ok(store) => store.get("kvEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Apply the persisted pref at boot, then start if enabled.
pub fn init_from_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &KvState) {
    let enabled = read_enabled_pref(app);
    state.enabled.store(enabled, Ordering::Release);
    if enabled {
        start_on_boot(state);
    } else {
        log::info!("kv server disabled (opt-in) - not started on boot");
    }
}

fn server_stably_running(state: &KvState) -> bool {
    let guard = state.proc.lock_safe();
    let Some(proc) = guard.as_ref() else {
        return false;
    };
    if proc.exited.load(Ordering::Acquire) {
        return now_ms().saturating_sub(proc.started_at_ms) >= CRASH_LOOP_MIN_UPTIME_MS;
    }
    true
}

/// Background watchdog: restarts the server if it dies, gated on `enabled`.
pub fn start_watchdog(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut backoff = WATCHDOG_INTERVAL;
        loop {
            thread::sleep(backoff);
            let state = app.state::<KvState>();
            ensure_running(&state);
            backoff = if server_stably_running(&state) {
                WATCHDOG_INTERVAL
            } else {
                (backoff * 2).min(WATCHDOG_MAX_INTERVAL)
            };
        }
    });
}

fn status_of(proc: &ManagedProc, auth: bool) -> KvStatus {
    let exited = proc.exited.load(Ordering::Acquire);
    KvStatus {
        running: !exited,
        command: Some(proc.command.clone()),
        port: proc.port,
        url: format!("redis://127.0.0.1:{}", proc.port),
        data_path: None,
        sidecar: proc.child.is_some(),
        auth,
        started_at_ms: Some(proc.started_at_ms),
        exited,
        exit_code: if exited {
            Some(proc.exit_code.load(Ordering::Acquire))
        } else {
            None
        },
    }
}

// ---- Tauri commands ----

#[tauri::command]
pub fn kv_status(state: tauri::State<'_, KvState>) -> KvStatus {
    let auth = state.requirepass().is_some();
    let guard = state.proc.lock_safe();
    match guard.as_ref() {
        Some(proc) => {
            let mut s = status_of(proc, auth);
            s.data_path = state.data_dir().map(|d| d.display().to_string());
            s
        }
        None => KvStatus {
            running: false,
            command: None,
            port: state.port(),
            url: format!("redis://127.0.0.1:{}", state.port()),
            data_path: state.data_dir().map(|d| d.display().to_string()),
            sidecar: false,
            auth,
            started_at_ms: None,
            exited: false,
            exit_code: None,
        },
    }
}

#[tauri::command]
pub fn kv_logs(state: tauri::State<'_, KvState>, since_offset: Option<u64>) -> KvLogResponse {
    let guard = state.proc.lock_safe();
    match guard.as_ref() {
        Some(proc) => {
            let (bytes, next_offset, dropped) =
                proc.buffer.lock_safe().read_from(since_offset.unwrap_or(0));
            KvLogResponse {
                bytes: String::from_utf8_lossy(&bytes).into_owned(),
                next_offset,
                dropped,
                exited: proc.exited.load(Ordering::Acquire),
            }
        }
        None => KvLogResponse {
            bytes: String::new(),
            next_offset: 0,
            dropped: 0,
            exited: false,
        },
    }
}

#[tauri::command]
pub fn kv_ensure(state: tauri::State<'_, KvState>) -> KvStatus {
    ensure_running(&state);
    kv_status(state)
}

#[tauri::command]
pub fn kv_set_enabled(state: tauri::State<'_, KvState>, enabled: bool) -> KvStatus {
    state.enabled.store(enabled, Ordering::Release);
    if enabled {
        ensure_running(&state);
    } else {
        shutdown(&state);
    }
    kv_status(state)
}

#[tauri::command]
pub fn kv_restart(state: tauri::State<'_, KvState>) -> KvStatus {
    shutdown(&state);
    if state.enabled.load(Ordering::Acquire) {
        start_on_boot(&state);
    }
    kv_status(state)
}

/// Change the listen port and restart if running. Rejects an out-of-range port.
#[tauri::command]
pub fn kv_set_port(state: tauri::State<'_, KvState>, port: u16) -> Result<KvStatus, String> {
    if port < 1024 {
        return Err("port must be >= 1024".into());
    }
    state.port.store(port, Ordering::Release);
    if state.enabled.load(Ordering::Acquire) {
        shutdown(&state);
        start_on_boot(&state);
    }
    Ok(kv_status(state))
}

/// Explicit shutdown hook for `ExitRequested`. The sidecar snapshots on its own
/// SIGTERM/Ctrl-C path; killing the child triggers that.
pub fn on_exit(state: &KvState) {
    shutdown(state);
}
