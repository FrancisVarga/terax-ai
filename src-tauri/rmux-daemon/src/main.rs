//! Out-of-process PTY daemon sidecar (#110).
//!
//! Owns the live shell sessions ("panes") for the terminal-rmux feature out of
//! the Terax app process and serves them over a loopback HTTP API:
//!   - `POST /pane/open`         spawn a shell, return its pane id,
//!   - `POST /pane/<id>/write`   feed input to a pane's shell,
//!   - `POST /pane/<id>/resize`  resize a pane's PTY,
//!   - `POST /pane/<id>/close`   kill a pane's shell and forget it,
//!   - `POST /pane/<id>/detach`  client detach (PTY keeps running; ring retains),
//!   - `GET  /pane/<id>/attach`  stream output as length-prefixed binary frames,
//!   - `session.*` / `window.*`  named-session grouping over the pane registry,
//!   - `GET  /health`            daemon pid + live pane and session counts.
//!
//! The server binds 127.0.0.1 only — loopback is the trust boundary, same as the
//! otel-collector sidecar this binary is modelled on.
//!
//! The shell-spawn + reader code is shared with the in-process Tauri path via
//! `terax_lib::modules::pty::spawn_session`, so the daemon and app can never
//! diverge on PTY behavior. This binary only adds the HTTP transport, the pane
//! registry + session grouping, and the broadcast fan-out + ring that turn one
//! shell's output into many attach subscribers with replay.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use portable_pty::PtySize;
use serde::Deserialize;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use terax_lib::modules::pty::{spawn_session, AgentSignal, PtyOutputSink, Session};
use terax_lib::modules::workspace::WorkspaceEnv;

/// Capacity of a pane's output broadcast channel. Shell output can burst (a
/// `cat` of a large file), so this is generous: a lagging stream subscriber
/// drops the oldest frames rather than stalling the reader thread, and the
/// client repaints from the live tail. 1024 frames is ample headroom.
const PANE_CHANNEL_CAP: usize = 1024;

/// Per-pane scrollback ring cap in BYTES (sum of `Data` payloads). On attach the
/// ring is replayed so a client that connects after output began still sees
/// recent scrollback. 256 KiB is ~tens of full screens — enough to restore
/// context on reattach without unbounded memory per pane.
const RING_MAX_BYTES: usize = 256 * 1024;

/// One frame of pane output. Crosses the broadcast channel AND is stored in the
/// per-pane ring for replay-on-attach, so both the live and replay paths encode
/// through the same `encode_frame`. `Agent` carries already-serialized JSON so
/// the payload stays `Clone` and cheap.
#[derive(Clone)]
enum OutFrame {
    Data(Vec<u8>),
    Agent(String),
    Exit(i32),
}

/// Bounded per-pane scrollback. Holds recent frames up to `RING_MAX_BYTES` of
/// `Data` payload; `Agent`/`Exit` frames are tiny and not byte-counted. Oldest
/// frames are evicted first. Replayed in order on attach.
struct Ring {
    frames: std::collections::VecDeque<OutFrame>,
    bytes: usize,
}

impl Ring {
    fn new() -> Self {
        Self { frames: std::collections::VecDeque::new(), bytes: 0 }
    }

    fn push(&mut self, frame: OutFrame) {
        if let OutFrame::Data(b) = &frame {
            self.bytes += b.len();
        }
        self.frames.push_back(frame);
        while self.bytes > RING_MAX_BYTES {
            match self.frames.pop_front() {
                Some(OutFrame::Data(b)) => self.bytes -= b.len(),
                Some(_) => {}
                None => break,
            }
        }
    }

    fn snapshot(&self) -> Vec<OutFrame> {
        self.frames.iter().cloned().collect()
    }
}

/// A pane's output fan-out: the scrollback ring and the live broadcast sender,
/// guarded together by ONE mutex so an append (ring push + broadcast send) is
/// atomic against an attach (ring snapshot + subscribe). That atomicity is what
/// closes the Phase 1 subscribe-race: no frame can slip between a new
/// subscriber's snapshot and its broadcast subscription.
struct PaneOutput {
    ring: Ring,
    tx: broadcast::Sender<OutFrame>,
}

/// A live pane: its shell session (dropping the `Arc` kills the child) and the
/// output fan-out (ring + broadcast) behind a single mutex.
struct PaneEntry {
    session: Arc<Session>,
    output: Arc<Mutex<PaneOutput>>,
}

/// A window: a Terax terminal tab. Holds the ids of the panes that live in it
/// (ids into `DaemonState::panes`); it does NOT own pane state. The pane tree
/// geometry (which split is row vs col) is the frontend `panes.ts`'s concern;
/// the daemon only tracks membership.
struct WindowEntry {
    id: u32,
    name: Option<String>,
    panes: Vec<u32>,
}

/// A named session: a group of windows (tmux session). Pure grouping index over
/// pane ids; the single source of truth for a pane is still `DaemonState::panes`.
struct SessionEntry {
    name: String,
    windows: Vec<WindowEntry>,
}

impl SessionEntry {
    /// Every pane id owned across all windows of this session.
    fn pane_ids(&self) -> Vec<u32> {
        self.windows.iter().flat_map(|w| w.panes.iter().copied()).collect()
    }
}

/// Daemon-wide state shared across all connection tasks.
struct DaemonState {
    panes: Mutex<HashMap<u32, PaneEntry>>,
    // Named session -> windows -> pane ids. A grouping layer over `panes`; never
    // duplicates pane state.
    sessions: Mutex<HashMap<u32, SessionEntry>>,
    // Single monotonic id space for sessions, windows, AND panes, so no id of any
    // kind ever collides. Starts at 1 (the frontend treats 0 as "unset"). Ids are
    // never reused.
    next_id: AtomicU32,
}

impl DaemonState {
    fn new() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

/// Output sink for one pane: under the pane's single output mutex, appends each
/// event to the scrollback ring AND broadcasts it to live subscribers in one
/// atomic step. Holding the lock across both is what makes an append serialize
/// against an attach (snapshot + subscribe under the same lock), closing the
/// subscribe-race. The broadcast send is best-effort — with no live subscriber
/// it errors and is dropped, which is correct (the ring still retains it).
///
/// The reader/waiter threads inside `spawn_session` are OS threads, not async
/// tasks; `parking_lot::Mutex` + `broadcast::Sender` are `Send + Sync`, so
/// pushing from those threads needs no runtime handle.
struct PaneSink(Arc<Mutex<PaneOutput>>);

impl PaneSink {
    fn emit(&self, frame: OutFrame) {
        let mut out = self.0.lock_safe();
        out.ring.push(frame.clone());
        let _ = out.tx.send(frame);
    }
}

impl PtyOutputSink for PaneSink {
    fn data(&self, bytes: Vec<u8>) {
        self.emit(OutFrame::Data(bytes));
    }

    fn agent(&self, signal: AgentSignal) {
        let json = serde_json::to_string(&signal).unwrap_or_else(|_| "null".to_string());
        self.emit(OutFrame::Agent(json));
    }

    fn exit(&self, code: i32) {
        self.emit(OutFrame::Exit(code));
    }
}

fn main() {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("rmux-daemon: failed to build runtime: {e}");
            std::process::exit(1);
        }
    };

    rt.block_on(run());
}

async fn run() {
    let state = Arc::new(DaemonState::new());

    // Ephemeral port: the OS picks a free loopback port and we print it on
    // stdout so the parent app can read it back. Loopback-only is the trust
    // boundary; no port needs to be fixed or guessed.
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("rmux-daemon: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    let local = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rmux-daemon: cannot read local addr: {e}");
            std::process::exit(1);
        }
    };
    // Machine-readable line the parent parses to learn the port, plus a human
    // line on stderr for log scraping. stdout MUST be flushed explicitly: when
    // the parent captures it via a pipe (not a tty) Rust block-buffers stdout,
    // so without this flush the port line sits in the buffer and the parent's
    // port-read blocks forever while the daemon sits in the accept loop below.
    println!("rmux-daemon: listening port={}", local.port());
    let _ = std::io::stdout().flush();
    eprintln!("rmux-daemon: listening on http://{local}");

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("rmux-daemon: accept failed: {e}");
                continue;
            }
        };
        let io = TokioIo::new(stream);
        let state = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone()));
            // SSE connections are long-lived; http1 keep-alive (default) holds
            // them open for the duration of the stream.
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                // Client disconnects on a long-lived SSE stream are normal.
                let _ = e;
            }
        });
    }
}

type Body = BoxBody<Bytes, Infallible>;

#[derive(Deserialize)]
struct OpenReq {
    cols: u16,
    rows: u16,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct WriteReq {
    data: String,
}

#[derive(Deserialize)]
struct ResizeReq {
    cols: u16,
    rows: u16,
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    state: Arc<DaemonState>,
) -> Result<Response<Body>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == Method::GET && path == "/health" {
        return Ok(health(&state));
    }

    if method == Method::POST && path == "/pane/open" {
        return Ok(open_pane(req, state).await);
    }

    if method == Method::POST && path == "/session/new" {
        return Ok(session_new(req, state).await);
    }
    if method == Method::GET && path == "/session/list" {
        return Ok(session_list(&state));
    }

    // Per-pane routes: /pane/<id>/<verb>.
    if let Some(rest) = path.strip_prefix("/pane/") {
        if let Some((id_str, verb)) = rest.split_once('/') {
            if let Ok(id) = id_str.parse::<u32>() {
                match (&method, verb) {
                    (&Method::GET, "attach") => return Ok(attach_pane(&state, id)),
                    (&Method::POST, "write") => return Ok(write_pane(req, &state, id).await),
                    (&Method::POST, "resize") => return Ok(resize_pane(req, &state, id).await),
                    (&Method::POST, "close") => return Ok(close_pane(&state, id)),
                    (&Method::POST, "detach") => return Ok(detach_pane(&state, id)),
                    _ => {}
                }
            }
        }
    }

    // Per-session routes: /session/<id>/<verb> (and the nested window/new).
    if let Some(rest) = path.strip_prefix("/session/") {
        if let Some((id_str, tail)) = rest.split_once('/') {
            if let Ok(id) = id_str.parse::<u32>() {
                match (&method, tail) {
                    (&Method::POST, "rename") => return Ok(session_rename(req, &state, id).await),
                    (&Method::POST, "kill") => return Ok(session_kill(&state, id)),
                    (&Method::POST, "window/new") => return Ok(window_new(req, state, id).await),
                    _ => {}
                }
            }
        }
    }

    // Per-window route: /window/<id>/split.
    if let Some(rest) = path.strip_prefix("/window/") {
        if let Some((id_str, verb)) = rest.split_once('/') {
            if let Ok(id) = id_str.parse::<u32>() {
                if method == Method::POST && verb == "split" {
                    return Ok(window_split(req, state, id).await);
                }
            }
        }
    }

    Ok(text(StatusCode::NOT_FOUND, "not found"))
}

fn health(state: &DaemonState) -> Response<Body> {
    let panes = state.panes.lock_safe().len();
    let sessions = state.sessions.lock_safe().len();
    let json = serde_json::json!({
        "daemon_pid": std::process::id(),
        "panes": panes,
        "sessions": sessions,
    });
    json_response(StatusCode::OK, &json)
}

/// Spawn one shell pane and register it: allocate an id, wire its ring +
/// broadcast + output sink, run the blocking `spawn_session` off the async
/// worker, and insert the `PaneEntry`. This is the single pane-creation path —
/// `open_pane` (the raw HTTP verb) and the session/window verbs all funnel
/// through here so a pane is built exactly one way. Returns the new pane id or a
/// human-readable error string (the callers map it to the right HTTP status).
async fn spawn_pane(
    state: &Arc<DaemonState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, _rx) = broadcast::channel::<OutFrame>(PANE_CHANNEL_CAP);
    let output = Arc::new(Mutex::new(PaneOutput { ring: Ring::new(), tx }));
    let sink: Arc<dyn PtyOutputSink> = Arc::new(PaneSink(output.clone()));

    // Spawn the shell. `spawn_session` does blocking PTY setup; run it off the
    // async worker so the reactor thread is never blocked on ConPTY/openpty.
    let spawn = tokio::task::spawn_blocking(move || {
        spawn_session(id, cols, rows, cwd, WorkspaceEnv::default(), sink).map(|(s, _)| s)
    })
    .await;

    let session = match spawn {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("spawn failed: {e}")),
        Err(e) => return Err(format!("spawn join failed: {e}")),
    };

    state.panes.lock_safe().insert(id, PaneEntry { session, output });
    Ok(id)
}

async fn open_pane(
    req: Request<hyper::body::Incoming>,
    state: Arc<DaemonState>,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let open: OpenReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };

    match spawn_pane(&state, open.cols, open.rows, open.cwd).await {
        Ok(id) => json_response(StatusCode::OK, &serde_json::json!({ "pane_id": id })),
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

// Default geometry for panes opened by the session/window verbs (the frontend
// resizes immediately on attach, so this is only the pre-attach size).
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

#[derive(Deserialize)]
struct SessionNewReq {
    name: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

#[derive(Deserialize, Default)]
struct WindowNewReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct SplitReq {
    /// "row" | "col". Recorded for the frontend; the daemon only tracks pane
    /// membership, not geometry, so any other value is rejected to catch typos.
    dir: String,
}

/// POST /session/new {name, cwd?} -> {session_id, window_id, pane_id}. Creates a
/// session with one window holding one freshly spawned pane.
async fn session_new(req: Request<hyper::body::Incoming>, state: Arc<DaemonState>) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let new: SessionNewReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };
    let pane_id = match spawn_pane(&state, DEFAULT_COLS, DEFAULT_ROWS, new.cwd).await {
        Ok(id) => id,
        Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let window_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.lock_safe().insert(
        session_id,
        SessionEntry {
            name: new.name,
            windows: vec![WindowEntry { id: window_id, name: None, panes: vec![pane_id] }],
        },
    );
    json_response(
        StatusCode::OK,
        &serde_json::json!({ "session_id": session_id, "window_id": window_id, "pane_id": pane_id }),
    )
}

/// GET /session/list -> the full session/window/pane tree.
fn session_list(state: &DaemonState) -> Response<Body> {
    let sessions = state.sessions.lock_safe();
    let list: Vec<Value> = sessions
        .iter()
        .map(|(id, s)| {
            let windows: Vec<Value> = s
                .windows
                .iter()
                .map(|w| serde_json::json!({ "id": w.id, "name": w.name, "panes": w.panes }))
                .collect();
            serde_json::json!({ "id": id, "name": s.name, "windows": windows })
        })
        .collect();
    json_response(StatusCode::OK, &serde_json::json!(list))
}

/// POST /session/<id>/rename {name} -> ok.
async fn session_rename(
    req: Request<hyper::body::Incoming>,
    state: &DaemonState,
    id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let rename: RenameReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };
    let mut sessions = state.sessions.lock_safe();
    match sessions.get_mut(&id) {
        Some(s) => {
            s.name = rename.name;
            text(StatusCode::OK, "ok")
        }
        None => text(StatusCode::NOT_FOUND, "no session"),
    }
}

/// POST /session/<id>/kill -> ok. Removes the session AND reaps every pane it
/// owns (removing each from `panes` drops its `Arc<Session>`, killing the child).
fn session_kill(state: &DaemonState, id: u32) -> Response<Body> {
    let entry = state.sessions.lock_safe().remove(&id);
    let Some(entry) = entry else {
        return text(StatusCode::NOT_FOUND, "no session");
    };
    let mut panes = state.panes.lock_safe();
    for pane_id in entry.pane_ids() {
        panes.remove(&pane_id);
    }
    text(StatusCode::OK, "ok")
}

/// POST /session/<id>/window/new {name?, cwd?} -> {window_id, pane_id}. Adds a
/// window with a freshly spawned pane to an existing session.
async fn window_new(
    req: Request<hyper::body::Incoming>,
    state: Arc<DaemonState>,
    session_id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let new: WindowNewReq = if body.is_empty() {
        WindowNewReq::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
        }
    };
    // Reject early if the session is unknown, BEFORE spawning a shell we would
    // then have to reap.
    if !state.sessions.lock_safe().contains_key(&session_id) {
        return text(StatusCode::NOT_FOUND, "no session");
    }
    let pane_id = match spawn_pane(&state, DEFAULT_COLS, DEFAULT_ROWS, new.cwd).await {
        Ok(id) => id,
        Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let window_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let mut sessions = state.sessions.lock_safe();
    match sessions.get_mut(&session_id) {
        Some(s) => {
            s.windows.push(WindowEntry { id: window_id, name: new.name, panes: vec![pane_id] });
            json_response(
                StatusCode::OK,
                &serde_json::json!({ "window_id": window_id, "pane_id": pane_id }),
            )
        }
        // Raced with a kill between the contains_key check and here: reap the
        // orphan pane we just spawned so it does not leak.
        None => {
            state.panes.lock_safe().remove(&pane_id);
            text(StatusCode::NOT_FOUND, "no session")
        }
    }
}

/// POST /window/<id>/split {dir} -> {pane_id}. Adds a sibling pane to the window.
async fn window_split(
    req: Request<hyper::body::Incoming>,
    state: Arc<DaemonState>,
    window_id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let split: SplitReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };
    if split.dir != "row" && split.dir != "col" {
        return text(StatusCode::BAD_REQUEST, "dir must be row or col");
    }
    // Locate the owning session up front; reject before spawning if unknown.
    let known = state
        .sessions
        .lock_safe()
        .values()
        .any(|s| s.windows.iter().any(|w| w.id == window_id));
    if !known {
        return text(StatusCode::NOT_FOUND, "no window");
    }
    let pane_id = match spawn_pane(&state, DEFAULT_COLS, DEFAULT_ROWS, None).await {
        Ok(id) => id,
        Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let mut sessions = state.sessions.lock_safe();
    let window = sessions
        .values_mut()
        .flat_map(|s| s.windows.iter_mut())
        .find(|w| w.id == window_id);
    match window {
        Some(w) => {
            w.panes.push(pane_id);
            json_response(StatusCode::OK, &serde_json::json!({ "pane_id": pane_id }))
        }
        None => {
            state.panes.lock_safe().remove(&pane_id);
            text(StatusCode::NOT_FOUND, "no window")
        }
    }
}

/// POST /pane/<id>/detach -> ok. Detach is a CLIENT concept: the PTY keeps
/// running and its ring keeps retaining output regardless, so the daemon only
/// confirms the pane exists. A later attach replays the ring.
fn detach_pane(state: &DaemonState, id: u32) -> Response<Body> {
    if state.panes.lock_safe().contains_key(&id) {
        text(StatusCode::OK, "ok")
    } else {
        text(StatusCode::NOT_FOUND, "no pane")
    }
}

async fn write_pane(
    req: Request<hyper::body::Incoming>,
    state: &DaemonState,
    id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let write: WriteReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };

    // Clone the writer Arc out of the map so the shell output bytes are written
    // without holding the panes lock across the (blocking) pipe write.
    let writer = {
        let panes = state.panes.lock_safe();
        match panes.get(&id) {
            Some(p) => p.session.writer.clone(),
            None => return text(StatusCode::NOT_FOUND, "no pane"),
        }
    };
    // Bind to a local so the MutexGuard temporary drops before `writer` — see
    // rustc note on tail-expression temporary drop order.
    let result = writer.lock_safe().write_all(write.data.as_bytes());
    match result {
        Ok(()) => text(StatusCode::OK, "ok"),
        // EPIPE is expected once the child has exited.
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &format!("write failed: {e}")),
    }
}

async fn resize_pane(
    req: Request<hyper::body::Incoming>,
    state: &DaemonState,
    id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let resize: ResizeReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };

    let master = {
        let panes = state.panes.lock_safe();
        match panes.get(&id) {
            Some(p) => p.session.clone(),
            None => return text(StatusCode::NOT_FOUND, "no pane"),
        }
    };
    let result = master.master.lock_safe().resize(PtySize {
        rows: resize.rows,
        cols: resize.cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    match result {
        Ok(()) => text(StatusCode::OK, "ok"),
        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &format!("resize failed: {e}")),
    }
}

fn close_pane(state: &DaemonState, id: u32) -> Response<Body> {
    // Removing the entry drops its `Arc<Session>`; `Session`'s Drop kills the
    // child, the reader hits EOF, and its threads unwind.
    let removed = state.panes.lock_safe().remove(&id);
    match removed {
        Some(_) => text(StatusCode::OK, "ok"),
        None => text(StatusCode::NOT_FOUND, "no pane"),
    }
}

/// Attach to a pane's output: REPLAY the scrollback ring, then STREAM live
/// frames, as one continuous binary body. Frame format is
/// `[u8 kind][u32 LE len][len bytes]` (kind 0 = data raw bytes, 1 = agent JSON,
/// 2 = exit code) — no base64, no text framing.
///
/// Atomicity (the subscribe-race fix): the ring snapshot AND the broadcast
/// subscribe happen under the pane's single output mutex, which `PaneSink::emit`
/// also takes to append-and-broadcast. So no frame can land between the snapshot
/// and the subscription: the replayed ring and the live tail are exactly
/// contiguous, with no gap and no duplicate.
fn attach_pane(state: &DaemonState, id: u32) -> Response<Body> {
    let (replay, rx) = {
        let panes = state.panes.lock_safe();
        let entry = match panes.get(&id) {
            Some(p) => p,
            None => return text(StatusCode::NOT_FOUND, "no pane"),
        };
        let out = entry.output.lock_safe();
        (out.ring.snapshot(), out.tx.subscribe())
    };

    use futures_util::stream;
    // State threaded through `unfold`: the not-yet-sent replay frames (drained
    // first) and the live broadcast receiver.
    let init = (replay.into_iter(), rx);
    let body_stream = stream::unfold(init, |(mut replay, mut rx)| async move {
        // Drain the replay snapshot first.
        if let Some(frame) = replay.next() {
            return Some((Ok(Frame::data(encode_frame(&frame))), (replay, rx)));
        }
        // Then the live tail.
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    return Some((Ok(Frame::data(encode_frame(&frame))), (replay, rx)));
                }
                // Lagged: the live producer outran this subscriber. Skip the
                // missed frames and keep streaming; the client repaints from the
                // tail (and still has the replayed scrollback).
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // Sender gone (pane closed / child exited): end the stream.
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    let body = StreamBody::new(body_stream).boxed();
    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "application/octet-stream")
        .header(hyper::header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap()
}

/// Encode one frame as `[u8 kind][u32 LE len][payload]`. kind 0 = data (raw PTY
/// bytes, NOT base64), 1 = agent (JSON), 2 = exit (the code as 4-byte LE i32).
fn encode_frame(frame: &OutFrame) -> Bytes {
    let (kind, payload): (u8, Vec<u8>) = match frame {
        OutFrame::Data(bytes) => (0, bytes.clone()),
        OutFrame::Agent(json) => (1, json.as_bytes().to_vec()),
        OutFrame::Exit(code) => (2, code.to_le_bytes().to_vec()),
    };
    let mut out = Vec::with_capacity(1 + 4 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    Bytes::from(out)
}

async fn collect_body(
    req: Request<hyper::body::Incoming>,
) -> Result<Bytes, Response<Body>> {
    match req.into_body().collect().await {
        Ok(b) => Ok(b.to_bytes()),
        Err(_) => Err(text(StatusCode::BAD_REQUEST, "read body failed")),
    }
}

fn json_response(status: StatusCode, value: &serde_json::Value) -> Response<Body> {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(full(bytes))
        .unwrap()
}

fn full(bytes: Vec<u8>) -> Body {
    Full::new(Bytes::from(bytes)).boxed()
}

fn text(status: StatusCode, msg: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "text/plain")
        .body(full(msg.as_bytes().to_vec()))
        .unwrap()
}

/// Lock helper mirroring the app's `MutexExt::lock_safe`: a poisoned PTY mutex
/// means a thread panicked mid-write, but the protected pipe/handle is still
/// usable, so recovering the guard is correct rather than propagating the
/// poison and killing the daemon.
trait MutexExt<T> {
    fn lock_safe(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_safe(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure index integrity: the session/window tree is a grouping over pane ids
    // and these ops never touch real shells, so they unit-test without spawning.
    fn session(name: &str, windows: Vec<WindowEntry>) -> SessionEntry {
        SessionEntry { name: name.to_string(), windows }
    }
    fn window(id: u32, panes: Vec<u32>) -> WindowEntry {
        WindowEntry { id, name: None, panes }
    }

    #[test]
    fn new_session_shape_is_one_window_one_pane() {
        // Mirrors what session_new builds before any split/window-new.
        let s = session("work", vec![window(2, vec![3])]);
        assert_eq!(s.windows.len(), 1);
        assert_eq!(s.windows[0].panes, vec![3]);
        assert_eq!(s.pane_ids(), vec![3]);
    }

    #[test]
    fn pane_ids_flattens_all_windows() {
        let s = session("multi", vec![window(2, vec![3, 4]), window(5, vec![6])]);
        assert_eq!(s.pane_ids(), vec![3, 4, 6]);
    }

    #[test]
    fn split_appends_sibling_pane_to_window() {
        // The mutation window_split performs once the window is located.
        let mut s = session("s", vec![window(2, vec![3])]);
        s.windows[0].panes.push(7);
        assert_eq!(s.windows[0].panes, vec![3, 7]);
        assert_eq!(s.pane_ids(), vec![3, 7]);
    }

    #[test]
    fn kill_reaps_every_pane_id_the_session_owns() {
        // session_kill removes each pane_id from the panes map; assert the set it
        // would reap is exactly the session's panes across all windows.
        let s = session("s", vec![window(2, vec![3, 4]), window(5, vec![6])]);
        let mut reaped: Vec<u32> = s.pane_ids();
        reaped.sort_unstable();
        assert_eq!(reaped, vec![3, 4, 6]);
    }
}
