//! Out-of-process PTY daemon sidecar (#110).
//!
//! Owns the live shell sessions ("panes") for the terminal-rmux feature out of
//! the Terax app process and serves them over a loopback HTTP + SSE API:
//!   - `POST /pane/open`        spawn a shell, return its pane id,
//!   - `POST /pane/<id>/write`  feed input to a pane's shell,
//!   - `POST /pane/<id>/resize` resize a pane's PTY,
//!   - `POST /pane/<id>/close`  kill a pane's shell and forget it,
//!   - `GET  /pane/<id>/events` stream the pane's output as Server-Sent Events,
//!   - `GET  /health`           daemon pid + live pane count.
//!
//! The server binds 127.0.0.1 only — loopback is the trust boundary, same as the
//! otel-collector sidecar this binary is modelled on.
//!
//! The shell-spawn + reader code is shared with the in-process Tauri path via
//! `terax_lib::modules::pty::spawn_session`, so the daemon and app can never
//! diverge on PTY behavior. This binary only adds the HTTP transport, the pane
//! registry, and the broadcast fan-out that turns one shell's output into many
//! SSE subscribers.

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

/// Daemon-wide state shared across all connection tasks.
struct DaemonState {
    panes: Mutex<HashMap<u32, PaneEntry>>,
    // Starts at 1 so a freshly-handed-out id is never 0 (the frontend treats 0
    // as "unset"). Monotonic; ids are never reused.
    next_id: AtomicU32,
}

impl DaemonState {
    fn new() -> Self {
        Self {
            panes: Mutex::new(HashMap::new()),
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

    // Per-pane routes: /pane/<id>/<verb>.
    if let Some(rest) = path.strip_prefix("/pane/") {
        if let Some((id_str, verb)) = rest.split_once('/') {
            if let Ok(id) = id_str.parse::<u32>() {
                match (&method, verb) {
                    (&Method::GET, "attach") => return Ok(attach_pane(&state, id)),
                    (&Method::POST, "write") => return Ok(write_pane(req, &state, id).await),
                    (&Method::POST, "resize") => return Ok(resize_pane(req, &state, id).await),
                    (&Method::POST, "close") => return Ok(close_pane(&state, id)),
                    _ => {}
                }
            }
        }
    }

    Ok(text(StatusCode::NOT_FOUND, "not found"))
}

fn health(state: &DaemonState) -> Response<Body> {
    let panes = state.panes.lock_safe().len();
    let json = serde_json::json!({
        "daemon_pid": std::process::id(),
        "panes": panes,
    });
    json_response(StatusCode::OK, &json)
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

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, _rx) = broadcast::channel::<OutFrame>(PANE_CHANNEL_CAP);
    let output = Arc::new(Mutex::new(PaneOutput { ring: Ring::new(), tx }));
    let sink: Arc<dyn PtyOutputSink> = Arc::new(PaneSink(output.clone()));

    // Spawn the shell. `spawn_session` does blocking PTY setup; run it off the
    // async worker so the reactor thread is never blocked on ConPTY/openpty.
    let cols = open.cols;
    let rows = open.rows;
    let cwd = open.cwd;
    let spawn = tokio::task::spawn_blocking(move || {
        spawn_session(id, cols, rows, cwd, WorkspaceEnv::default(), sink).map(|(s, _)| s)
    })
    .await;

    let session = match spawn {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return text(StatusCode::INTERNAL_SERVER_ERROR, &format!("spawn failed: {e}")),
        Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &format!("spawn join failed: {e}")),
    };

    state.panes.lock_safe().insert(id, PaneEntry { session, output });
    json_response(StatusCode::OK, &serde_json::json!({ "pane_id": id }))
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
