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

mod convert;
mod ingest;
mod model;
mod store;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use crate::modules::sync::MutexExt;
use model::{LogQuery, LogRow, MetricRow, OtelCounts, SpanRow, TraceQuery, TraceSummary};
use store::OtelStore;

/// OTLP/HTTP port. The OTLP convention is 4318; a +100 dev offset keeps a
/// `tauri dev` instance and an installed release from fighting over the bind
/// (mirrors the bunqueue port strategy). Apps in dev should target 4418.
const INGEST_PORT: u16 = if cfg!(debug_assertions) { 4418 } else { 4318 };

/// Managed Tauri state: the shared store, lazily opened in `setup()` once the
/// app data dir is resolvable. Before init (or on open failure) it falls back to
/// an in-memory store so queries never hit an absent state. The ingest server
/// and every query command resolve the store through `store()`.
#[derive(Default)]
pub struct OtelState {
    store: Mutex<Option<Arc<OtelStore>>>,
}

impl OtelState {
    /// Open the store at `db_path` (creating parent dirs) and install it. Called
    /// once from `setup()`. A `None` path or an open failure yields the in-memory
    /// fallback so the rest of the system keeps working.
    pub fn init(&self, db_path: Option<PathBuf>) {
        let store = match db_path {
            Some(p) => {
                if let Some(parent) = p.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                OtelStore::open(&p)
            }
            None => OtelStore::open(std::path::Path::new(":memory:")),
        };
        *self.store.lock_safe() = Some(Arc::new(store));
    }

    /// The active store, opening an in-memory one on first access if `init` has
    /// not run yet. Cheap clone of the `Arc`.
    fn store(&self) -> Arc<OtelStore> {
        let mut guard = self.store.lock_safe();
        guard
            .get_or_insert_with(|| Arc::new(OtelStore::open(std::path::Path::new(":memory:"))))
            .clone()
    }
}

/// Resolve the OTEL DB path under the app data dir. Dev and release use separate
/// files since they ingest on different ports (4418 vs 4318) and must not share
/// one SQLite file. `None` -> in-memory fallback.
pub fn db_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
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

/// Spawn the OTLP ingest server on the Tauri async runtime. Non-fatal: a bind
/// failure (port taken) is logged inside `serve` and the dashboard still works
/// against whatever is already stored.
pub fn start_ingest(app: &AppHandle, state: &OtelState) {
    let store = state.store();
    let app = app.clone();
    let addr = SocketAddr::from(([127, 0, 0, 1], INGEST_PORT));
    tauri::async_runtime::spawn(async move {
        ingest::serve(addr, store, app).await;
    });
}

/// The port apps should export OTLP/HTTP to. Surfaced to the dashboard so it can
/// show the user the exact endpoint to configure.
#[tauri::command]
pub fn otel_ingest_port() -> u16 {
    INGEST_PORT
}

#[tauri::command]
pub fn otel_counts(state: State<'_, OtelState>) -> OtelCounts {
    state.store().counts()
}

#[tauri::command]
pub fn otel_services(state: State<'_, OtelState>) -> Vec<String> {
    state.store().services()
}

#[tauri::command]
pub fn otel_traces(state: State<'_, OtelState>, query: Option<TraceQuery>) -> Vec<TraceSummary> {
    state.store().traces(&query.unwrap_or_default())
}

#[tauri::command]
pub fn otel_trace_spans(state: State<'_, OtelState>, trace_id: String) -> Vec<SpanRow> {
    state.store().trace_spans(&trace_id)
}

#[tauri::command]
pub fn otel_logs(state: State<'_, OtelState>, query: Option<LogQuery>) -> Vec<LogRow> {
    state.store().logs(&query.unwrap_or_default())
}

#[tauri::command]
pub fn otel_metric_names(state: State<'_, OtelState>) -> Vec<serde_json::Value> {
    state.store().metric_names()
}

#[tauri::command]
pub fn otel_metric_series(
    state: State<'_, OtelState>,
    name: String,
    limit: Option<i64>,
) -> Vec<MetricRow> {
    state.store().metric_series(&name, limit.unwrap_or(500))
}

#[tauri::command]
pub fn otel_service_map(state: State<'_, OtelState>, since_ms: Option<i64>) -> model::ServiceMap {
    state.store().service_map(since_ms)
}

#[tauri::command]
pub fn otel_db_queries(
    state: State<'_, OtelState>,
    since_ms: Option<i64>,
) -> Vec<model::DbStatement> {
    state.store().db_queries(since_ms)
}

#[tauri::command]
pub fn otel_attribute_keys(state: State<'_, OtelState>) -> Vec<String> {
    state.store().attribute_keys()
}

#[tauri::command]
pub fn otel_attr_breakdown(
    state: State<'_, OtelState>,
    key: String,
    since_ms: Option<i64>,
    limit: Option<i64>,
) -> Vec<model::AttrGroup> {
    state.store().attr_breakdown(&key, since_ms, limit.unwrap_or(100))
}

#[tauri::command]
pub fn otel_clear(state: State<'_, OtelState>) {
    state.store().clear();
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
) -> Result<store::QueryResult, String> {
    state
        .store()
        .query(&sql, limit.unwrap_or(1000), offset.unwrap_or(0))
}
