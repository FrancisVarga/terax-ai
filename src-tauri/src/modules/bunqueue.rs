//! Embedded bunqueue job-queue server lifecycle.
//!
//! bunqueue is a Bun-only job queue (Node is not supported). We run it as a
//! standalone server that Terax spawns on startup so the app — and any AI
//! agents driving it — get a persistent scheduler/queue with an HTTP API.
//!
//! The server exposes an HTTP API and a TCP wire protocol with NO
//! authentication (a bunqueue limitation — the CLI has no auth flag). To keep
//! that surface off the network we:
//!   - bind only to loopback (127.0.0.1, never 0.0.0.0), and
//!   - use non-default ports (see TCP_PORT/HTTP_PORT) so we don't collide with
//!     a standalone bunqueue.
//! SECURITY CAVEAT: loopback is shared by all processes of the local user (and,
//! via DNS-rebinding, a co-resident browser), so this is a per-user trust
//! boundary, not a per-process one. A hostile local process on the same box can
//! drive the queue. Tightening this to a per-launch shared secret or a Unix
//! domain socket / named pipe requires upstream auth support in bunqueue and is
//! tracked as future hardening. See <https://bunqueue.dev/guide/server/>.
//!
//! Runtime strategy: bunqueue is Bun-only, so it always runs in the Bun runtime.
//! We resolve it two ways, sidecar-first:
//!   1. PACKAGED: Tauri ships standalone `bun build --compile` executables as
//!      sidecars next to the app binary (`bunqueue-server`, `bunqueue-worker-*`).
//!      These embed both the Bun runtime and the bundled code, so a packaged
//!      build needs neither `node_modules` nor a system Bun. Built by
//!      `pnpm build:sidecars` and declared in `tauri.conf.json` `externalBin`.
//!   2. DEV FALLBACK: when no sidecar is found next to the exe (running from the
//!      source tree via `tauri dev`), we fall back to invoking the npm CLI entry
//!      `node_modules/bunqueue/dist/cli/index.js` (and the `.ts` worker scripts)
//!      through `bun` resolved from PATH. This keeps the dev loop fast — no
//!      sidecar rebuild needed to iterate on the worker scripts.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use shared_child::SharedChild;
use tauri::Manager;

use crate::modules::shell::ringbuffer::BoundedRingBuffer;
use crate::modules::sync::MutexExt;

/// Ports Terax runs bunqueue on. Deliberately NOT bunqueue's defaults
/// (6789/6790) so the embedded server can't collide with a standalone bunqueue
/// the user may run separately. Passed explicitly via CLI flags on spawn.
///
/// Dev builds use a +100 offset so a `tauri dev` instance and an installed
/// release can run side-by-side without fighting over the same loopback ports
/// (both would otherwise bind 7889/7890 and one's server spawn would fail).
/// `debug_assertions` is the same dev/release discriminator the window title
/// uses in `lib.rs`.
const TCP_PORT: u16 = if cfg!(debug_assertions) { 7989 } else { 7889 };
const HTTP_PORT: u16 = if cfg!(debug_assertions) { 7990 } else { 7890 };

/// Output ring-buffer cap. Server is chatty on boot but steady-state quiet;
/// 1 MiB keeps recent logs without unbounded growth.
const RING_CAP: usize = 1024 * 1024;

/// A running (or exited) Bun child process (the server or a worker) plus its
/// captured output. Ports are only meaningful for the server.
struct ManagedProc {
    command: String,
    tcp_port: Option<u16>,
    http_port: Option<u16>,
    data_path: Option<PathBuf>,
    started_at_ms: u64,
    child: Arc<SharedChild>,
    buffer: Mutex<BoundedRingBuffer>,
    exited: AtomicBool,
    exit_code: AtomicI32,
    exit_unknown: AtomicBool,
}

impl ManagedProc {
    fn kill(&self) {
        let _ = self.child.kill();
    }
}

impl Drop for ManagedProc {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Process-wide handles to the bunqueue server and registered worker processes.
/// `manage`d by Tauri so commands can read status/logs and restart.
pub struct BunqueueState {
    proc: Mutex<Option<Arc<ManagedProc>>>,
    /// Worker name → process. Workers are Bun scripts that connect to the
    /// server over TCP and process a specific queue.
    workers: Mutex<Vec<WorkerEntry>>,
    /// Persistent SQLite path passed to the server via `--data-path`. Set once
    /// during setup from the app data dir. `None` → bunqueue runs in-memory.
    data_path: Mutex<Option<PathBuf>>,
    /// Whether the user has opted the server in. Off by default. Read at boot
    /// from the persisted `bunqueueEnabled` pref and flipped by
    /// `bunqueue_set_enabled`. The watchdog reads this so it never resurrects a
    /// server the user disabled.
    enabled: AtomicBool,
}

impl Default for BunqueueState {
    fn default() -> Self {
        Self {
            proc: Mutex::new(None),
            workers: Mutex::new(Vec::new()),
            data_path: Mutex::new(None),
            // Opt-in: stays down until the pref is read at boot or the toggle
            // flips it on.
            enabled: AtomicBool::new(false),
        }
    }
}

impl BunqueueState {
    fn data_path(&self) -> Option<PathBuf> {
        self.data_path.lock().ok().and_then(|g| g.clone())
    }
}

struct WorkerEntry {
    name: String,
    /// Queue this worker consumes.
    queue: String,
    /// Path (relative to project root) of the worker script, for respawn.
    script_rel: String,
    proc: Arc<ManagedProc>,
}

#[derive(Serialize)]
pub struct BunqueueStatus {
    /// True when a child has been spawned and has not yet exited.
    pub running: bool,
    /// Command line used to launch the server (for diagnostics).
    pub command: Option<String>,
    pub tcp_port: Option<u16>,
    pub http_port: Option<u16>,
    /// HTTP base URL the frontend client can talk to.
    pub http_url: Option<String>,
    /// Persistent SQLite path, or null when running in-memory.
    pub data_path: Option<String>,
    pub started_at_ms: Option<u64>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BunqueueLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Locate a Tauri sidecar executable next to the app binary.
///
/// Tauri installs `externalBin` sidecars alongside the main executable with the
/// target-triple suffix stripped, so `<exe-dir>/<base>(.exe)` is the resolved
/// path in a packaged build. Returns `None` in dev (no sidecars staged there),
/// which triggers the `bun + node_modules` fallback in the callers.
fn find_sidecar(base: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    };
    let candidate = dir.join(name);
    candidate.is_file().then_some(candidate)
}

/// Locate the bunqueue CLI entry shipped in node_modules.
///
/// We walk up from the executable dir and the cwd looking for
/// `node_modules/bunqueue/dist/cli/index.js`. In `tauri dev` the binary lives
/// under `src-tauri/target/debug`, so the project root (with node_modules) is a
/// few levels up; in other layouts the cwd is the project root.
fn find_cli_entry() -> Option<PathBuf> {
    const REL: &str = "node_modules/bunqueue/dist/cli/index.js";

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }

    for root in roots {
        let mut dir: Option<&Path> = Some(root.as_path());
        // Walk up to 8 ancestors — covers target/debug and workspace nesting.
        for _ in 0..8 {
            let Some(d) = dir else { break };
            let candidate = d.join(REL);
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}

/// Build the spawn command: `bun <cli-entry> start --tcp-port … --http-port …
/// [--data-path …]`.
///
/// Returns the configured `Command` and a human-readable command string.
fn build_command(data_path: Option<&Path>) -> Result<(Command, String), String> {
    // Sidecar-first: the packaged standalone exe embeds Bun + bundled code, so
    // it's invoked directly (`<sidecar> start ...`). In dev we fall back to
    // `bun <node_modules cli> start ...`.
    //
    // Ports are passed explicitly (non-default) so we never clash with a
    // standalone bunqueue. The server binds loopback-only; HTTP API + no-auth
    // remain bunqueue defaults (see the module-level SECURITY CAVEAT).
    let tcp = TCP_PORT.to_string();
    let http = HTTP_PORT.to_string();

    let (mut cmd, mut display) = match find_sidecar("bunqueue-server") {
        Some(exe) => {
            let cmd = Command::new(&exe);
            let display = exe.display().to_string();
            (cmd, display)
        }
        None => {
            let entry = find_cli_entry().ok_or(
                "bunqueue not found (no sidecar next to the app binary, and no \
                 node_modules/bunqueue/dist/cli/index.js for dev fallback)",
            )?;
            let mut cmd = Command::new("bun");
            cmd.arg(&entry);
            let display = format!("bun {}", entry.display());
            (cmd, display)
        }
    };

    cmd.arg("start")
        .arg("--tcp-port")
        .arg(&tcp)
        .arg("--http-port")
        .arg(&http);
    display.push_str(&format!(" start --tcp-port {tcp} --http-port {http}"));

    // Persistent SQLite: without --data-path bunqueue runs in-memory and loses
    // all jobs on restart.
    if let Some(dp) = data_path {
        cmd.arg("--data-path").arg(dp);
        display.push_str(&format!(" --data-path {}", dp.display()));
    }

    Ok((cmd, display))
}

/// Spawn a Bun child from a prepared `Command`, wiring stdout/stderr into a
/// ring buffer and tracking exit status on a background thread.
fn spawn_managed(
    mut cmd: Command,
    display: String,
    tcp_port: Option<u16>,
    http_port: Option<u16>,
    data_path: Option<PathBuf>,
) -> Result<Arc<ManagedProc>, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let shared = Arc::new(
        SharedChild::spawn(&mut cmd).map_err(|e| format!("failed to spawn ({display}): {e}"))?,
    );
    let kill_on_fail = || {
        let _ = shared.kill();
    };
    let stdout_pipe = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr_pipe = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;

    let proc = Arc::new(ManagedProc {
        command: display,
        tcp_port,
        http_port,
        data_path,
        started_at_ms: now_ms(),
        child: shared,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
    });

    spawn_pipe_reader(proc.clone(), stdout_pipe);
    spawn_pipe_reader(proc.clone(), stderr_pipe);

    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}

/// Spawn the bunqueue server with explicit non-default ports, HTTP API + no
/// auth, and an optional persistent SQLite path.
fn spawn_server(data_path: Option<PathBuf>) -> Result<Arc<ManagedProc>, String> {
    let (cmd, display) = build_command(data_path.as_deref())?;
    spawn_managed(cmd, display, Some(TCP_PORT), Some(HTTP_PORT), data_path)
}

fn spawn_pipe_reader<R: Read + Send + 'static>(proc: Arc<ManagedProc>, mut pipe: R) {
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

fn resolved_exit_code(proc: &ManagedProc) -> Option<i32> {
    if proc.exited.load(Ordering::Acquire) && !proc.exit_unknown.load(Ordering::Acquire) {
        Some(proc.exit_code.load(Ordering::Acquire))
    } else {
        None
    }
}

/// Workers Terax registers and auto-starts. Tuple is
/// `(name, queue, script_rel, sidecar_base)`:
///   - `script_rel`: dev-fallback path to the `.ts` worker, relative to root.
///   - `sidecar_base`: packaged standalone exe name (no triple, no extension),
///     matching `tauri.conf.json` `externalBin`.
const WORKERS: &[(&str, &str, &str, &str)] = &[
    (
        "github-create-issue",
        "github-create-issue",
        "src/modules/bunqueue/workers/githubCreateIssue.ts",
        "bunqueue-worker-github-create-issue",
    ),
    (
        "http-request",
        "http-request",
        "src/modules/bunqueue/workers/httpRequest.ts",
        "bunqueue-worker-http-request",
    ),
];

/// Locate a worker script by walking up from exe dir / cwd, like the CLI entry.
fn find_worker_script(rel: &str) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut dir: Option<&Path> = Some(root.as_path());
        for _ in 0..8 {
            let Some(d) = dir else { break };
            let candidate = d.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}

/// Spawn one worker, sidecar-first. Packaged: run the standalone `<sidecar>`
/// exe. Dev fallback: `bun <script>`. Either way the server's host/TCP port is
/// passed via env so the worker connects to the embedded server.
fn spawn_worker(script_rel: &str, sidecar_base: &str) -> Result<Arc<ManagedProc>, String> {
    let (mut cmd, display) = match find_sidecar(sidecar_base) {
        Some(exe) => {
            let cmd = Command::new(&exe);
            (cmd, exe.display().to_string())
        }
        None => {
            let script = find_worker_script(script_rel)
                .ok_or_else(|| format!("worker not found (no sidecar '{sidecar_base}', no script {script_rel})"))?;
            let mut cmd = Command::new("bun");
            cmd.arg(&script);
            (cmd, format!("bun {}", script.display()))
        }
    };
    cmd.env("BUNQUEUE_HOST", "127.0.0.1")
        .env("BUNQUEUE_TCP_PORT", TCP_PORT.to_string());
    spawn_managed(cmd, display, None, None, None)
}

/// Start all registered workers. Best-effort; failures are logged.
fn start_workers(state: &BunqueueState) {
    let mut guard = state.workers.lock_safe();
    for (name, queue, script_rel, sidecar_base) in WORKERS {
        let already = guard
            .iter()
            .any(|w| w.name == *name && !w.proc.exited.load(Ordering::Acquire));
        if already {
            continue;
        }
        match spawn_worker(script_rel, sidecar_base) {
            Ok(proc) => {
                log::info!("bunqueue worker '{name}' started (queue '{queue}')");
                guard.retain(|w| w.name != *name);
                guard.push(WorkerEntry {
                    name: (*name).to_string(),
                    queue: (*queue).to_string(),
                    script_rel: (*script_rel).to_string(),
                    proc,
                });
            }
            Err(e) => log::warn!("bunqueue worker '{name}' did not start: {e}"),
        }
    }
}

/// Store the persistent SQLite path and ensure its parent directory exists.
/// Pass `None` to keep bunqueue in-memory. Call before `start_on_boot`.
pub fn set_data_path(state: &BunqueueState, path: Option<PathBuf>) {
    if let Some(ref p) = path {
        if let Some(parent) = p.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("bunqueue data dir create failed ({}): {e}", parent.display());
            }
        }
    }
    if let Ok(mut guard) = state.data_path.lock() {
        *guard = path;
    }
}

/// True when the server child is spawned and not exited.
fn server_running(state: &BunqueueState) -> bool {
    state
        .proc
        .lock_safe()
        .as_ref()
        .map(|p| !p.exited.load(Ordering::Acquire))
        .unwrap_or(false)
}

/// Idempotent supervise step: (re)start the server if down, otherwise ensure
/// all workers are alive. Shared by the `bunqueue_ensure` command and the
/// watchdog thread. Returns true if the server is running afterward.
///
/// No-op while disabled — this is the gate that stops the watchdog from
/// resurrecting a server the user opted out of.
fn ensure_running(state: &BunqueueState) -> bool {
    if !state.enabled.load(Ordering::Acquire) {
        return false;
    }
    if !server_running(state) {
        start_on_boot(state);
    } else {
        // Server up; respawn any worker that died (idempotent — live ones skip).
        start_workers(state);
    }
    server_running(state)
}

/// Idempotent start: spawn the server + workers if not already running. Safe to
/// call repeatedly (e.g. from the frontend on dashboard mount / after reload).
/// No-op while the server is disabled — the frontend gates the dashboard's
/// on-mount ensure on the same pref, but this is the authoritative backstop.
#[tauri::command]
pub fn bunqueue_ensure(state: tauri::State<'_, BunqueueState>) -> BunqueueStatus {
    ensure_running(&state);
    bunqueue_status(state)
}

/// Read the persisted `bunqueueEnabled` pref from the shared settings store.
/// Absent key (fresh install) or any read failure → `false` (opt-in default),
/// matching the JS `DEFAULT_PREFERENCES.bunqueueEnabled`.
fn read_enabled_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri_plugin_store::StoreExt;
    // Same store file the JS LazyStore writes (src: settings/store.ts STORE_PATH).
    match app.store("terax-settings.json") {
        Ok(store) => store
            .get("bunqueueEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Apply the persisted pref at boot, then start if enabled. Call once during
/// setup before the watchdog spawns.
pub fn init_from_pref<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &BunqueueState) {
    let enabled = read_enabled_pref(app);
    state.enabled.store(enabled, Ordering::Release);
    if enabled {
        start_on_boot(state);
    } else {
        log::info!("bunqueue disabled (opt-in) — server not started on boot");
    }
}

/// Enable or disable the server at runtime (driven by the Settings toggle).
/// Enabling spawns the server + workers; disabling kills them. Persisting the
/// pref is the frontend's job — this only flips the live process state.
#[tauri::command]
pub fn bunqueue_set_enabled(
    state: tauri::State<'_, BunqueueState>,
    enabled: bool,
) -> BunqueueStatus {
    state.enabled.store(enabled, Ordering::Release);
    if enabled {
        ensure_running(&state);
    } else {
        shutdown(&state);
    }
    bunqueue_status(state)
}

/// Watchdog poll interval when healthy.
const WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
/// Backoff cap after repeated spawn failures (e.g. Bun not installed), so a
/// broken environment doesn't spin-respawn every 3s forever.
const WATCHDOG_MAX_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Spawn a background thread that supervises the server + workers, restarting
/// any that die. Call once after `start_on_boot`. The `AppHandle` is `'static`
/// and re-resolves the managed state each tick.
pub fn start_watchdog(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut backoff = WATCHDOG_INTERVAL;
        loop {
            thread::sleep(backoff);
            let state = app.state::<BunqueueState>();
            let healthy = ensure_running(&state);
            backoff = if healthy {
                WATCHDOG_INTERVAL
            } else {
                // Widen interval up to the cap while unhealthy.
                (backoff * 2).min(WATCHDOG_MAX_INTERVAL)
            };
        }
    });
}

/// Start the server once, on app boot. Logs failure but never panics — a
/// missing Bun runtime should degrade gracefully, not crash Terax.
pub fn start_on_boot(state: &BunqueueState) {
    let mut guard = state.proc.lock_safe();
    if guard.as_ref().map(|p| !p.exited.load(Ordering::Acquire)).unwrap_or(false) {
        return; // already running
    }
    match spawn_server(state.data_path()) {
        Ok(proc) => {
            log::info!(
                "bunqueue server started (http://127.0.0.1:{}, tcp {})",
                HTTP_PORT,
                TCP_PORT
            );
            *guard = Some(proc);
            drop(guard);
            // Workers connect to the server over TCP — start them after the
            // server is up.
            start_workers(state);
        }
        Err(e) => {
            // Common in dev when Bun isn't installed; keep the app usable.
            log::warn!("bunqueue server did not start: {e}");
        }
    }
}

/// Build a `BunqueueStatus` from a managed process handle.
fn status_of(proc: &ManagedProc) -> BunqueueStatus {
    let exited = proc.exited.load(Ordering::Acquire);
    BunqueueStatus {
        running: !exited,
        command: Some(proc.command.clone()),
        tcp_port: proc.tcp_port,
        http_port: proc.http_port,
        http_url: proc
            .http_port
            .map(|p| format!("http://127.0.0.1:{p}")),
        data_path: proc
            .data_path
            .as_ref()
            .map(|p| p.display().to_string()),
        started_at_ms: Some(proc.started_at_ms),
        exited,
        exit_code: resolved_exit_code(proc),
    }
}

#[tauri::command]
pub fn bunqueue_status(state: tauri::State<'_, BunqueueState>) -> BunqueueStatus {
    let guard = state.proc.lock_safe();
    match guard.as_ref() {
        Some(proc) => status_of(proc),
        None => BunqueueStatus {
            running: false,
            command: None,
            tcp_port: None,
            http_port: None,
            http_url: None,
            data_path: None,
            started_at_ms: None,
            exited: false,
            exit_code: None,
        },
    }
}

#[tauri::command]
pub fn bunqueue_logs(
    state: tauri::State<'_, BunqueueState>,
    since_offset: Option<u64>,
) -> BunqueueLogResponse {
    let guard = state.proc.lock_safe();
    match guard.as_ref() {
        Some(proc) => {
            let (bytes, next_offset, dropped) =
                proc.buffer.lock_safe().read_from(since_offset.unwrap_or(0));
            BunqueueLogResponse {
                bytes: String::from_utf8_lossy(&bytes).into_owned(),
                next_offset,
                dropped,
                exited: proc.exited.load(Ordering::Acquire),
                exit_code: resolved_exit_code(proc),
            }
        }
        None => BunqueueLogResponse {
            bytes: String::new(),
            next_offset: 0,
            dropped: 0,
            exited: false,
            exit_code: None,
        },
    }
}

/// Kill the current server + workers and spawn fresh ones.
#[tauri::command]
pub fn bunqueue_restart(state: tauri::State<'_, BunqueueState>) -> Result<BunqueueStatus, String> {
    // Stop workers first — they reconnect to the new server after it restarts.
    {
        let mut workers = state.workers.lock_safe();
        for w in workers.drain(..) {
            w.proc.kill();
        }
    }
    {
        let mut guard = state.proc.lock_safe();
        if let Some(old) = guard.take() {
            old.kill();
            // Drop the Arc; the wait thread observes the kill and exits.
        }
    }
    let proc = spawn_server(state.data_path())?;
    let status = status_of(&proc);
    *state.proc.lock_safe() = Some(proc);
    start_workers(&state);
    Ok(status)
}

#[derive(Serialize)]
pub struct WorkerInfo {
    pub name: String,
    pub queue: String,
    pub script: String,
    pub command: Option<String>,
    pub running: bool,
    pub started_at_ms: Option<u64>,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// Status of all registered worker processes (the Bun child processes Terax
/// spawns, distinct from the worker registry the bunqueue server reports over
/// HTTP).
#[tauri::command]
pub fn bunqueue_workers(state: tauri::State<'_, BunqueueState>) -> Vec<WorkerInfo> {
    let workers = state.workers.lock_safe();
    workers
        .iter()
        .map(|w| {
            let exited = w.proc.exited.load(Ordering::Acquire);
            WorkerInfo {
                name: w.name.clone(),
                queue: w.queue.clone(),
                script: w.script_rel.clone(),
                command: Some(w.proc.command.clone()),
                running: !exited,
                started_at_ms: Some(w.proc.started_at_ms),
                exited,
                exit_code: resolved_exit_code(&w.proc),
            }
        })
        .collect()
}

/// Best-effort kill of the server + workers on app shutdown. `ManagedProc`'s
/// `Drop` also kills the child, so dropping `BunqueueState` covers normal exit;
/// this is the explicit hook for the `ExitRequested` event.
pub fn shutdown(state: &BunqueueState) {
    if let Ok(mut workers) = state.workers.lock() {
        for w in workers.drain(..) {
            w.proc.kill();
        }
    }
    if let Ok(mut guard) = state.proc.lock() {
        if let Some(proc) = guard.take() {
            proc.kill();
        }
    }
}
