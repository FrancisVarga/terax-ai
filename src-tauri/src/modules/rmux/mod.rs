//! Optional forwarding of the PTY commands to the out-of-process rmux daemon
//! sidecar (#110, Phase 1 Step 3).
//!
//! Terax normally spawns shells in-process (`modules::pty`). Behind a runtime
//! flag this module instead routes `pty_open`/`pty_write`/`pty_resize`/
//! `pty_close` to the `rmux-daemon` sidecar over its loopback HTTP + SSE API, so
//! the live shells run in a process that can OUTLIVE Terax (the survival goal of
//! terminal-rmux). The frontend is unaware: `pty_open` still returns the same
//! `u32` id, output still arrives on the same `Channel<Response>`, and agent
//! signals still emit `terax:agent-signal`.
//!
//! The flag (`TERAX_RMUX_DAEMON=1`) defaults OFF, so the default dev/release path
//! is unchanged. When ON but the daemon binary is not staged next to the app exe
//! (the dev case — staging is #111), connection fails and `pty_open` falls back
//! to the in-process path. Nothing about flag-on is allowed to break an open.
//!
//! Lifetime note: unlike the otel sidecar, the daemon child is deliberately NOT
//! killed on app shutdown — surviving Terax is the whole point. Phase 3 owns the
//! singleton/reattach story; in Phase 1 a leftover daemon may linger, so its pid
//! is logged to keep it discoverable.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use shared_child::SharedChild;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter};

use crate::modules::pty::PtyState;
use crate::modules::sync::MutexExt;

/// Sidecar base name (no triple, no extension). Staging it as a Tauri
/// `externalBin` is #111; until then `find_sidecar` returns `None` in dev.
const SIDECAR_BASE: &str = "rmux-daemon";

/// Env var that turns daemon forwarding on. Any value other than exactly "1" is
/// treated as off, so the default (unset) keeps the in-process path.
const FLAG_ENV: &str = "TERAX_RMUX_DAEMON";

/// How long to wait for the daemon to print its `listening port=NNNN` line on
/// stdout before giving up and falling back to in-process.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// True when daemon forwarding is enabled for this process. Read per-call (cheap
/// env lookup) so the flag can be toggled without a rebuild.
pub fn daemon_enabled() -> bool {
    std::env::var(FLAG_ENV).is_ok_and(|v| v == "1")
}

/// A connected daemon: its loopback base URL and the child handle. The child is
/// held only so its pid stays known (and the handle alive); it is intentionally
/// never killed here.
struct Daemon {
    base_url: String,
    #[allow(dead_code)]
    child: Arc<SharedChild>,
}

/// Tauri-managed state for the daemon connection and the id mapping. Empty until
/// the first forwarded `pty_open` lazily connects.
#[derive(Default)]
pub struct RmuxState {
    daemon: Mutex<Option<Arc<Daemon>>>,
    /// terax-facing id -> daemon pane id. Presence here is what routes
    /// write/resize/close to the daemon instead of the in-process map.
    panes: Mutex<HashMap<u32, u32>>,
}

impl RmuxState {
    /// The daemon pane id a terax-facing id forwards to, if it is daemon-backed.
    fn pane_of(&self, id: u32) -> Option<u32> {
        self.panes.lock_safe().get(&id).copied()
    }

    /// The connected daemon's base URL, if connected.
    fn base_url(&self) -> Option<String> {
        self.daemon
            .lock_safe()
            .as_ref()
            .map(|d| d.base_url.clone())
    }

    /// Ensure the daemon is connected, connecting on first use. Returns the base
    /// URL on success. Err means "no daemon available" and the caller must fall
    /// back to the in-process path.
    fn ensure_connected(&self) -> Result<String, String> {
        let mut guard = self.daemon.lock_safe();
        if let Some(d) = guard.as_ref() {
            return Ok(d.base_url.clone());
        }
        let exe = find_sidecar(SIDECAR_BASE).ok_or_else(|| {
            "rmux-daemon binary not found next to app exe (not staged in dev)".to_string()
        })?;
        let (child, port) = spawn_daemon(&exe)?;
        let base_url = format!("http://127.0.0.1:{port}");
        log::info!(
            target: "rmux",
            "rmux-daemon connected at {base_url} (pid={}); not killed on shutdown by design",
            child.id()
        );
        let daemon = Arc::new(Daemon { base_url: base_url.clone(), child });
        *guard = Some(daemon);
        Ok(base_url)
    }
}

/// Resolve a forwarded `pty_open`. On `Ok(id)` the open is daemon-backed and the
/// caller returns the id; on `Err` the caller logs and falls through to the
/// in-process path. Connecting, the POST, the SSE bridge spawn, and the id
/// allocation all happen here so the in-process command body stays untouched on
/// the error path.
#[allow(clippy::too_many_arguments)]
pub async fn open_forwarded(
    app: &AppHandle,
    pty_state: &PtyState,
    rmux_state: &RmuxState,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let base_url = rmux_state.ensure_connected()?;

    let pane_id = open_pane(&base_url, cols, rows, cwd).await?;

    // Reuse PtyState's id allocator so daemon-backed and in-process ids share one
    // monotonic sequence and can never collide across modes.
    let terax_id = pty_state.next_id();
    rmux_state.panes.lock_safe().insert(terax_id, pane_id);

    let events_url = format!("{base_url}/pane/{pane_id}/attach");
    let app = app.clone();
    // The bridge owns the id-map entry's removal on exit. It needs the managed
    // RmuxState, but Tauri State is borrow-scoped to the command; resolve the
    // same managed instance from the AppHandle inside the task instead.
    tauri::async_runtime::spawn(async move {
        run_event_bridge(app, events_url, terax_id, on_data, on_exit).await;
    });

    log::info!(target: "rmux", "pty forwarded id={terax_id} -> daemon pane={pane_id}");
    Ok(terax_id)
}

/// Forward a write to the daemon. Returns `Ok(true)` if the id was daemon-backed
/// and the write was forwarded (success or daemon error), `Ok(false)` if the id
/// is not daemon-backed (caller uses the in-process path).
pub fn write_forwarded(rmux_state: &RmuxState, id: u32, data: &str) -> Result<bool, String> {
    let Some(pane_id) = rmux_state.pane_of(id) else {
        return Ok(false);
    };
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    let url = format!("{base_url}/pane/{pane_id}/write");
    post_json(&url, serde_json::json!({ "data": data }))?;
    Ok(true)
}

/// Forward a resize to the daemon. See [`write_forwarded`] for the bool meaning.
pub fn resize_forwarded(
    rmux_state: &RmuxState,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    let Some(pane_id) = rmux_state.pane_of(id) else {
        return Ok(false);
    };
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    let url = format!("{base_url}/pane/{pane_id}/resize");
    post_json(&url, serde_json::json!({ "cols": cols, "rows": rows }))?;
    Ok(true)
}

/// Forward a close to the daemon and forget the id. See [`write_forwarded`] for
/// the bool meaning. The map entry is removed regardless of the POST result so a
/// daemon-side error can't leave a dangling mapping.
pub fn close_forwarded(rmux_state: &RmuxState, id: u32) -> Result<bool, String> {
    let Some(pane_id) = rmux_state.panes.lock_safe().remove(&id) else {
        return Ok(false);
    };
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    let url = format!("{base_url}/pane/{pane_id}/close");
    post_json(&url, serde_json::json!({}))?;
    Ok(true)
}

/// Forward a DETACH: stop the terax-side mapping but leave the daemon pane
/// running (its ring keeps retaining output). Returns `Ok(Some(daemon_pane_id))`
/// when the id was daemon-backed so the caller can surface the pane id to the
/// frontend for a later reattach; `Ok(None)` when the id is not daemon-backed
/// (an in-process pane has no detach concept). Unlike close, this does NOT tell
/// the daemon to kill the pane.
pub fn detach_forwarded(rmux_state: &RmuxState, id: u32) -> Result<Option<u32>, String> {
    let Some(pane_id) = rmux_state.panes.lock_safe().remove(&id) else {
        return Ok(None);
    };
    if let Some(base_url) = rmux_state.base_url() {
        // Best-effort: the daemon detach verb is a confirmation no-op, so a
        // failure here does not change that the pane keeps running.
        let url = format!("{base_url}/pane/{pane_id}/detach");
        let _ = post_json(&url, serde_json::json!({}));
    }
    Ok(Some(pane_id))
}

/// Re-attach to an EXISTING daemon pane (one previously detached). Allocates a
/// fresh terax-facing id, maps it to the given daemon pane id, and starts the
/// binary bridge which replays the pane's scrollback ring then streams live.
/// Returns the new terax-facing id. Erries if the daemon is not connected.
pub fn attach_existing(
    app: &AppHandle,
    pty_state: &PtyState,
    rmux_state: &RmuxState,
    daemon_pane_id: u32,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    let terax_id = pty_state.next_id();
    rmux_state.panes.lock_safe().insert(terax_id, daemon_pane_id);
    let events_url = format!("{base_url}/pane/{daemon_pane_id}/attach");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_event_bridge(app, events_url, terax_id, on_data, on_exit).await;
    });
    log::info!(target: "rmux", "reattached terax id={terax_id} -> daemon pane={daemon_pane_id}");
    Ok(terax_id)
}

/// Best-effort close of every daemon-backed pane and clear the map. Used by
/// `pty_close_all` on webview reload. Failures are swallowed: the panes live in
/// the surviving daemon and a leftover is acceptable in Phase 1, so this must
/// never block the reload.
pub fn close_all_forwarded(rmux_state: &RmuxState) {
    let drained: Vec<(u32, u32)> = rmux_state.panes.lock_safe().drain().collect();
    let Some(base_url) = rmux_state.base_url() else {
        return;
    };
    for (id, pane_id) in drained {
        let url = format!("{base_url}/pane/{pane_id}/close");
        if let Err(e) = post_json(&url, serde_json::json!({})) {
            log::debug!(target: "rmux", "close_all: pane id={id} close failed: {e}");
        }
    }
}

/// Locate the `rmux-daemon` sidecar next to the app binary, mirroring the otel
/// sidecar resolution. `None` in dev (#111 stages it) -> fall back to in-process.
fn find_sidecar(base: &str) -> Option<std::path::PathBuf> {
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

/// Spawn the daemon DETACHED so it survives Terax, with stdout piped so the
/// ephemeral listen port can be read back. Returns the child and the parsed port.
///
/// On Windows this performs the breakaway-from-job try/fallback proven by the
/// Phase 0 spike: try DETACHED + breakaway first; if `CreateProcess` returns
/// ERROR_ACCESS_DENIED (the parent job forbids breakaway) retry without it, since
/// a parent job without kill-on-close lets a plain detached child survive anyway.
fn spawn_daemon(exe: &std::path::Path) -> Result<(Arc<SharedChild>, u16), String> {
    let child = spawn_detached(exe)?;
    let child = Arc::new(child);
    let port = read_ready_port(&child)
        .map_err(|e| format!("rmux-daemon did not report a listen port: {e}"))?;
    Ok((child, port))
}

/// Build the daemon `Command` with stdio + console-hide applied. Detach flags are
/// added by the platform spawn helpers so the Windows breakaway retry can vary
/// only that flag.
fn base_command(exe: &std::path::Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    cmd
}

#[cfg(windows)]
fn spawn_detached(exe: &std::path::Path) -> Result<SharedChild, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = base_command(exe);
    cmd.creation_flags(detached_flags(true));
    match SharedChild::spawn(&mut cmd) {
        Ok(child) => Ok(child),
        Err(e) if e.raw_os_error() == Some(5) => {
            // Parent job forbids breakaway; a plain detached child still outlives
            // the parent when the job has no kill-on-close. Retry without it.
            log::debug!(target: "rmux", "breakaway denied; retrying detached-only");
            let mut cmd = base_command(exe);
            cmd.creation_flags(detached_flags(false));
            SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn {}: {e}", exe.display()))
        }
        Err(e) => Err(format!("spawn {}: {e}", exe.display())),
    }
}

#[cfg(unix)]
fn spawn_detached(exe: &std::path::Path) -> Result<SharedChild, String> {
    use std::os::unix::process::CommandExt;
    let mut cmd = base_command(exe);
    // SAFETY: `setsid` is async-signal-safe and is the only call between fork and
    // exec; it makes the child a new session leader with no controlling terminal
    // so it is not reaped when Terax's session ends.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn {}: {e}", exe.display()))
}

/// Read the daemon's stdout until its `rmux-daemon: listening port=NNNN` line,
/// returning the port. Times out after [`READY_TIMEOUT`]. The stdout handle is
/// taken from the `SharedChild` (it owns it once and only once).
fn read_ready_port(child: &SharedChild) -> Result<u16, String> {
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "stdout not piped".to_string())?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut line = String::new();
    loop {
        if Instant::now() >= deadline {
            return Err(format!("timed out after {READY_TIMEOUT:?}"));
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("stdout closed before listening line".to_string()),
            Ok(_) => {
                if let Some(port) = parse_listening_port(&line) {
                    return Ok(port);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Windows detached-spawn creation flags. Survival comes from
/// `CREATE_NEW_PROCESS_GROUP` (the child is not killed by the parent's Ctrl-C)
/// plus, when permitted, `CREATE_BREAKAWAY_FROM_JOB` (the child escapes an
/// inherited kill-on-close Job Object). `DETACHED_PROCESS` is deliberately NOT
/// used: it severs the child's stdio, which would break the piped-stdout port
/// handshake `read_ready_port` depends on. `hide_console` already suppresses a
/// console window, so the daemon runs windowless without detaching its pipes.
#[cfg(windows)]
fn detached_flags(breakaway: bool) -> u32 {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    if breakaway {
        CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
    } else {
        CREATE_NEW_PROCESS_GROUP
    }
}

/// Parse `rmux-daemon: listening port=NNNN` (the daemon's stdout handshake) into
/// the port number. Tolerant of surrounding whitespace and trailing text.
fn parse_listening_port(line: &str) -> Option<u16> {
    let idx = line.find("listening port=")?;
    let rest = &line[idx + "listening port=".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Blocking JSON POST to a daemon verb. Runs the async reqwest call on the Tauri
/// runtime via `block_on`, matching `otel::proxy_query`: the pty write/resize/
/// close commands are synchronous, so blocking on the command worker thread is
/// the established pattern.
fn post_json(url: &str, body: Value) -> Result<(), String> {
    let url = url.to_string();
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rmux daemon request failed: {e}"))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(resp.text().await.unwrap_or_default())
        }
    })
}

/// Blocking POST that returns the JSON response body (for verbs like
/// `/session/new` that hand back ids). Runs on the Tauri runtime, like
/// `post_json`.
fn post_json_resp(url: &str, body: Value) -> Result<Value, String> {
    let url = url.to_string();
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rmux daemon request failed: {e}"))?;
        if resp.status().is_success() {
            resp.json::<Value>()
                .await
                .map_err(|e| format!("rmux daemon bad response: {e}"))
        } else {
            Err(resp.text().await.unwrap_or_default())
        }
    })
}

/// Blocking GET returning the JSON response body (for `/session/list`).
fn get_json(url: &str) -> Result<Value, String> {
    let url = url.to_string();
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("rmux daemon request failed: {e}"))?;
        if resp.status().is_success() {
            resp.json::<Value>()
                .await
                .map_err(|e| format!("rmux daemon bad response: {e}"))
        } else {
            Err(resp.text().await.unwrap_or_default())
        }
    })
}

// --- Session / window verb forwarding (#132) ---
// These drive the daemon's session.* / window.* HTTP verbs (added in #130) so
// the SessionSwitcher can manage named sessions. All require the daemon to be
// connected; ensure_connected lazily spawns it. The frontend only calls these
// when the rmux flag is on.

/// Create a named session (one window, one pane). Returns the daemon JSON
/// `{session_id, window_id, pane_id}`.
pub fn session_new_forwarded(rmux_state: &RmuxState, name: &str, cwd: Option<&str>) -> Result<Value, String> {
    let base_url = rmux_state.ensure_connected()?;
    post_json_resp(
        &format!("{base_url}/session/new"),
        serde_json::json!({ "name": name, "cwd": cwd }),
    )
}

/// The full session/window/pane tree, or an empty array if the daemon is not
/// connected (so the switcher shows "no sessions" instead of erroring).
pub fn session_list_forwarded(rmux_state: &RmuxState) -> Result<Value, String> {
    let Some(base_url) = rmux_state.base_url() else {
        return Ok(serde_json::json!([]));
    };
    get_json(&format!("{base_url}/session/list"))
}

pub fn session_rename_forwarded(rmux_state: &RmuxState, id: u32, name: &str) -> Result<(), String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json(&format!("{base_url}/session/{id}/rename"), serde_json::json!({ "name": name }))
}

pub fn session_kill_forwarded(rmux_state: &RmuxState, id: u32) -> Result<(), String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json(&format!("{base_url}/session/{id}/kill"), serde_json::json!({}))
}

/// Add a window to a session. Returns `{window_id, pane_id}`.
pub fn window_new_forwarded(rmux_state: &RmuxState, session_id: u32, name: Option<&str>) -> Result<Value, String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json_resp(
        &format!("{base_url}/session/{session_id}/window/new"),
        serde_json::json!({ "name": name }),
    )
}

/// Split a window. Returns `{pane_id}`. `dir` is "row" | "col".
pub fn window_split_forwarded(rmux_state: &RmuxState, window_id: u32, dir: &str) -> Result<Value, String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json_resp(
        &format!("{base_url}/window/{window_id}/split"),
        serde_json::json!({ "dir": dir }),
    )
}

// --- Message bus verb forwarding (#137) ---
// These drive the daemon's #136 bus verbs (/bus/publish, /pane/<id>/inbox,
// /pane/<id>/inbox/ack) so the frontend can fan out inter-pane messages and poll
// per-pane inboxes. Same degrade contract as the session verbs: publish/ack are
// writes and error when the daemon is absent; inbox_list is a read and degrades
// to an empty `{messages:[]}` so a poller shows nothing instead of erroring.

/// Publish a bus message. `to` is the daemon routing value (a pane id number,
/// `{"session": name}`, `{"window": name}`, or `"*"`). Returns the daemon JSON
/// `{delivered, message_id}`. Requires the daemon connected (a write).
pub fn bus_publish_forwarded(
    rmux_state: &RmuxState,
    from: u32,
    to: Value,
    msg_type: &str,
    payload: Value,
    inject: bool,
) -> Result<Value, String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json_resp(
        &format!("{base_url}/bus/publish"),
        serde_json::json!({ "from": from, "to": to, "type": msg_type, "payload": payload, "inject": inject }),
    )
}

/// Snapshot a pane's inbox (non-draining). Returns the daemon JSON
/// `{messages: [...]}`, or `{messages: []}` if the daemon is not connected (so a
/// poller degrades to "no messages" instead of erroring), mirroring
/// `session_list_forwarded`.
pub fn inbox_list_forwarded(rmux_state: &RmuxState, pane_id: u32) -> Result<Value, String> {
    let Some(base_url) = rmux_state.base_url() else {
        return Ok(serde_json::json!({ "messages": [] }));
    };
    get_json(&format!("{base_url}/pane/{pane_id}/inbox"))
}

/// Ack (drain) inbox messages. `ids` present drains those; `ids` absent drains
/// all. Returns `{remaining}`. Requires the daemon connected (a write).
pub fn inbox_ack_forwarded(
    rmux_state: &RmuxState,
    pane_id: u32,
    ids: Option<Vec<u32>>,
) -> Result<Value, String> {
    let base_url = rmux_state
        .base_url()
        .ok_or_else(|| "rmux daemon not connected".to_string())?;
    post_json_resp(
        &format!("{base_url}/pane/{pane_id}/inbox/ack"),
        serde_json::json!({ "ids": ids }),
    )
}

/// Async JSON POST to `/pane/open`, returning the daemon pane id.
async fn open_pane(
    base_url: &str,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    let url = format!("{base_url}/pane/open");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "cols": cols, "rows": rows, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| format!("rmux daemon open failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("rmux daemon bad open response: {e}"))?;
    v.get("pane_id")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .ok_or_else(|| "rmux daemon open response missing pane_id".to_string())
}

/// Frame kinds on the daemon's binary attach stream (must match the daemon's
/// `encode_frame`): `[u8 kind][u32 LE len][payload]`.
const FRAME_DATA: u8 = 0;
const FRAME_AGENT: u8 = 1;
const FRAME_EXIT: u8 = 2;
/// Bus message frame (#137): carries serialized `BusMessage` JSON; bridged to the
/// `terax:rmux-message` Tauri event, exactly as `FRAME_AGENT` is bridged to
/// `terax:agent-signal`.
const FRAME_MSG: u8 = 3;
const FRAME_HEADER_LEN: usize = 5;

/// Connect to a pane's `/attach` binary stream and bridge each frame back onto
/// the in-process transport: `data` -> `on_data` (raw bytes, no base64), `agent`
/// -> the `terax:agent-signal` event, `exit` -> `on_exit`. The daemon replays the
/// pane's scrollback ring before the live tail, so a single attach restores
/// context with no subscribe-race. Ends (removing the id mapping) once an `exit`
/// frame or the stream end is seen.
async fn run_event_bridge(
    app: AppHandle,
    url: String,
    terax_id: u32,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) {
    let client = reqwest::Client::new();
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        other => {
            log::debug!(target: "rmux", "attach failed: {other:?}");
            spawn_forget(&app, terax_id);
            return;
        }
    };

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = stream.next().await {
        let Ok(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        // Drain every complete frame currently buffered; a partial tail stays in
        // `buf` for the next chunk.
        while let Some((kind, payload)) = take_frame(&mut buf) {
            if dispatch_frame(&app, kind, payload, &on_data, &on_exit) == FrameOutcome::Exit {
                spawn_forget(&app, terax_id);
                return;
            }
        }
    }
    // Stream ended without an explicit exit (pane closed / daemon gone): forget.
    spawn_forget(&app, terax_id);
}

/// Pull one complete `[u8 kind][u32 LE len][payload]` frame off the front of
/// `buf`, draining its bytes. Returns `None` (leaving `buf` intact) when a full
/// frame is not yet buffered.
fn take_frame(buf: &mut Vec<u8>) -> Option<(u8, Vec<u8>)> {
    if buf.len() < FRAME_HEADER_LEN {
        return None;
    }
    let len = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
    let total = FRAME_HEADER_LEN + len;
    if buf.len() < total {
        return None;
    }
    let kind = buf[0];
    let payload = buf[FRAME_HEADER_LEN..total].to_vec();
    buf.drain(..total);
    Some((kind, payload))
}

fn spawn_forget(app: &AppHandle, terax_id: u32) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || forget_pane(&app, terax_id));
}

/// Whether a dispatched frame ended the pane.
#[derive(PartialEq, Eq)]
enum FrameOutcome {
    Continue,
    Exit,
}

/// Route one binary frame to the in-process transport. Returns `Exit` for an
/// `exit` frame so the bridge can stop and forget the pane.
fn dispatch_frame(
    app: &AppHandle,
    kind: u8,
    payload: Vec<u8>,
    on_data: &Channel<Response>,
    on_exit: &Channel<i32>,
) -> FrameOutcome {
    match kind {
        FRAME_DATA => {
            if let Err(e) = on_data.send(Response::new(payload)) {
                log::debug!(target: "rmux", "data channel closed: {e}");
            }
        }
        FRAME_AGENT => {
            if let Ok(v) = serde_json::from_slice::<Value>(&payload) {
                let _ = app.emit("terax:agent-signal", v);
            }
        }
        FRAME_MSG => {
            // A bus message delivered to this pane (#137). Parse the serialized
            // `BusMessage` JSON and surface it to the webview as a Tauri event,
            // mirroring the agent-signal path. The durable copy already lives in
            // the daemon's pane inbox; this is the live push.
            if let Ok(v) = serde_json::from_slice::<Value>(&payload) {
                let _ = app.emit("terax:rmux-message", v);
            }
        }
        FRAME_EXIT => {
            let code = if payload.len() == 4 {
                i32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]])
            } else {
                -1
            };
            if let Err(e) = on_exit.send(code) {
                log::debug!(target: "rmux", "exit channel closed: {e}");
            }
            return FrameOutcome::Exit;
        }
        _ => {}
    }
    FrameOutcome::Continue
}

/// Remove a terax-facing id from the daemon map (called once its pane exits).
fn forget_pane(app: &AppHandle, terax_id: u32) {
    use tauri::Manager;
    app.state::<RmuxState>().panes.lock_safe().remove(&terax_id);
}

// --- Tauri commands for the SessionSwitcher (#132) ---
// Thin wrappers exposing the daemon session/window verbs to the webview. The
// switcher only calls these when the rmux flag is on; with the flag off (or the
// daemon absent) session_list returns an empty array and the others error
// cleanly, so the switcher degrades gracefully.

#[tauri::command]
pub fn rmux_session_new(
    rmux_state: tauri::State<RmuxState>,
    name: String,
    cwd: Option<String>,
) -> Result<Value, String> {
    session_new_forwarded(&rmux_state, &name, cwd.as_deref())
}

#[tauri::command]
pub fn rmux_session_list(rmux_state: tauri::State<RmuxState>) -> Result<Value, String> {
    session_list_forwarded(&rmux_state)
}

#[tauri::command]
pub fn rmux_session_rename(
    rmux_state: tauri::State<RmuxState>,
    id: u32,
    name: String,
) -> Result<(), String> {
    session_rename_forwarded(&rmux_state, id, &name)
}

#[tauri::command]
pub fn rmux_session_kill(rmux_state: tauri::State<RmuxState>, id: u32) -> Result<(), String> {
    session_kill_forwarded(&rmux_state, id)
}

#[tauri::command]
pub fn rmux_window_new(
    rmux_state: tauri::State<RmuxState>,
    session_id: u32,
    name: Option<String>,
) -> Result<Value, String> {
    window_new_forwarded(&rmux_state, session_id, name.as_deref())
}

#[tauri::command]
pub fn rmux_window_split(
    rmux_state: tauri::State<RmuxState>,
    window_id: u32,
    dir: String,
) -> Result<Value, String> {
    window_split_forwarded(&rmux_state, window_id, &dir)
}

// --- Tauri commands for the message bus (#137) ---
// Thin wrappers over the bus verb forwarders. Same degrade story as the session
// commands: with the daemon absent, publish/ack error cleanly and inbox_list
// returns an empty `{messages:[]}`.

#[tauri::command]
pub fn rmux_bus_publish(
    rmux_state: tauri::State<RmuxState>,
    from: u32,
    to: Value,
    msg_type: String,
    payload: Value,
    inject: Option<bool>,
) -> Result<Value, String> {
    bus_publish_forwarded(&rmux_state, from, to, &msg_type, payload, inject.unwrap_or(false))
}

#[tauri::command]
pub fn rmux_inbox_list(rmux_state: tauri::State<RmuxState>, pane_id: u32) -> Result<Value, String> {
    inbox_list_forwarded(&rmux_state, pane_id)
}

#[tauri::command]
pub fn rmux_inbox_ack(
    rmux_state: tauri::State<RmuxState>,
    pane_id: u32,
    ids: Option<Vec<u32>>,
) -> Result<Value, String> {
    inbox_ack_forwarded(&rmux_state, pane_id, ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one wire frame the way the daemon's `encode_frame` does.
    fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![kind];
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn parses_listening_port() {
        assert_eq!(
            parse_listening_port("rmux-daemon: listening port=54321\n"),
            Some(54321)
        );
        assert_eq!(parse_listening_port("listening port=1"), Some(1));
        assert_eq!(parse_listening_port("no port here"), None);
        assert_eq!(parse_listening_port("listening port=notnum"), None);
    }

    #[test]
    fn take_frame_extracts_one_complete_frame() {
        let mut buf = frame(FRAME_DATA, b"hello world");
        let (kind, payload) = take_frame(&mut buf).expect("one frame");
        assert_eq!(kind, FRAME_DATA);
        assert_eq!(payload, b"hello world");
        assert!(buf.is_empty(), "buffer fully drained");
    }

    #[test]
    fn take_frame_waits_for_full_payload() {
        // Header says 5 bytes but only 2 are present: must return None and keep
        // the bytes for the next chunk.
        let mut buf = vec![FRAME_DATA];
        buf.extend_from_slice(&5u32.to_le_bytes());
        buf.extend_from_slice(b"ab");
        let before = buf.clone();
        assert!(take_frame(&mut buf).is_none());
        assert_eq!(buf, before, "partial frame left intact");
    }

    #[test]
    fn take_frame_splits_back_to_back_frames() {
        // Two frames concatenated (the chunked-stream case): both extract in order.
        let mut buf = frame(FRAME_DATA, b"one");
        buf.extend(frame(FRAME_EXIT, &137i32.to_le_bytes()));
        let (k1, p1) = take_frame(&mut buf).unwrap();
        assert_eq!((k1, p1.as_slice()), (FRAME_DATA, b"one".as_slice()));
        let (k2, p2) = take_frame(&mut buf).unwrap();
        assert_eq!(k2, FRAME_EXIT);
        assert_eq!(i32::from_le_bytes([p2[0], p2[1], p2[2], p2[3]]), 137);
        assert!(buf.is_empty());
    }

    #[test]
    fn data_frame_carries_raw_bytes_unchanged() {
        // Non-UTF-8 bytes (an SGR sequence + a raw 0xFF) survive verbatim: this is
        // exactly why the wire format dropped base64 and text framing.
        let raw = vec![0x1b, b'[', b'3', b'1', b'm', 0xFF, b'x'];
        let mut buf = frame(FRAME_DATA, &raw);
        let (kind, payload) = take_frame(&mut buf).unwrap();
        assert_eq!(kind, FRAME_DATA);
        assert_eq!(payload, raw);
    }

    #[test]
    fn exit_frame_decodes_le_i32() {
        let mut buf = frame(FRAME_EXIT, &137i32.to_le_bytes());
        let (kind, payload) = take_frame(&mut buf).unwrap();
        assert_eq!(kind, FRAME_EXIT);
        assert_eq!(
            i32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]),
            137
        );
    }

    // True end-to-end against a live daemon. Spawns the real `rmux-daemon` binary
    // (path from `RMUX_DAEMON_E2E`), reads its listen port the same way
    // `spawn_daemon` does, then drives the REAL forwarding client functions:
    // `open_pane` (open a shell), `post_json` (write to it), and a manual read of
    // the `/events` SSE stream asserting a base64 `data` frame decodes to the
    // echoed input. Ignored by default so the normal suite needs no binary; run
    // with `RMUX_DAEMON_E2E=<path> cargo test --lib rmux::end_to_end -- --ignored`.
    #[test]
    #[ignore = "requires a built rmux-daemon binary via RMUX_DAEMON_E2E"]
    fn end_to_end_forwarding_against_live_daemon() {
        let exe = match std::env::var("RMUX_DAEMON_E2E") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => return,
        };
        assert!(exe.is_file(), "RMUX_DAEMON_E2E does not point at a file: {}", exe.display());

        // Reuse the production spawn + port-read path.
        let (child, port) = spawn_daemon(&exe).expect("spawn daemon + read port");
        let base_url = format!("http://127.0.0.1:{port}");

        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let marker = "RMUX_E2E_MARKER";

        // open_pane drives the real /pane/open client. Done inside the runtime.
        let pane = rt
            .block_on(open_pane(&base_url, 80, 24, None))
            .expect("open pane");
        assert!(pane >= 1, "pane id should be monotonic from 1");

        // Attach to /attach BEFORE writing and parse the BINARY frame stream
        // (`[u8 kind][u32 LE len][payload]`) exactly as `take_frame` /
        // `dispatch_frame` do, collecting raw `data` payloads (no base64).
        let events_url = format!("{base_url}/pane/{pane}/attach");
        let reader = rt.spawn(async move {
            let client = reqwest::Client::new();
            let resp = client.get(&events_url).send().await.expect("connect attach");
            assert!(resp.status().is_success());
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let Some(chunk) = stream.next().await else { break };
                let Ok(bytes) = chunk else { break };
                buf.extend_from_slice(&bytes);
                while let Some((kind, payload)) = take_frame(&mut buf) {
                    if kind == FRAME_DATA
                        && String::from_utf8_lossy(&payload).contains("RMUX_E2E_MARKER")
                    {
                        return true;
                    }
                }
            }
            false
        });

        // Give the subscriber a beat to connect and let pwsh emit its startup
        // cursor-position request (CPR, ESC[6n) before writing.
        std::thread::sleep(Duration::from_millis(400));

        // Write via a direct reqwest POST inside the test's own runtime. The
        // production `post_json` uses `tauri::async_runtime::block_on`, which
        // needs Tauri's global runtime and cannot run in a bare `cargo test`;
        // the HTTP shape exercised here is identical (POST /pane/<id>/write with
        // a {data} body), so this still proves the daemon's write+echo path.
        let write_url = format!("{base_url}/pane/{pane}/write");
        let post_data = |payload: String| {
            let url = write_url.clone();
            rt.block_on(async move {
                reqwest::Client::new()
                    .post(&url)
                    .json(&serde_json::json!({ "data": payload }))
                    .send()
                    .await
                    .expect("write to pane")
                    .error_for_status()
                    .expect("write status");
            });
        };

        // Answer the CPR so PSReadLine unblocks, exactly as a real xterm does in
        // app. Without this pwsh sits waiting and never processes the marker
        // line. Then submit the marker with CR (PowerShell needs CR, not LF).
        post_data("\x1b[1;1R".to_string());
        std::thread::sleep(Duration::from_millis(200));
        post_data(format!("echo {marker}\r"));

        let seen = rt.block_on(reader).expect("events reader task");
        assert!(seen, "did not observe the echoed marker on the /attach stream");

        // The test owns this child (not the survival path), so reap it.
        let _ = child.kill();
        let _ = child.wait();
    }

    // Ring-replay: the Phase 2 fix for the Phase 1 subscribe-race. Write a marker
    // FIRST, give the shell time to echo it into the pane (and thus the ring),
    // and only THEN attach. The marker must come back from the replayed
    // scrollback even though no subscriber was connected when it was produced.
    #[test]
    #[ignore = "requires a built rmux-daemon binary via RMUX_DAEMON_E2E"]
    fn end_to_end_ring_replay_on_late_attach() {
        let exe = match std::env::var("RMUX_DAEMON_E2E") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => return,
        };
        assert!(exe.is_file(), "RMUX_DAEMON_E2E does not point at a file: {}", exe.display());

        let (child, port) = spawn_daemon(&exe).expect("spawn daemon + read port");
        let base_url = format!("http://127.0.0.1:{port}");
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let marker = "RMUX_RING_MARKER";

        let pane = rt.block_on(open_pane(&base_url, 80, 24, None)).expect("open pane");

        // Write WITHOUT any attached subscriber. CPR reply unblocks PSReadLine,
        // then the marker echo lands only in the ring (nobody is streaming).
        let write_url = format!("{base_url}/pane/{pane}/write");
        let post_data = |payload: String| {
            let url = write_url.clone();
            rt.block_on(async move {
                reqwest::Client::new()
                    .post(&url)
                    .json(&serde_json::json!({ "data": payload }))
                    .send()
                    .await
                    .expect("write")
                    .error_for_status()
                    .expect("write status");
            });
        };
        post_data("\x1b[1;1R".to_string());
        std::thread::sleep(Duration::from_millis(200));
        post_data(format!("echo {marker}\r"));

        // Let the shell finish echoing into the ring BEFORE attaching.
        std::thread::sleep(Duration::from_millis(800));

        // Attach LATE. The marker must arrive from the replayed ring.
        let attach_url = format!("{base_url}/pane/{pane}/attach");
        let seen = rt.block_on(async move {
            let resp = reqwest::Client::new().get(&attach_url).send().await.expect("attach");
            assert!(resp.status().is_success());
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                let Some(chunk) = stream.next().await else { break };
                let Ok(bytes) = chunk else { break };
                buf.extend_from_slice(&bytes);
                while let Some((kind, payload)) = take_frame(&mut buf) {
                    if kind == FRAME_DATA
                        && String::from_utf8_lossy(&payload).contains("RMUX_RING_MARKER")
                    {
                        return true;
                    }
                }
            }
            false
        });
        assert!(seen, "late attach did not replay the marker from the ring");

        let _ = child.kill();
        let _ = child.wait();
    }

    // Message bus (#136/#137) end-to-end against a live daemon: open a pane,
    // attach to its binary stream, publish a bus message TO that pane via
    // /bus/publish, and assert a FRAME_MSG (kind 3) arrives carrying the message
    // JSON. Exercises the real publish HTTP shape and the FRAME_MSG bridge wire
    // contract (the same `take_frame` the production bridge uses).
    #[test]
    #[ignore = "requires a built rmux-daemon binary via RMUX_DAEMON_E2E"]
    fn end_to_end_bus_message_arrives_as_frame_msg() {
        let exe = match std::env::var("RMUX_DAEMON_E2E") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => return,
        };
        assert!(exe.is_file(), "RMUX_DAEMON_E2E does not point at a file: {}", exe.display());

        let (child, port) = spawn_daemon(&exe).expect("spawn daemon + read port");
        let base_url = format!("http://127.0.0.1:{port}");
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let pane = rt.block_on(open_pane(&base_url, 80, 24, None)).expect("open pane");

        // Attach BEFORE publishing so the live broadcast reaches us (bus messages
        // are broadcast-only, never ringed, so a late attach would miss them).
        let attach_url = format!("{base_url}/pane/{pane}/attach");
        let reader = rt.spawn(async move {
            let resp = reqwest::Client::new().get(&attach_url).send().await.expect("attach");
            assert!(resp.status().is_success());
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let Some(chunk) = stream.next().await else { break };
                let Ok(bytes) = chunk else { break };
                buf.extend_from_slice(&bytes);
                while let Some((kind, payload)) = take_frame(&mut buf) {
                    if kind == FRAME_MSG {
                        // The payload is the serialized BusMessage; assert it round
                        // trips and carries our marker type.
                        let v: Value = serde_json::from_slice(&payload).expect("msg json");
                        if v.get("type").and_then(Value::as_str) == Some("e2e-ping") {
                            return true;
                        }
                    }
                }
            }
            false
        });

        // Give the subscriber a beat to connect before publishing.
        std::thread::sleep(Duration::from_millis(400));

        // Publish directly to the pane id via /bus/publish (the same HTTP shape
        // `bus_publish_forwarded` produces). `from` is a fictitious sender; a
        // direct pane-id target is delivered even to self, but here from != pane.
        let publish_url = format!("{base_url}/bus/publish");
        let published = rt.block_on(async {
            reqwest::Client::new()
                .post(&publish_url)
                .json(&serde_json::json!({
                    "from": 999,
                    "to": pane,
                    "type": "e2e-ping",
                    "payload": { "hello": "world" },
                    "inject": false
                }))
                .send()
                .await
                .expect("publish")
                .error_for_status()
                .expect("publish status")
                .json::<Value>()
                .await
                .expect("publish json")
        });
        assert_eq!(published["delivered"].as_u64(), Some(1), "delivered to the one target pane");

        let seen = rt.block_on(reader).expect("reader task");
        assert!(seen, "did not observe the bus message as a FRAME_MSG on /attach");

        let _ = child.kill();
        let _ = child.wait();
    }

    // Session/window grouping verbs (#130) end-to-end against a live daemon:
    // create a session, add a second window, split it, assert /session/list
    // reflects the tree, then kill the session and assert every pane is reaped.
    #[test]
    #[ignore = "requires a built rmux-daemon binary via RMUX_DAEMON_E2E"]
    fn end_to_end_session_window_lifecycle() {
        let exe = match std::env::var("RMUX_DAEMON_E2E") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => return,
        };
        assert!(exe.is_file(), "RMUX_DAEMON_E2E does not point at a file: {}", exe.display());

        let (child, port) = spawn_daemon(&exe).expect("spawn daemon + read port");
        let base = format!("http://127.0.0.1:{port}");
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let client = reqwest::Client::new();

        let post = |url: String, body: Value| {
            let client = client.clone();
            rt.block_on(async move {
                client.post(&url).json(&body).send().await.expect("post")
                    .error_for_status().expect("status")
                    .json::<Value>().await.unwrap_or(Value::Null)
            })
        };
        let get = |url: String| {
            let client = client.clone();
            rt.block_on(async move {
                client.get(&url).send().await.expect("get")
                    .error_for_status().expect("status")
                    .json::<Value>().await.expect("json")
            })
        };

        // Create a session (1 window, 1 pane).
        let created = post(format!("{base}/session/new"), serde_json::json!({ "name": "work" }));
        let session_id = created["session_id"].as_u64().expect("session_id");

        // Add a second window (another pane).
        let win2 = post(format!("{base}/session/{session_id}/window/new"), serde_json::json!({}));
        let window2_id = win2["window_id"].as_u64().expect("window_id");

        // Split the second window (a sibling pane).
        let _ = post(
            format!("{base}/window/{window2_id}/split"),
            serde_json::json!({ "dir": "row" }),
        );

        // List: one session, two windows, three panes total.
        let list = get(format!("{base}/session/list"));
        let sessions = list.as_array().expect("array");
        assert_eq!(sessions.len(), 1, "exactly one session");
        let windows = sessions[0]["windows"].as_array().expect("windows");
        assert_eq!(windows.len(), 2, "two windows");
        let total_panes: usize = windows
            .iter()
            .map(|w| w["panes"].as_array().map(|p| p.len()).unwrap_or(0))
            .sum();
        assert_eq!(total_panes, 3, "three panes (1 + 1 + split)");

        // Health reflects the live panes.
        let health = get(format!("{base}/health"));
        assert_eq!(health["panes"].as_u64(), Some(3));
        assert_eq!(health["sessions"].as_u64(), Some(1));

        // Kill the session: all three panes reaped.
        let _ = rt.block_on(async {
            client.post(format!("{base}/session/{session_id}/kill"))
                .send().await.expect("kill").error_for_status().expect("kill status")
        });
        let health = get(format!("{base}/health"));
        assert_eq!(health["panes"].as_u64(), Some(0), "all panes reaped on kill");
        assert_eq!(health["sessions"].as_u64(), Some(0), "session gone");

        let _ = child.kill();
        let _ = child.wait();
    }
}
