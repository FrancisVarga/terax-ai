//! Standalone OTEL collector sidecar.
//!
//! Runs out-of-process from the Terax app (spawned by `modules::otel`):
//!   - opens the SQLite telemetry store,
//!   - runs the OTLP/HTTP ingest server (apps export traces/logs/metrics here),
//!   - serves a loopback query HTTP API the app proxies the `otel_*` commands to
//!     (`POST /q/<command>` with the command's JSON args), and
//!   - streams ingest notifications over Server-Sent Events at `/events`, which
//!     the app bridges to its `terax:otel-ingest` Tauri event.
//!
//! All servers bind 127.0.0.1 only — loopback is the trust boundary, same as the
//! in-process collector. CLI:
//!
//!   otel-collector --ingest-port <p> --query-port <p> [--db-path <path>]
//!
//! The collector logic (store, ingest, query dispatch) is shared with the
//! in-process path via `terax_lib::modules::otel::collector`; this binary only
//! adds the query HTTP transport + SSE fan-out.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use terax_lib::modules::otel::collector::{
    self, QueryRequest, EVENTS_PATH, QUERY_PREFIX,
};
use terax_lib::modules::otel::{IngestSink, OtelStore};

/// Capacity of the ingest-notification broadcast channel. Notifications are tiny
/// and only drive a dashboard refresh, so a laggy subscriber dropping a few is
/// harmless — the next batch re-notifies. 256 is ample headroom for bursts.
const EVENT_CHANNEL_CAP: usize = 256;

/// One ingest notification fanned out to `/events` subscribers.
#[derive(Clone)]
struct Notification {
    signal: &'static str,
    count: usize,
}

/// Ingest sink that publishes each batch onto the broadcast channel. A send
/// error (no subscribers yet) is ignored — events are only useful live.
struct BroadcastSink(broadcast::Sender<Notification>);

impl IngestSink for BroadcastSink {
    fn notify(&self, signal: &'static str, count: usize) {
        let _ = self.0.send(Notification { signal, count });
    }
}

/// Parsed CLI args. Hand-rolled to keep the binary dependency-light (no clap).
struct Args {
    ingest_port: u16,
    query_port: u16,
    db_path: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut ingest_port: Option<u16> = None;
    let mut query_port: Option<u16> = None;
    let mut db_path: Option<PathBuf> = None;

    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--ingest-port" => {
                ingest_port = Some(next_val(&mut it, &flag)?.parse().map_err(|e| format!("--ingest-port: {e}"))?)
            }
            "--query-port" => {
                query_port = Some(next_val(&mut it, &flag)?.parse().map_err(|e| format!("--query-port: {e}"))?)
            }
            "--db-path" => db_path = Some(PathBuf::from(next_val(&mut it, &flag)?)),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Args {
        ingest_port: ingest_port.ok_or("--ingest-port is required")?,
        query_port: query_port.ok_or("--query-port is required")?,
        db_path,
    })
}

fn next_val(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} expects a value"))
}

fn main() {
    // A simple stderr logger so the app (which inherits our stdio) sees what the
    // sidecar is doing. `env_logger` isn't a dep; print directly.
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("otel-collector: {e}");
            eprintln!("usage: otel-collector --ingest-port <p> --query-port <p> [--db-path <path>]");
            std::process::exit(2);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("otel-collector: failed to build runtime: {e}");
            std::process::exit(1);
        }
    };

    rt.block_on(run(args));
}

async fn run(args: Args) {
    let store = collector::open_store(args.db_path.as_deref());

    // Broadcast channel: ingest sink -> /events subscribers.
    let (tx, _rx) = broadcast::channel::<Notification>(EVENT_CHANNEL_CAP);
    let sink: Arc<dyn IngestSink> = Arc::new(BroadcastSink(tx.clone()));

    // OTLP ingest server (writes the store, notifies the broadcaster).
    let ingest_addr = SocketAddr::from(([127, 0, 0, 1], args.ingest_port));
    collector::spawn_ingest(ingest_addr, store.clone(), sink);

    // Query + events HTTP server.
    let query_addr = SocketAddr::from(([127, 0, 0, 1], args.query_port));
    serve_query(query_addr, store, tx).await;
}

/// Serve the query HTTP API + `/events` SSE on `addr` until the process exits.
async fn serve_query(
    addr: SocketAddr,
    store: Arc<OtelStore>,
    tx: broadcast::Sender<Notification>,
) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("otel-collector: cannot bind query port {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("otel-collector: query API + events listening on http://{addr}");

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("otel-collector: accept failed: {e}");
                continue;
            }
        };
        let io = TokioIo::new(stream);
        let store = store.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, store.clone(), tx.clone()));
            // SSE connections are long-lived; http1 keep-alive (default) holds
            // them open for the duration of the stream.
            if let Err(e) = http1::Builder::new()
                .serve_connection(io, svc)
                .await
            {
                // Client disconnects on a long-lived SSE stream are normal.
                let _ = e;
            }
        });
    }
}

type Body = BoxBody<Bytes, Infallible>;

async fn handle(
    req: Request<hyper::body::Incoming>,
    store: Arc<OtelStore>,
    tx: broadcast::Sender<Notification>,
) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path().to_string();

    // SSE event stream.
    if req.method() == Method::GET && path == EVENTS_PATH {
        return Ok(events_response(tx.subscribe()));
    }

    // Query commands: POST /q/<command>.
    if req.method() == Method::POST {
        if let Some(cmd) = path.strip_prefix(QUERY_PREFIX) {
            return Ok(handle_query(req, store, cmd).await);
        }
    }

    Ok(text(StatusCode::NOT_FOUND, "not found"))
}

/// Run one query: deserialize the body into a `QueryRequest` (the URL command is
/// authoritative for the variant via `cmd`), dispatch against the store, and
/// return JSON. A query error (read-only SQL guard, bad SQL) maps to 400 with the
/// message body so the app can surface it verbatim on the Query page.
async fn handle_query(
    req: Request<hyper::body::Incoming>,
    store: Arc<OtelStore>,
    _cmd: &str,
) -> Response<Body> {
    let body = match req.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return text(StatusCode::BAD_REQUEST, "read body failed"),
    };
    let parsed: Result<QueryRequest, _> = serde_json::from_slice(&body);
    let req = match parsed {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_REQUEST, &format!("bad request: {e}")),
    };
    match collector::dispatch_query(&store, req) {
        Ok(value) => {
            let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"null".to_vec());
            Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .body(full(bytes))
                .unwrap()
        }
        Err(msg) => text(StatusCode::BAD_REQUEST, &msg),
    }
}

/// Build an `text/event-stream` response that emits one SSE `data:` frame per
/// ingest notification received on `rx`. The stream ends when the broadcaster is
/// dropped (process exit); a lagged receiver skips the missed notifications and
/// continues (a dropped refresh tick is harmless).
fn events_response(rx: broadcast::Receiver<Notification>) -> Response<Body> {
    use futures_util::stream;
    // `unfold` turns the broadcast receiver into a stream of SSE frame bytes
    // without pulling in `tokio-stream`.
    let body_stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(n) => {
                    let json = serde_json::json!({ "signal": n.signal, "count": n.count });
                    let frame = format!("data: {json}\n\n");
                    return Some((Ok(Frame::data(Bytes::from(frame))), rx));
                }
                // Lagged: drop the missed notifications, keep streaming.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // Sender gone (process exiting): end the stream.
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    let body = StreamBody::new(body_stream).boxed();
    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "text/event-stream")
        .header(hyper::header::CACHE_CONTROL, "no-cache")
        .header(hyper::header::CONNECTION, "keep-alive")
        .body(body)
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
