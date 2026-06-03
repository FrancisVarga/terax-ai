//! Collector core shared by the in-process path and the `otel-collector`
//! sidecar binary.
//!
//! The OTEL backend can run two ways:
//!   - IN-PROCESS (dev): `mod.rs` opens the store, runs `ingest::serve` on the
//!     Tauri async runtime, and the `otel_*` commands call the store directly.
//!   - SIDECAR (packaged): the `otel-collector` binary opens the store, runs
//!     `ingest::serve` AND a query HTTP server built on `dispatch_query` below,
//!     and the `otel_*` commands proxy to it over HTTP.
//!
//! `dispatch_query` is the single source of truth for the query surface: it maps
//! a command name + JSON args onto an `OtelStore` call and returns JSON. Both the
//! sidecar's HTTP router and the (unit-tested) request model go through it, so
//! the two transports can never drift in what they expose.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::ingest::{self, IngestSink};
use super::model::{LogQuery, TraceQuery};
use super::store::OtelStore;

/// Path component under which every query command is served by the sidecar:
/// `POST /q/<command>` with a JSON body of the command's args. Kept here so the
/// server and the client agree without a magic string in two files.
pub const QUERY_PREFIX: &str = "/q/";

/// The SSE endpoint the sidecar exposes; the app bridges it to the
/// `terax:otel-ingest` Tauri event.
pub const EVENTS_PATH: &str = "/events";

/// A query request as it crosses the HTTP boundary (and, in dev, as the shape
/// the proxy serializes). One variant per `otel_*` command. `rename_all` matches
/// the command name used in the URL path so routing is a plain string compare.
///
/// Kept as an explicit enum (rather than free-form) so `dispatch_query` is
/// exhaustive: adding a command is a compile error until it is handled.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum QueryRequest {
    Counts,
    Services,
    Traces { query: Option<TraceQuery> },
    TraceSpans { trace_id: String },
    Logs { query: Option<LogQuery> },
    MetricNames,
    MetricSeries { name: String, limit: Option<i64> },
    ServiceMap { since_ms: Option<i64> },
    DbQueries { since_ms: Option<i64> },
    AttributeKeys,
    AttrBreakdown { key: String, since_ms: Option<i64>, limit: Option<i64> },
    Query { sql: String, limit: Option<i64>, offset: Option<i64> },
    Clear,
}

/// Run one query against `store` and render the result as JSON. Errors (only the
/// read-only `Query` can fail) become an `Err(String)` the HTTP layer maps to a
/// 400 with the message — matching the in-process command's `Result<_, String>`.
pub fn dispatch_query(store: &OtelStore, req: QueryRequest) -> Result<Value, String> {
    let v = match req {
        QueryRequest::Counts => json!(store.counts()),
        QueryRequest::Services => json!(store.services()),
        QueryRequest::Traces { query } => json!(store.traces(&query.unwrap_or_default())),
        QueryRequest::TraceSpans { trace_id } => json!(store.trace_spans(&trace_id)),
        QueryRequest::Logs { query } => json!(store.logs(&query.unwrap_or_default())),
        QueryRequest::MetricNames => json!(store.metric_names()),
        QueryRequest::MetricSeries { name, limit } => {
            json!(store.metric_series(&name, limit.unwrap_or(500)))
        }
        QueryRequest::ServiceMap { since_ms } => json!(store.service_map(since_ms)),
        QueryRequest::DbQueries { since_ms } => json!(store.db_queries(since_ms)),
        QueryRequest::AttributeKeys => json!(store.attribute_keys()),
        QueryRequest::AttrBreakdown { key, since_ms, limit } => {
            json!(store.attr_breakdown(&key, since_ms, limit.unwrap_or(100)))
        }
        QueryRequest::Query { sql, limit, offset } => {
            // The only fallible command: surface its Err to the caller.
            json!(store.query(&sql, limit.unwrap_or(1000), offset.unwrap_or(0))?)
        }
        QueryRequest::Clear => {
            store.clear();
            Value::Null
        }
    };
    Ok(v)
}

/// Open the store at `db_path` (creating parent dirs), falling back to memory on
/// failure. Shared by the in-process init and the sidecar's `main`.
pub fn open_store(db_path: Option<&Path>) -> Arc<OtelStore> {
    let store = match db_path {
        Some(p) => {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            OtelStore::open(p)
        }
        None => OtelStore::open(Path::new(":memory:")),
    };
    Arc::new(store)
}

/// Spawn the OTLP ingest server on the current tokio runtime. `sink` is notified
/// after each non-empty batch. Returns immediately; the server runs until the
/// task is dropped / the process exits.
pub fn spawn_ingest(addr: SocketAddr, store: Arc<OtelStore>, sink: Arc<dyn IngestSink>) {
    tokio::spawn(async move {
        ingest::serve(addr, store, sink).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::otel::model::SpanRow;
    use serde_json::json;

    fn seeded_store() -> OtelStore {
        let store = OtelStore::in_memory();
        store.insert_spans(&[SpanRow {
            trace_id: "t1".into(),
            span_id: "a".into(),
            parent_span_id: String::new(),
            name: "root".into(),
            service: "svc".into(),
            kind: 2,
            start_nano: 1000,
            end_nano: 2000,
            duration_nano: 1000,
            status_code: 0,
            status_message: String::new(),
            scope_name: "scope".into(),
            attributes: json!({ "tenant.id": "acme" }),
            resource: json!({ "service.name": "svc" }),
            events: json!([]),
            received_ms: 1,
        }]);
        store
    }

    /// A `QueryRequest` survives the JSON round-trip the proxy + sidecar perform
    /// (serialize on the app side, deserialize on the sidecar side) and yields
    /// the same result as dispatching directly. This guards the wire contract
    /// the in-process and sidecar transports both rely on.
    #[test]
    fn query_request_round_trips_through_json() {
        let store = seeded_store();
        let req = QueryRequest::Traces {
            query: Some(TraceQuery::default()),
        };
        // App side: serialize. Sidecar side: deserialize the same bytes.
        let wire = serde_json::to_vec(&req).unwrap();
        let parsed: QueryRequest = serde_json::from_slice(&wire).unwrap();
        let out = dispatch_query(&store, parsed).unwrap();
        let traces = out.as_array().expect("traces is a JSON array");
        assert_eq!(traces.len(), 1);
        assert_eq!(traces[0]["traceId"], "t1");
    }

    /// `counts` and `services` dispatch to the right store call and serialize in
    /// the camelCase shape the frontend expects.
    #[test]
    fn counts_and_services_dispatch() {
        let store = seeded_store();
        let counts = dispatch_query(&store, QueryRequest::Counts).unwrap();
        assert_eq!(counts["spans"], 1);
        assert_eq!(counts["traces"], 1);
        // camelCase field from OtelCounts serde.
        assert!(counts.get("dbBytes").is_some(), "dbBytes present (camelCase)");

        let services = dispatch_query(&store, QueryRequest::Services).unwrap();
        assert_eq!(services, json!(["svc"]));
    }

    /// The fallible `Query` command surfaces the read-only guard error as `Err`,
    /// which the sidecar maps to a 400 and the proxy passes through verbatim.
    #[test]
    fn query_command_propagates_guard_error() {
        let store = seeded_store();
        let req = QueryRequest::Query {
            sql: "DELETE FROM spans".into(),
            limit: None,
            offset: None,
        };
        let err = dispatch_query(&store, req).unwrap_err();
        assert!(err.contains("read-only"), "guard rejects non-SELECT: {err}");
    }

    /// `Clear` returns JSON null (the unit command) and empties the store.
    #[test]
    fn clear_dispatch_empties_store() {
        let store = seeded_store();
        let out = dispatch_query(&store, QueryRequest::Clear).unwrap();
        assert!(out.is_null());
        let counts = dispatch_query(&store, QueryRequest::Counts).unwrap();
        assert_eq!(counts["spans"], 0);
    }
}
