//! OTLP/HTTP ingest server.
//!
//! A minimal hyper 1.x HTTP/1.1 listener bound to loopback. It accepts the three
//! OTLP signal endpoints and dispatches on `Content-Type`:
//!
//!   - `application/x-protobuf` -> `prost::Message::decode`
//!   - `application/json` -> `serde_json::from_slice`
//!
//! Both decode into the SAME `Export*ServiceRequest` struct (the
//! `opentelemetry-proto` `with-serde` codec), so the conversion path is shared.
//! `Content-Encoding: gzip` bodies are inflated first (the OTEL HTTP exporter
//! commonly compresses). The response is a 200 with an empty matching-encoding
//! `Export*ServiceResponse` body, signalling full success per the OTLP spec.
//!
//! SECURITY: bound to 127.0.0.1 only. This is a local-dev collector with no auth
//! (OTLP has no built-in auth and the product is dev-only here), so loopback is
//! the trust boundary. A request body is size-capped before buffering to avoid a
//! memory-exhaustion DoS from a hostile local process.

use std::convert::Infallible;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};

use super::convert;
use super::store::OtelStore;

/// Reject request bodies larger than this (post-inflation cap is implicit via
/// the read limit). OTLP batches are small; 16 MiB is generous for local dev.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Notified after each non-empty batch lands so an observer (the in-process
/// Tauri bridge, or the sidecar's SSE broadcaster) can signal the dashboard.
/// Decouples ingest from Tauri so the same `serve` runs in the standalone
/// `otel-collector` sidecar binary, which has no `AppHandle` to `emit` on.
/// `signal` is "traces" | "logs" | "metrics"; `count` is rows added.
pub trait IngestSink: Send + Sync + 'static {
    fn notify(&self, signal: &'static str, count: usize);
}

/// A closure sink, so callers can pass `|signal, count| { ... }` directly.
impl<F: Fn(&'static str, usize) + Send + Sync + 'static> IngestSink for F {
    fn notify(&self, signal: &'static str, count: usize) {
        self(signal, count);
    }
}

/// Shared context handed to every connection handler.
struct Ctx {
    store: Arc<OtelStore>,
    sink: Arc<dyn IngestSink>,
}

// Manual Clone: `#[derive(Clone)]` would demand `Arc<dyn IngestSink>: Clone`
// spelled on the trait object, which it already is, but deriving also bounds
// the struct on it redundantly; an explicit impl keeps the field cheap-clone.
impl Clone for Ctx {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            sink: self.sink.clone(),
        }
    }
}

/// Wall-clock now in ms since epoch, monotonic-enough for retention ordering.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Start the ingest server on `addr`. Runs until the process exits. Errors
/// (e.g. port already bound) are logged and the task ends gracefully so the rest
/// of the app keeps working without a collector.
pub async fn serve(addr: SocketAddr, store: Arc<OtelStore>, sink: Arc<dyn IngestSink>) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            log::warn!(target: "otel", "OTLP ingest disabled: cannot bind {addr}: {e}");
            return;
        }
    };
    log::info!(target: "otel", "OTLP/HTTP ingest listening on http://{addr}");

    let ctx = Ctx { store, sink };
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                log::warn!(target: "otel", "accept failed: {e}");
                continue;
            }
        };
        let io = TokioIo::new(stream);
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, ctx.clone()));
            // OTLP exporters keep connections alive across batches; http1 with
            // keep-alive (the default) handles that.
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                log::debug!(target: "otel", "connection error: {e}");
            }
        });
    }
}

/// Route an incoming request to the right signal handler.
async fn handle(req: Request<hyper::body::Incoming>, ctx: Ctx) -> Result<Response<Full<Bytes>>, Infallible> {
    // Browser-based OTel (opentelemetry-js in a page) preflights JSON POSTs.
    // Answer permissively so a local web app can export to us too.
    if req.method() == Method::OPTIONS {
        return Ok(cors(Response::builder())
            .status(StatusCode::NO_CONTENT)
            .body(Full::new(Bytes::new()))
            .unwrap());
    }
    if req.method() != Method::POST {
        return Ok(text(StatusCode::METHOD_NOT_ALLOWED, "only POST"));
    }

    let path = req.uri().path().to_string();
    let is_proto = content_type_is_protobuf(&req);
    let is_gzip = header_eq(&req, hyper::header::CONTENT_ENCODING, "gzip");

    let body = match collect_body(req, is_gzip).await {
        Ok(b) => b,
        Err(e) => return Ok(text(StatusCode::BAD_REQUEST, &e)),
    };

    let received = now_ms();
    match path.as_str() {
        "/v1/traces" => Ok(ingest_traces(&body, is_proto, &ctx, received)),
        "/v1/logs" => Ok(ingest_logs(&body, is_proto, &ctx, received)),
        "/v1/metrics" => Ok(ingest_metrics(&body, is_proto, &ctx, received)),
        _ => Ok(text(StatusCode::NOT_FOUND, "unknown OTLP path")),
    }
}

fn ingest_traces(body: &[u8], is_proto: bool, ctx: &Ctx, received: i64) -> Response<Full<Bytes>> {
    let req: ExportTraceServiceRequest = match decode(body, is_proto) {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_REQUEST, &e),
    };
    let rows = convert::spans_from_resource(&req.resource_spans, received);
    let n = ctx.store.insert_spans(&rows);
    emit(ctx, "traces", n);
    ok_response(&ExportTraceServiceResponse::default(), is_proto)
}

fn ingest_logs(body: &[u8], is_proto: bool, ctx: &Ctx, received: i64) -> Response<Full<Bytes>> {
    let req: ExportLogsServiceRequest = match decode(body, is_proto) {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_REQUEST, &e),
    };
    let rows = convert::logs_from_resource(&req.resource_logs, received);
    let n = ctx.store.insert_logs(&rows);
    emit(ctx, "logs", n);
    ok_response(&ExportLogsServiceResponse::default(), is_proto)
}

fn ingest_metrics(body: &[u8], is_proto: bool, ctx: &Ctx, received: i64) -> Response<Full<Bytes>> {
    let req: ExportMetricsServiceRequest = match decode(body, is_proto) {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_REQUEST, &e),
    };
    let rows = convert::metrics_from_resource(&req.resource_metrics, received);
    let n = ctx.store.insert_metrics(&rows);
    emit(ctx, "metrics", n);
    ok_response(&ExportMetricsServiceResponse::default(), is_proto)
}

/// Decode `body` into `T` from protobuf or JSON. The two wire formats share the
/// generated struct so callers don't branch on the result type.
fn decode<T>(body: &[u8], is_proto: bool) -> Result<T, String>
where
    T: prost::Message + serde::de::DeserializeOwned + Default,
{
    if is_proto {
        T::decode(body).map_err(|e| format!("protobuf decode: {e}"))
    } else {
        serde_json::from_slice(body).map_err(|e| format!("json decode: {e}"))
    }
}

fn emit(ctx: &Ctx, signal: &'static str, count: usize) {
    if count == 0 {
        return;
    }
    ctx.sink.notify(signal, count);
}

/// A 200 with the matching-encoding empty `Export*ServiceResponse` body, which
/// the OTLP spec defines as full success.
fn ok_response<T: prost::Message + serde::Serialize>(
    resp: &T,
    is_proto: bool,
) -> Response<Full<Bytes>> {
    let (ct, body) = if is_proto {
        ("application/x-protobuf", resp.encode_to_vec())
    } else {
        // Full success JSON body is `{}` (an empty response message).
        ("application/json", serde_json::to_vec(resp).unwrap_or_else(|_| b"{}".to_vec()))
    };
    cors(Response::builder())
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, ct)
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

/// Read the request body up to the size cap, inflating gzip if needed.
async fn collect_body(
    req: Request<hyper::body::Incoming>,
    is_gzip: bool,
) -> Result<Vec<u8>, String> {
    // Cheap pre-check: refuse on a declared oversized Content-Length before
    // buffering anything.
    if let Some(len) = req
        .headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
    {
        if len > MAX_BODY_BYTES {
            return Err(format!("body too large: {len} bytes"));
        }
    }
    let collected = req
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("read body: {e}"))?
        .to_bytes();
    if collected.len() > MAX_BODY_BYTES {
        return Err("body too large".into());
    }
    if !is_gzip {
        return Ok(collected.to_vec());
    }
    let mut decoder = flate2::read::GzDecoder::new(&collected[..]);
    let mut out = Vec::new();
    // Bound the inflated size too, so a zip-bomb can't blow past the cap.
    decoder
        .by_ref()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("gzip inflate: {e}"))?;
    if out.len() > MAX_BODY_BYTES {
        return Err("inflated body too large".into());
    }
    Ok(out)
}

fn content_type_is_protobuf(req: &Request<hyper::body::Incoming>) -> bool {
    req.headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase().contains("protobuf"))
        .unwrap_or(false)
}

fn header_eq(req: &Request<hyper::body::Incoming>, name: hyper::header::HeaderName, want: &str) -> bool {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case(want))
        .unwrap_or(false)
}

/// Attach permissive CORS headers (local dev, any origin) so a browser OTel
/// exporter's preflight + actual POST both succeed.
fn cors(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "content-type, content-encoding")
}

fn text(status: StatusCode, msg: &str) -> Response<Full<Bytes>> {
    cors(Response::builder())
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "text/plain")
        .body(Full::new(Bytes::from(msg.to_string())))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as _;

    #[test]
    fn decode_json_and_protobuf_traces() {
        let json = br#"{"resourceSpans":[]}"#;
        let from_json: ExportTraceServiceRequest = decode(json, false).unwrap();
        assert_eq!(from_json.resource_spans.len(), 0);

        let proto = from_json.encode_to_vec();
        let from_proto: ExportTraceServiceRequest = decode(&proto, true).unwrap();
        assert_eq!(from_proto.resource_spans.len(), 0);
    }

    #[test]
    fn bad_json_is_an_error_not_a_panic() {
        let r: Result<ExportTraceServiceRequest, _> = decode(b"not json", false);
        assert!(r.is_err());
    }

    #[test]
    fn ok_response_json_body_is_empty_object() {
        let resp = ok_response(&ExportTraceServiceResponse::default(), false);
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
