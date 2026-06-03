//! Local OpenTelemetry collector: OTLP/HTTP ingest + a query API for the
//! in-app observability dashboard.
//!
//! This is a development-only backend. Apps point their OTLP/HTTP exporter at
//! `http://127.0.0.1:<port>` (default 4318, the OTLP/HTTP convention) and the
//! ingest server (`ingest.rs`) parses traces/logs/metrics in both protobuf and
//! JSON, normalizes them (`convert.rs`) into row structs (`model.rs`), and
//! appends to a 1 GB-capped SQLite store (`store.rs`). Every batch emits a
//! `terax:otel-ingest` Tauri event so the dashboard refreshes in realtime; the
//! dashboard reads history through the `otel_*` query commands below.
//!
//! ## Sidecar vs in-process
//!
//! The collector runs out-of-process as the `otel-collector` sidecar binary in a
//! packaged build, and in-process during `tauri dev`:
//!
//!   - SIDECAR (packaged): on boot we spawn `otel-collector` (next to the app
//!     exe, like the bunqueue sidecars), which owns the SQLite store, runs the
//!     OTLP ingest server, AND serves a loopback query HTTP API. The `otel_*`
//!     commands below proxy to that API; a background task bridges the sidecar's
//!     `/events` SSE stream to the `terax:otel-ingest` Tauri event.
//!   - IN-PROCESS (dev fallback): when no sidecar binary is staged next to the
//!     exe (running from the source tree), we open the store in-process and run
//!     `ingest::serve` on the Tauri runtime — the original path. Keeps the dev
//!     loop fast (no second cargo build to iterate on the collector).
//!
//! Either way the command surface, serde shapes, and the `terax:otel-ingest`
//! event are identical, so the frontend is unaffected by which mode is active.

pub mod collector;
mod convert;
mod ingest;
pub mod model;
mod store;

// Re-exported so the `otel-collector` sidecar binary (a separate crate root that
// links `terax_lib`) can build the collector without these being crate-private.
pub use ingest::IngestSink;
pub use store::{OtelStore, QueryResult};

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use shared_child::SharedChild;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::modules::sync::MutexExt;
use collector::{QueryRequest, EVENTS_PATH, QUERY_PREFIX};
use model::{LogQuery, LogRow, MetricRow, OtelCounts, SpanRow, TraceQuery, TraceSummary};

/// OTLP/HTTP ingest port. The OTLP convention is 4318; a +100 dev offset keeps a
/// `tauri dev` instance and an installed release from fighting over the bind
/// (mirrors the bunqueue port strategy). Apps in dev should target 4418.
const INGEST_PORT: u16 = if cfg!(debug_assertions) { 4418 } else { 4318 };

/// Loopback port the sidecar serves the query HTTP API + `/events` SSE on.
/// Distinct from the ingest port; same +100 dev offset so dev/release don't
/// collide. Only meaningful in sidecar mode (the in-process path calls the store
/// directly).
const QUERY_PORT: u16 = if cfg!(debug_assertions) { 4419 } else { 4319 };

/// Tauri externalBin base name (no triple, no extension) — must match the entry
/// added to `tauri.conf.json` `bundle.externalBin`.
const SIDECAR_BASE: &str = "otel-collector";

/// How the collector is running. `Sidecar` proxies queries over HTTP to the
/// child; `InProcess` calls a local store directly (dev fallback). Resolved once
/// in `init` and never changes for the process lifetime.
enum Backend {
    /// Out-of-process collector. `child` is held so its `Drop`/`kill` reaps the
    /// process on shutdown; the query API lives at `http://127.0.0.1:<port>`.
    Sidecar {
        #[allow(dead_code)]
        child: Arc<SharedChild>,
        query_base: String,
    },
    /// In-process store + ingest server (dev fallback).
    InProcess { store: Arc<OtelStore> },
}

/// Managed Tauri state: the resolved backend, installed in `init`. Before init
/// (or if resolution somehow fails) it falls back to an in-memory in-process
/// store so queries never hit an absent state.
#[derive(Default)]
pub struct OtelState {
    backend: Mutex<Option<Backend>>,
    /// Guards the one-time SSE bridge spawn in sidecar mode.
    bridge_started: AtomicBool,
}

impl OtelState {
    /// Resolve and install the backend. In a packaged build with the sidecar
    /// staged next to the exe, spawn it and use HTTP proxying; otherwise fall
    /// back to an in-process store + ingest server. Non-fatal throughout: any
    /// failure degrades to the in-memory in-process store.
    pub fn init(&self, app: &AppHandle, db_path: Option<PathBuf>) {
        let backend = match find_sidecar(SIDECAR_BASE) {
            Some(exe) => match spawn_sidecar(&exe, db_path.as_deref()) {
                Ok(child) => {
                    log::info!(
                        target: "otel",
                        "otel-collector sidecar started (ingest :{INGEST_PORT}, query :{QUERY_PORT})"
                    );
                    self.start_event_bridge(app);
                    Backend::Sidecar {
                        child,
                        query_base: format!("http://127.0.0.1:{QUERY_PORT}"),
                    }
                }
                Err(e) => {
                    log::warn!(target: "otel", "sidecar spawn failed ({e}); using in-process collector");
                    Self::in_process(app, db_path.as_deref())
                }
            },
            None => {
                log::info!(target: "otel", "no otel-collector sidecar staged; using in-process collector (dev)");
                Self::in_process(app, db_path.as_deref())
            }
        };
        *self.backend.lock_safe() = Some(backend);
    }

    /// Build the in-process backend: open the store and run the ingest server on
    /// the Tauri runtime with a sink that emits the `terax:otel-ingest` event.
    fn in_process(app: &AppHandle, db_path: Option<&Path>) -> Backend {
        let store = collector::open_store(db_path);
        let addr = SocketAddr::from(([127, 0, 0, 1], INGEST_PORT));
        let sink = event_sink(app.clone());
        collector::spawn_ingest(addr, store.clone(), sink);
        Backend::InProcess { store }
    }

    /// Spawn the background task that bridges the sidecar's `/events` SSE stream
    /// to the `terax:otel-ingest` Tauri event. Idempotent (guarded by an atomic)
    /// so a re-init can't start two bridges.
    fn start_event_bridge(&self, app: &AppHandle) {
        if self.bridge_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        let url = format!("http://127.0.0.1:{QUERY_PORT}{EVENTS_PATH}");
        tauri::async_runtime::spawn(async move {
            run_event_bridge(app, url).await;
        });
    }

    /// The active in-process store, if running in-process. `None` in sidecar
    /// mode. Opens an in-memory store on first access if `init` has not run.
    fn local_store(&self) -> Option<Arc<OtelStore>> {
        let mut guard = self.backend.lock_safe();
        match guard.get_or_insert_with(|| Backend::InProcess {
            store: Arc::new(OtelStore::open(Path::new(":memory:"))),
        }) {
            Backend::InProcess { store } => Some(store.clone()),
            Backend::Sidecar { .. } => None,
        }
    }

    /// The sidecar query base URL, if running in sidecar mode.
    fn query_base(&self) -> Option<String> {
        match self.backend.lock_safe().as_ref() {
            Some(Backend::Sidecar { query_base, .. }) => Some(query_base.clone()),
            _ => None,
        }
    }

    /// Kill the sidecar child (best-effort) on app shutdown so it doesn't
    /// outlive the app. No-op in in-process mode.
    pub fn shutdown(&self) {
        if let Some(Backend::Sidecar { child, .. }) = self.backend.lock_safe().as_ref() {
            let _ = child.kill();
        }
    }

    /// Run one query: either against the local store (in-process) or by proxying
    /// to the sidecar's query HTTP API. The dispatch shape (`QueryRequest` ->
    /// JSON) is shared with the sidecar so the two transports cannot drift.
    fn query(&self, req: QueryRequest) -> Result<Value, String> {
        if let Some(base) = self.query_base() {
            return proxy_query(&base, &req);
        }
        // In-process: dispatch directly against the local store.
        let store = self.local_store().expect("local store in in-process mode");
        collector::dispatch_query(&store, req)
    }
}

/// Resolve the OTEL DB path under the app data dir. Dev and release use separate
/// files since they ingest on different ports (4418 vs 4318) and must not share
/// one SQLite file. `None` -> in-memory fallback.
pub fn db_path(app: &AppHandle) -> Option<PathBuf> {
    let file = if cfg!(debug_assertions) {
        "otel-dev.db"
    } else {
        "otel.db"
    };
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("otel").join(file))
}

/// Resolve and install the collector backend (sidecar or in-process). Called
/// once from `setup()`.
pub fn start(app: &AppHandle, state: &OtelState) {
    state.init(app, db_path(app));
}

/// Locate the `otel-collector` sidecar next to the app binary. Tauri installs
/// `externalBin` sidecars alongside the main exe with the triple suffix
/// stripped, so `<exe-dir>/otel-collector(.exe)` is the resolved path in a
/// packaged build. `None` in dev (no sidecar staged) -> in-process fallback.
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

/// Spawn the sidecar with explicit loopback ports and an optional persistent DB
/// path. Output is inherited into the app's stdio (the sidecar logs to stderr).
fn spawn_sidecar(exe: &Path, db_path: Option<&Path>) -> Result<Arc<SharedChild>, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--ingest-port")
        .arg(INGEST_PORT.to_string())
        .arg("--query-port")
        .arg(QUERY_PORT.to_string());
    if let Some(p) = db_path {
        cmd.arg("--db-path").arg(p);
    }
    cmd.stdin(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);
    let child = SharedChild::spawn(&mut cmd).map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    Ok(Arc::new(child))
}

/// Build an `IngestSink` that emits the `terax:otel-ingest` Tauri event — the
/// in-process path's bridge between the ingest server and the dashboard. The
/// payload shape matches what the sidecar's SSE bridge emits.
fn event_sink(app: AppHandle) -> Arc<dyn IngestSink> {
    Arc::new(move |signal: &'static str, count: usize| {
        let _ = app.emit(
            "terax:otel-ingest",
            serde_json::json!({ "signal": signal, "count": count }),
        );
    })
}

/// Blocking HTTP proxy of one query command to the sidecar. Runs the async
/// reqwest call on the Tauri runtime via `block_on` — `otel_*` commands already
/// execute on Tauri's command worker threads, so blocking here is fine and keeps
/// the command bodies synchronous (matching their original signatures).
fn proxy_query(base: &str, req: &QueryRequest) -> Result<Value, String> {
    let url = format!("{base}{QUERY_PREFIX}{}", req_path(req));
    let body = serde_json::to_value(req).map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("otel sidecar request failed: {e}"))?;
        if resp.status().is_success() {
            resp.json::<Value>()
                .await
                .map_err(|e| format!("otel sidecar bad response: {e}"))
        } else {
            // The sidecar maps a query error to a non-2xx with the message body;
            // surface it verbatim so the Query page shows the SQL guard error.
            let msg = resp.text().await.unwrap_or_default();
            Err(msg)
        }
    })
}

/// The URL path component for a request — the snake_case command name, matching
/// `QueryRequest`'s `tag`/`rename_all`. Centralized so the client and the
/// sidecar router agree.
fn req_path(req: &QueryRequest) -> &'static str {
    match req {
        QueryRequest::Counts => "counts",
        QueryRequest::Services => "services",
        QueryRequest::Traces { .. } => "traces",
        QueryRequest::TraceSpans { .. } => "trace_spans",
        QueryRequest::Logs { .. } => "logs",
        QueryRequest::MetricNames => "metric_names",
        QueryRequest::MetricSeries { .. } => "metric_series",
        QueryRequest::ServiceMap { .. } => "service_map",
        QueryRequest::DbQueries { .. } => "db_queries",
        QueryRequest::AttributeKeys => "attribute_keys",
        QueryRequest::AttrBreakdown { .. } => "attr_breakdown",
        QueryRequest::Query { .. } => "query",
        QueryRequest::Clear => "clear",
    }
}

/// Connect to the sidecar's SSE `/events` stream and re-emit each ingest
/// notification as the `terax:otel-ingest` Tauri event. Reconnects with backoff:
/// the sidecar may not be listening for the first few ms after spawn, and a
/// dropped stream should resume rather than silently stop refreshing the
/// dashboard.
async fn run_event_bridge(app: AppHandle, url: String) {
    let client = reqwest::Client::new();
    let mut backoff = Duration::from_millis(200);
    loop {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                backoff = Duration::from_millis(200); // connected: reset backoff
                let mut stream = resp.bytes_stream();
                let mut buf = String::new();
                use futures_util::StreamExt;
                while let Some(chunk) = stream.next().await {
                    let Ok(bytes) = chunk else { break };
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // SSE frames are separated by a blank line; each carries one
                    // `data: <json>` line. Drain complete frames from the buffer.
                    while let Some(idx) = buf.find("\n\n") {
                        let frame = buf[..idx].to_string();
                        buf.drain(..idx + 2);
                        if let Some(payload) = parse_sse_data(&frame) {
                            let _ = app.emit("terax:otel-ingest", payload);
                        }
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}

/// Extract the JSON payload from a single SSE frame's `data:` line.
fn parse_sse_data(frame: &str) -> Option<Value> {
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            return serde_json::from_str(rest.trim()).ok();
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tauri command surface. Signatures and serde shapes are unchanged from the
// original in-process version, so the frontend bindings (`lib/useOtel.ts`) need
// no edits. Each command builds a `QueryRequest` and runs it through the backend
// (local store or sidecar proxy). `expect`/`unwrap` on deserialize is safe: the
// values come straight back from the store/sidecar in their own serde shape.
// ---------------------------------------------------------------------------

/// The port apps should export OTLP/HTTP to. Surfaced to the dashboard so it can
/// show the user the exact endpoint to configure.
#[tauri::command]
pub fn otel_ingest_port() -> u16 {
    INGEST_PORT
}

fn from_json<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("otel result deserializes into its own type")
}

#[tauri::command]
pub fn otel_counts(state: State<'_, OtelState>) -> OtelCounts {
    from_json(state.query(QueryRequest::Counts).unwrap_or_default())
}

#[tauri::command]
pub fn otel_services(state: State<'_, OtelState>) -> Vec<String> {
    from_json(state.query(QueryRequest::Services).unwrap_or_default())
}

#[tauri::command]
pub fn otel_traces(state: State<'_, OtelState>, query: Option<TraceQuery>) -> Vec<TraceSummary> {
    from_json(state.query(QueryRequest::Traces { query }).unwrap_or_default())
}

#[tauri::command]
pub fn otel_trace_spans(state: State<'_, OtelState>, trace_id: String) -> Vec<SpanRow> {
    from_json(
        state
            .query(QueryRequest::TraceSpans { trace_id })
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub fn otel_logs(state: State<'_, OtelState>, query: Option<LogQuery>) -> Vec<LogRow> {
    from_json(state.query(QueryRequest::Logs { query }).unwrap_or_default())
}

#[tauri::command]
pub fn otel_metric_names(state: State<'_, OtelState>) -> Vec<serde_json::Value> {
    from_json(state.query(QueryRequest::MetricNames).unwrap_or_default())
}

#[tauri::command]
pub fn otel_metric_series(
    state: State<'_, OtelState>,
    name: String,
    limit: Option<i64>,
) -> Vec<MetricRow> {
    from_json(
        state
            .query(QueryRequest::MetricSeries { name, limit })
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub fn otel_service_map(state: State<'_, OtelState>, since_ms: Option<i64>) -> model::ServiceMap {
    from_json(
        state
            .query(QueryRequest::ServiceMap { since_ms })
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub fn otel_db_queries(
    state: State<'_, OtelState>,
    since_ms: Option<i64>,
) -> Vec<model::DbStatement> {
    from_json(
        state
            .query(QueryRequest::DbQueries { since_ms })
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub fn otel_attribute_keys(state: State<'_, OtelState>) -> Vec<String> {
    from_json(state.query(QueryRequest::AttributeKeys).unwrap_or_default())
}

#[tauri::command]
pub fn otel_attr_breakdown(
    state: State<'_, OtelState>,
    key: String,
    since_ms: Option<i64>,
    limit: Option<i64>,
) -> Vec<model::AttrGroup> {
    from_json(
        state
            .query(QueryRequest::AttrBreakdown { key, since_ms, limit })
            .unwrap_or_default(),
    )
}

#[tauri::command]
pub fn otel_clear(state: State<'_, OtelState>) {
    let _ = state.query(QueryRequest::Clear);
}

/// Run a read-only SELECT against the telemetry store (the Query page). Returns
/// columns + JSON rows, or an error string when the SQL is rejected by the
/// read-only guard or fails to execute. `limit` caps returned rows (default
/// 1000); `offset` windows the result for infinite-scroll paging (default 0).
#[tauri::command]
pub fn otel_query(
    state: State<'_, OtelState>,
    sql: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<QueryResult, String> {
    let v = state.query(QueryRequest::Query { sql, limit, offset })?;
    Ok(from_json(v))
}
