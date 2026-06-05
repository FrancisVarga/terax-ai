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

// In-pane `rmux msg` CLI (#139). A second role of this binary: an agent runs it
// INSIDE a pane's shell to drive the message bus over the daemon's loopback HTTP
// API, with no Tauri UI. Kept in its own module so the server code above is
// unaffected; reached only via the argv branch in `main`.
mod msg;

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
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

/// Per-pane message inbox cap (#136). The inbox is the DURABLE store for the
/// message bus — a target pane's messages survive until the consumer acks them,
/// even with no live `/attach` subscriber. It is bounded so a never-acking pane
/// (e.g. a crashed agent) cannot grow memory without limit; on overflow the
/// OLDEST message is dropped (a fresh message is more actionable than a stale
/// one). 1000 messages is generous for coordination traffic.
const INBOX_MAX: usize = 1000;

/// One frame of pane output. Crosses the broadcast channel AND (for terminal
/// output) is stored in the per-pane ring for replay-on-attach, so both the live
/// and replay paths encode through the same `encode_frame`. `Agent`/`Msg` carry
/// already-serialized JSON so the payload stays `Clone` and cheap.
#[derive(Clone)]
enum OutFrame {
    Data(Vec<u8>),
    Agent(String),
    Exit(i32),
    /// A bus message (#136), carrying serialized `BusMessage` JSON. Unlike the
    /// other variants this is NEVER pushed to the ring — it is emitted to the
    /// broadcast only (live `/attach` delivery). The durable copy lives in the
    /// target pane's `inbox`; ringing it would (a) replay stale inter-agent
    /// messages on every reattach and (b) evict real terminal scrollback.
    Msg(String),
}

/// One message on the rmux message bus (#136). Minted by the daemon on delivery:
/// the daemon assigns the `id`/`ts` and echoes the caller's routing fields, so a
/// message is self-describing once it lands in an inbox or crosses an attach
/// stream. Serialized to JSON for both the inbox snapshot and the `OutFrame::Msg`
/// broadcast payload, so a CLI agent and a live attach client see the same shape.
#[derive(Clone, Serialize)]
struct BusMessage {
    /// Daemon-assigned id (from `next_id`), unique across the whole daemon.
    id: u32,
    /// Sender pane id (the caller passes its own `from`; the daemon does not
    /// authenticate it — loopback is the trust boundary).
    from: u32,
    /// The caller's original target, echoed verbatim as JSON (a pane id number,
    /// `{"session": name}`, `{"window": name}`, or `"*"`). Lets a fan-out
    /// recipient see what broadcast group it was part of.
    to: Value,
    /// Application-defined message type. Serialized as `"type"` (a Rust reserved
    /// word, hence the rename) to keep the JSON ergonomic for agents.
    #[serde(rename = "type")]
    msg_type: String,
    /// Opaque application payload — the daemon never interprets it.
    payload: Value,
    /// Whether the message was also injected into the target shell's stdin.
    /// Echoed so a consumer reading the inbox knows it may already have seen the
    /// message inline in its terminal.
    inject: bool,
    /// Unix-epoch milliseconds the daemon minted the message. The daemon may read
    /// real wall-clock time (it is a long-lived process, not a deterministic
    /// workflow), so `SystemTime::now()` is correct here.
    ts: u64,
}

/// Bounded per-pane scrollback. Holds recent frames up to `RING_MAX_BYTES` of
/// `Data` payload; `Agent`/`Exit` frames are tiny and not byte-counted. Oldest
/// frames are evicted first. Replayed in order on attach. Bus `Msg` frames are
/// never stored here — see `OutFrame::Msg`.
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

/// A live pane: its shell session (dropping the `Arc` kills the child), the
/// output fan-out (ring + broadcast) behind a single mutex, and the message-bus
/// inbox (#136). The inbox is per-entry so it is auto-reaped when the pane is
/// closed (the whole entry is removed from `panes`) — no separate cleanup path.
struct PaneEntry {
    session: Arc<Session>,
    output: Arc<Mutex<PaneOutput>>,
    /// Durable bus-message store for this pane (#136). A delivered message is
    /// pushed here AND broadcast as an `OutFrame::Msg`; the broadcast is
    /// live-only, so the inbox is the source of truth a consumer drains via
    /// `/pane/<id>/inbox` + `inbox/ack`. Bounded by `INBOX_MAX` (drop-oldest).
    inbox: Mutex<VecDeque<BusMessage>>,
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
    // The daemon's own loopback URL (`http://127.0.0.1:<bound port>`), known only
    // AFTER bind. Injected into each spawned pane's env as `RMUX_DAEMON_URL` (#139)
    // so an in-pane `rmux msg` CLI can reach the bus without the Terax UI. Set once
    // in `run()`; empty before that (no pane is ever spawned pre-bind).
    daemon_url: String,
}

impl DaemonState {
    fn new(daemon_url: String) -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            daemon_url,
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
    // One binary, two roles (#139). The DEFAULT role (no/other args) is the PTY
    // daemon server — byte-identical to before. The `msg` SUBCOMMAND turns the
    // SAME binary into an in-pane CLI an agent runs INSIDE a pane's shell to use
    // the message bus without the Terax UI. Shipping it as a subcommand (not a new
    // externalBin) avoids the WiX/placeholder-ordering traps a fresh sidecar hits.
    //
    // We branch on argv[1] BEFORE building the tokio runtime: the CLI talks to an
    // already-running daemon over a tiny blocking std TcpStream HTTP client, so it
    // needs no async runtime of its own. Only the server role spins up tokio.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("msg") {
        std::process::exit(msg::run_cli(&args[2..]));
    }

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

    // Build state AFTER bind so it carries the daemon's own loopback URL: each
    // spawned pane gets `RMUX_DAEMON_URL` pointing here so an in-pane `rmux msg`
    // CLI can reach the bus (#139). The URL can only be known once the OS has
    // assigned the ephemeral port above.
    let state = Arc::new(DaemonState::new(format!("http://127.0.0.1:{}", local.port())));
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

/// Body of `POST /pane/<id>/message` (#136): a direct send to one pane. The
/// sender passes its own `from`; the target is the path id, so there is no `to`
/// field here.
#[derive(Deserialize)]
struct PaneMessageReq {
    from: u32,
    #[serde(rename = "type")]
    msg_type: String,
    payload: Value,
    /// Default false: most messages are inbox-only and do not interrupt the
    /// target shell's input stream.
    #[serde(default)]
    inject: bool,
}

/// Body of `POST /bus/publish` (#136): a routed send. `to` selects the target
/// set: a number (pane id), `{"session": name}`, `{"window": name}`, or `"*"`.
#[derive(Deserialize)]
struct BusPublishReq {
    from: u32,
    to: Value,
    #[serde(rename = "type")]
    msg_type: String,
    payload: Value,
    #[serde(default)]
    inject: bool,
}

/// Body of `POST /pane/<id>/inbox/ack` (#136): drain acked messages. `ids`
/// absent/null drains the WHOLE inbox; `ids` present drains only those ids.
#[derive(Deserialize, Default)]
struct InboxAckReq {
    #[serde(default)]
    ids: Option<Vec<u32>>,
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

    if method == Method::POST && path == "/bus/publish" {
        return Ok(bus_publish(req, state).await);
    }

    if method == Method::POST && path == "/session/new" {
        return Ok(session_new(req, state).await);
    }
    if method == Method::GET && path == "/session/list" {
        return Ok(session_list(&state));
    }

    // Per-pane routes: /pane/<id>/<verb> (and the nested inbox/ack, #136). The
    // `verb` here is the FIRST segment after the id, so `inbox/ack` arrives as
    // verb = "inbox", tail = "ack" — handled like /session/<id>/window/new does.
    if let Some(rest) = path.strip_prefix("/pane/") {
        if let Some((id_str, verb)) = rest.split_once('/') {
            if let Ok(id) = id_str.parse::<u32>() {
                match (&method, verb) {
                    (&Method::GET, "attach") => return Ok(attach_pane(&state, id)),
                    (&Method::POST, "write") => return Ok(write_pane(req, &state, id).await),
                    (&Method::POST, "resize") => return Ok(resize_pane(req, &state, id).await),
                    (&Method::POST, "close") => return Ok(close_pane(&state, id)),
                    (&Method::POST, "detach") => return Ok(detach_pane(&state, id)),
                    (&Method::POST, "message") => return Ok(pane_message(req, state, id).await),
                    (&Method::GET, "inbox") => return Ok(pane_inbox(&state, id)),
                    (&Method::POST, "inbox/ack") => return Ok(pane_inbox_ack(req, &state, id).await),
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
    let (panes, messages) = {
        let panes = state.panes.lock_safe();
        // Total undelivered bus messages across all inboxes (#136): a quick
        // liveness signal for the message bus, summed under the panes lock.
        let messages: usize = panes.values().map(|p| p.inbox.lock_safe().len()).sum();
        (panes.len(), messages)
    };
    let sessions = state.sessions.lock_safe().len();
    let json = serde_json::json!({
        "daemon_pid": std::process::id(),
        "panes": panes,
        "sessions": sessions,
        "messages": messages,
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

    // Pane-identifying env (#139): the CLI inside a pane reads these to self-
    // identify (`RMUX_PANE_ID` = this pane's id) and to find the bus
    // (`RMUX_DAEMON_URL` = the daemon's loopback URL). Injected only on the daemon
    // path — the in-process Tauri path passes `&[]`, so this is the seam that makes
    // agent-to-agent messaging usable from a bare shell without the Terax UI.
    let extra_env = vec![
        ("RMUX_PANE_ID".to_string(), id.to_string()),
        ("RMUX_DAEMON_URL".to_string(), state.daemon_url.clone()),
    ];

    // Spawn the shell. `spawn_session` does blocking PTY setup; run it off the
    // async worker so the reactor thread is never blocked on ConPTY/openpty.
    let spawn = tokio::task::spawn_blocking(move || {
        spawn_session(id, cols, rows, cwd, WorkspaceEnv::default(), &extra_env, sink).map(|(s, _)| s)
    })
    .await;

    let session = match spawn {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("spawn failed: {e}")),
        Err(e) => return Err(format!("spawn join failed: {e}")),
    };

    state
        .panes
        .lock_safe()
        .insert(id, PaneEntry { session, output, inbox: Mutex::new(VecDeque::new()) });
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

// ---------------------------------------------------------------------------
// Message bus (#136)
// ---------------------------------------------------------------------------

/// Resolve a `to` routing value to the set of target pane ids, given the live
/// pane id set and the session index. Pure logic (no I/O, no locks held inside)
/// so it is unit-testable without HTTP or real shells:
///   - a JSON number `n`        -> `[n]` (the pane id, delivered even if == from),
///   - `{"session": <name>}`    -> every pane id in that named session,
///   - `{"window": <name>}`     -> every pane id in that named window,
///   - `"*"`                    -> every live pane id.
///
/// Self-exclusion: for `"*"`, a session target, and a window target we REMOVE
/// `from` from the result — a broadcast or group send should not echo back to the
/// sender. A DIRECT pane-id target is the exception: it is delivered even when it
/// equals `from`, so an agent can deliberately self-message (e.g. to enqueue work
/// for itself). Unknown names / shapes resolve to an empty set.
///
/// `windows` is `(window_name, pane_ids)` flattened across all sessions; names
/// are not globally unique, so a window-name target hits every matching window.
fn resolve_targets(
    to: &Value,
    from: u32,
    all_panes: &[u32],
    sessions: &[(String, Vec<u32>)],
    windows: &[(Option<String>, Vec<u32>)],
) -> Vec<u32> {
    // De-dup while preserving first-seen order, then apply self-exclusion for the
    // group/broadcast forms.
    fn dedup(ids: impl IntoIterator<Item = u32>, exclude: Option<u32>) -> Vec<u32> {
        let mut seen = std::collections::HashSet::new();
        ids.into_iter()
            .filter(|id| exclude != Some(*id))
            .filter(|id| seen.insert(*id))
            .collect()
    }

    if let Some(n) = to.as_u64() {
        // Direct pane id: deliver even to self (no exclusion).
        return dedup([n as u32], None);
    }
    if let Some(s) = to.as_str() {
        if s == "*" {
            return dedup(all_panes.iter().copied(), Some(from));
        }
        return Vec::new();
    }
    if let Some(obj) = to.as_object() {
        if let Some(name) = obj.get("session").and_then(|v| v.as_str()) {
            let ids = sessions
                .iter()
                .filter(|(n, _)| n == name)
                .flat_map(|(_, panes)| panes.iter().copied());
            return dedup(ids, Some(from));
        }
        if let Some(name) = obj.get("window").and_then(|v| v.as_str()) {
            let ids = windows
                .iter()
                .filter(|(n, _)| n.as_deref() == Some(name))
                .flat_map(|(_, panes)| panes.iter().copied());
            return dedup(ids, Some(from));
        }
    }
    Vec::new()
}

/// The plain, visible line format injected into a target shell's stdin when a
/// message has `inject: true`. We deliberately pick a plain commented newline
/// line over an OSC escape (`\x1b]...\x07`): it is human-visible in the
/// terminal, a CLI agent can `grep '^# rmux-msg:'` for it, and it cannot corrupt
/// the terminal state the way a malformed escape could. The JSON is compact
/// (single line) so the whole message stays on one greppable line.
fn inject_line(msg: &BusMessage) -> String {
    let json = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
    format!("# rmux-msg: {json}\n")
}

/// Deliver one message to one pane: push it to the pane's durable inbox (bounded,
/// drop-oldest), emit it to the broadcast as an `OutFrame::Msg` for any live
/// `/attach` subscriber, and — if `inject` — write the tagged line to the shell's
/// stdin via the SAME writer path `write_pane` uses. Returns whether the pane
/// existed (callers tally the delivered count). The broadcast send is best-effort
/// (no live subscriber -> dropped, which is fine: the inbox is the durable copy);
/// the inbox push is what guarantees at-least-once delivery to a polling consumer.
///
/// Crucially the `Msg` is emitted via `out.tx.send` ONLY, never `ring.push`: bus
/// messages must not become scrollback (they would replay forever on reattach and
/// evict real terminal output). The inbox is the durable store; the broadcast is
/// live-only.
fn deliver(state: &DaemonState, target: u32, msg: &BusMessage) -> bool {
    // Snapshot what we need under the panes lock without holding it across the
    // (blocking) stdin write. We clone the broadcast sender and (optionally) the
    // writer, and do the bounded inbox push while we hold the lock.
    let (tx, writer) = {
        let panes = state.panes.lock_safe();
        let Some(entry) = panes.get(&target) else {
            return false;
        };
        {
            let mut inbox = entry.inbox.lock_safe();
            inbox.push_back(msg.clone());
            while inbox.len() > INBOX_MAX {
                inbox.pop_front();
            }
        }
        let tx = entry.output.lock_safe().tx.clone();
        let writer = if msg.inject { Some(entry.session.writer.clone()) } else { None };
        (tx, writer)
    };

    // Live-only broadcast (NOT ringed). Best-effort: errors when there is no live
    // subscriber, which is the normal detached case.
    let json = serde_json::to_string(msg).unwrap_or_else(|_| "null".to_string());
    let _ = tx.send(OutFrame::Msg(json));

    // Optional stdin injection via the shared writer path. A failed inject (e.g.
    // the child already exited, EPIPE) does NOT undo the inbox push: the message
    // is still durably delivered for a later poll.
    if let Some(writer) = writer {
        let line = inject_line(msg);
        let _ = writer.lock_safe().write_all(line.as_bytes());
    }
    true
}

/// Mint a `BusMessage`: assign the next id and a real-wall-clock millisecond
/// timestamp, echo the caller's routing fields. Centralized so direct and routed
/// sends produce identical message shapes.
fn mint_message(
    state: &DaemonState,
    from: u32,
    to: Value,
    msg_type: String,
    payload: Value,
    inject: bool,
) -> BusMessage {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    BusMessage { id, from, to, msg_type, payload, inject, ts }
}

/// POST /pane/<id>/message {from, type, payload, inject?} -> deliver to one pane.
/// 404 if the target pane does not exist: this is the DIRECT form where the
/// caller named a specific pane, so a missing target is a real error worth
/// surfacing (unlike `/bus/publish`, where a count of 0 is the honest answer for
/// a group that resolved to nothing).
async fn pane_message(
    req: Request<hyper::body::Incoming>,
    state: Arc<DaemonState>,
    id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let m: PaneMessageReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };
    // Echo the resolved target (the path id) as the message `to`.
    let msg = mint_message(&state, m.from, Value::from(id), m.msg_type, m.payload, m.inject);
    if deliver(&state, id, &msg) {
        json_response(StatusCode::OK, &serde_json::json!({ "message_id": msg.id }))
    } else {
        text(StatusCode::NOT_FOUND, "no pane")
    }
}

/// POST /bus/publish {from, to, type, payload, inject?} -> fan-out deliver.
/// Always 200 with the honest delivered count: a target that resolves to no live
/// panes (a gone session, an empty `"*"`, a typo'd name) is a 0, not an error —
/// the bus is resilient to stale routing rather than failing the publisher.
async fn bus_publish(req: Request<hyper::body::Incoming>, state: Arc<DaemonState>) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let p: BusPublishReq = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };

    // Snapshot the routing index (pane ids + session/window names) under the
    // locks, then resolve and deliver without holding them: `deliver` re-takes
    // the panes lock per target, and resolution is pure.
    let (all_panes, sessions_idx, windows_idx) = {
        let panes = state.panes.lock_safe();
        let all_panes: Vec<u32> = panes.keys().copied().collect();
        drop(panes);
        let sessions = state.sessions.lock_safe();
        let sessions_idx: Vec<(String, Vec<u32>)> =
            sessions.values().map(|s| (s.name.clone(), s.pane_ids())).collect();
        let windows_idx: Vec<(Option<String>, Vec<u32>)> = sessions
            .values()
            .flat_map(|s| s.windows.iter().map(|w| (w.name.clone(), w.panes.clone())))
            .collect();
        (all_panes, sessions_idx, windows_idx)
    };

    let targets = resolve_targets(&p.to, p.from, &all_panes, &sessions_idx, &windows_idx);
    let msg = mint_message(&state, p.from, p.to.clone(), p.msg_type, p.payload, p.inject);
    let mut delivered = 0u32;
    for target in targets {
        if deliver(&state, target, &msg) {
            delivered += 1;
        }
    }
    json_response(
        StatusCode::OK,
        &serde_json::json!({ "delivered": delivered, "message_id": msg.id }),
    )
}

/// GET /pane/<id>/inbox -> {messages: [BusMessage...]}. A non-draining snapshot:
/// the consumer reads, then explicitly acks (`inbox/ack`) what it has processed.
/// Read-then-ack (rather than read-and-drain) means a consumer that crashes after
/// reading but before processing does not lose the messages.
fn pane_inbox(state: &DaemonState, id: u32) -> Response<Body> {
    let panes = state.panes.lock_safe();
    let Some(entry) = panes.get(&id) else {
        return text(StatusCode::NOT_FOUND, "no pane");
    };
    let messages: Vec<BusMessage> = entry.inbox.lock_safe().iter().cloned().collect();
    json_response(StatusCode::OK, &serde_json::json!({ "messages": messages }))
}

/// POST /pane/<id>/inbox/ack {ids?} -> {remaining}. Drains acked messages: with
/// `ids` present only those are removed; with `ids` absent the whole inbox is
/// cleared. Returns the remaining count so a consumer can confirm its ack landed.
async fn pane_inbox_ack(
    req: Request<hyper::body::Incoming>,
    state: &DaemonState,
    id: u32,
) -> Response<Body> {
    let body = match collect_body(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    // Empty body == ack-all (no `ids`). Tolerate it without forcing the caller to
    // send `{}`.
    let ack: InboxAckReq = if body.is_empty() {
        InboxAckReq::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
        }
    };
    let panes = state.panes.lock_safe();
    let Some(entry) = panes.get(&id) else {
        return text(StatusCode::NOT_FOUND, "no pane");
    };
    let mut inbox = entry.inbox.lock_safe();
    match ack.ids {
        Some(ids) => inbox.retain(|m| !ids.contains(&m.id)),
        None => inbox.clear(),
    }
    let remaining = inbox.len();
    json_response(StatusCode::OK, &serde_json::json!({ "remaining": remaining }))
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
/// bytes, NOT base64), 1 = agent (JSON), 2 = exit (the code as 4-byte LE i32),
/// 3 = msg (bus message JSON, #136). Kinds 0/1/2 are byte-identical to the
/// pre-#136 wire format — only kind 3 is additive, so existing attach clients
/// that don't know `Msg` simply skip an unknown kind by its length prefix.
fn encode_frame(frame: &OutFrame) -> Bytes {
    let (kind, payload): (u8, Vec<u8>) = match frame {
        OutFrame::Data(bytes) => (0, bytes.clone()),
        OutFrame::Agent(json) => (1, json.as_bytes().to_vec()),
        OutFrame::Exit(code) => (2, code.to_le_bytes().to_vec()),
        OutFrame::Msg(json) => (3, json.as_bytes().to_vec()),
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

    // ----- Message bus (#136) -----------------------------------------------

    /// Decode a `[u8 kind][u32 LE len][payload]` frame back into (kind, payload)
    /// so the encode tests assert the exact wire shape, not just the kind byte.
    fn decode_frame(bytes: &[u8]) -> (u8, Vec<u8>) {
        let kind = bytes[0];
        let len = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let payload = bytes[5..5 + len].to_vec();
        (kind, payload)
    }

    fn msg(id: u32, from: u32, to: Value, msg_type: &str) -> BusMessage {
        BusMessage {
            id,
            from,
            to,
            msg_type: msg_type.to_string(),
            payload: serde_json::json!({}),
            inject: false,
            ts: 0,
        }
    }

    #[test]
    fn encode_frame_msg_is_kind_3_and_round_trips() {
        // Existing kinds stay byte-stable; Msg adds kind 3 carrying the JSON.
        assert_eq!(decode_frame(&encode_frame(&OutFrame::Data(vec![1, 2, 3]))).0, 0);
        assert_eq!(decode_frame(&encode_frame(&OutFrame::Agent("x".into()))).0, 1);
        assert_eq!(decode_frame(&encode_frame(&OutFrame::Exit(7))).0, 2);

        let json = r#"{"id":1,"from":2}"#;
        let frame = encode_frame(&OutFrame::Msg(json.to_string()));
        let (kind, payload) = decode_frame(&frame);
        assert_eq!(kind, 3);
        assert_eq!(payload.len(), json.len());
        assert_eq!(String::from_utf8(payload).unwrap(), json);
    }

    #[test]
    fn inbox_bound_drops_oldest_and_caps_len() {
        // Mirror deliver's bounded push: push INBOX_MAX + N, assert len stays
        // capped and the oldest N were evicted (front id advanced).
        let mut inbox: VecDeque<BusMessage> = VecDeque::new();
        let overflow = 5u32;
        for i in 0..(INBOX_MAX as u32 + overflow) {
            inbox.push_back(msg(i, 1, Value::from(2u32), "t"));
            while inbox.len() > INBOX_MAX {
                inbox.pop_front();
            }
        }
        assert_eq!(inbox.len(), INBOX_MAX);
        // First `overflow` ids dropped, so the front id is now `overflow`.
        assert_eq!(inbox.front().unwrap().id, overflow);
        assert_eq!(inbox.back().unwrap().id, INBOX_MAX as u32 + overflow - 1);
    }

    #[test]
    fn resolve_targets_direct_pane_includes_self() {
        // A direct numeric target is delivered even when it equals `from`.
        let all = vec![10, 11, 12];
        let got = resolve_targets(&Value::from(11u32), 11, &all, &[], &[]);
        assert_eq!(got, vec![11]);
    }

    #[test]
    fn resolve_targets_star_excludes_self_and_dedups() {
        let all = vec![10, 11, 12];
        let got = resolve_targets(&Value::from("*"), 11, &all, &[], &[]);
        assert_eq!(got, vec![10, 12]);
    }

    #[test]
    fn resolve_targets_session_name_excludes_self() {
        let all = vec![10, 11, 12];
        let sessions = vec![("work".to_string(), vec![10, 11, 12])];
        let got = resolve_targets(
            &serde_json::json!({ "session": "work" }),
            11,
            &all,
            &sessions,
            &[],
        );
        assert_eq!(got, vec![10, 12]);
    }

    #[test]
    fn resolve_targets_window_name_excludes_self() {
        let all = vec![10, 11, 12];
        let windows = vec![(Some("left".to_string()), vec![10, 11])];
        let got = resolve_targets(
            &serde_json::json!({ "window": "left" }),
            11,
            &all,
            &[],
            &windows,
        );
        assert_eq!(got, vec![10]);
    }

    #[test]
    fn resolve_targets_unknown_name_or_shape_is_empty() {
        let all = vec![10, 11];
        assert!(resolve_targets(&serde_json::json!({ "session": "nope" }), 1, &all, &[], &[]).is_empty());
        assert!(resolve_targets(&serde_json::json!({ "window": "nope" }), 1, &all, &[], &[]).is_empty());
        assert!(resolve_targets(&Value::from("garbage"), 1, &all, &[], &[]).is_empty());
        assert!(resolve_targets(&Value::Null, 1, &all, &[], &[]).is_empty());
    }

    #[test]
    fn ack_drain_all_empties_inbox() {
        let mut inbox: VecDeque<BusMessage> = (0..3)
            .map(|i| msg(i, 1, Value::from(2u32), "t"))
            .collect();
        // ack with ids: None -> clear all.
        inbox.clear();
        assert_eq!(inbox.len(), 0);
    }

    #[test]
    fn ack_drain_by_id_removes_only_those() {
        let mut inbox: VecDeque<BusMessage> = (0..4)
            .map(|i| msg(i, 1, Value::from(2u32), "t"))
            .collect();
        let ids = vec![1u32, 3u32];
        inbox.retain(|m| !ids.contains(&m.id));
        let remaining: Vec<u32> = inbox.iter().map(|m| m.id).collect();
        assert_eq!(remaining, vec![0, 2]);
    }
}
