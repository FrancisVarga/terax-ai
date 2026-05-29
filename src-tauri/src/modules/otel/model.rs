//! Normalized telemetry row model.
//!
//! OTLP nests resource -> scope -> signal. For storage and dashboard queries we
//! flatten that tree into row structs, denormalizing `service.name` (the primary
//! grouping key) onto every row and carrying the remaining resource/scope
//! attributes as a JSON blob. This keeps queries flat (`WHERE service = ?`,
//! `ORDER BY start_nano`) instead of recursive joins, at the cost of repeating a
//! few resource attributes per row, which is the right trade for a bounded local
//! store.
//!
//! These structs are the single source of truth shared by the store (SQLite
//! columns), the converter (OTLP -> rows), and the Tauri command surface (serde
//! to the frontend). serde uses camelCase so the TS types read naturally.

use serde::{Deserialize, Serialize};

/// One span. `trace_id`/`span_id` are lowercase hex (32 / 16 chars) so they are
/// stable string keys for waterfall assembly and log correlation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanRow {
    pub trace_id: String,
    pub span_id: String,
    /// Empty string for a root span.
    pub parent_span_id: String,
    pub name: String,
    pub service: String,
    /// SpanKind: 0 UNSPECIFIED, 1 INTERNAL, 2 SERVER, 3 CLIENT, 4 PRODUCER, 5 CONSUMER.
    pub kind: i32,
    pub start_nano: u64,
    pub end_nano: u64,
    /// Convenience for the UI: (end - start) in nanoseconds, clamped at 0.
    pub duration_nano: u64,
    /// StatusCode: 0 UNSET, 1 OK, 2 ERROR.
    pub status_code: i32,
    pub status_message: String,
    pub scope_name: String,
    /// Span attributes as `{ key: jsonValue }`.
    pub attributes: serde_json::Value,
    /// Resource attributes as `{ key: jsonValue }`.
    pub resource: serde_json::Value,
    /// Span events: `[{ name, timeNano, attributes }]`.
    pub events: serde_json::Value,
    /// Wall-clock ingest time (ms since epoch). Drives retention pruning.
    pub received_ms: i64,
}

/// One log record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub time_nano: u64,
    pub observed_time_nano: u64,
    /// SeverityNumber 1..24 (0 = unspecified). 1-4 TRACE, 5-8 DEBUG, 9-12 INFO,
    /// 13-16 WARN, 17-20 ERROR, 21-24 FATAL.
    pub severity_number: i32,
    pub severity_text: String,
    /// Log body rendered to a display string (AnyValue -> text).
    pub body: String,
    pub service: String,
    pub scope_name: String,
    /// Hex trace id for log<->trace correlation, or empty.
    pub trace_id: String,
    pub span_id: String,
    pub attributes: serde_json::Value,
    pub resource: serde_json::Value,
    pub received_ms: i64,
}

/// One metric data point. Each OTLP NumberDataPoint / HistogramDataPoint becomes
/// one row; the shape-specific fields live in `value` as JSON so a single table
/// covers gauge / sum / histogram without per-type columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricRow {
    pub name: String,
    pub description: String,
    pub unit: String,
    /// "gauge" | "sum" | "histogram" | "exponentialHistogram" | "summary".
    pub kind: String,
    /// Monotonicity for sums; null otherwise.
    pub is_monotonic: Option<bool>,
    /// AggregationTemporality: 0 unspecified, 1 delta, 2 cumulative.
    pub temporality: i32,
    pub service: String,
    pub scope_name: String,
    pub time_nano: u64,
    pub start_nano: u64,
    /// For gauge/sum: `{ "asDouble": n }` or `{ "asInt": n }`. For histogram:
    /// `{ count, sum, bucketCounts, explicitBounds, min, max }`.
    pub value: serde_json::Value,
    /// Data-point attributes (the metric's label set).
    pub attributes: serde_json::Value,
    pub resource: serde_json::Value,
    pub received_ms: i64,
}

/// Summary row for the traces list: one entry per trace id, aggregated.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub trace_id: String,
    /// Name of the root span (or the earliest span if no root is present).
    pub root_name: String,
    pub root_service: String,
    pub start_nano: u64,
    /// Wall span of the whole trace (max end - min start).
    pub duration_nano: u64,
    pub span_count: i64,
    /// True if any span in the trace has status ERROR (2).
    pub has_error: bool,
    pub received_ms: i64,
}

/// Counts shown in the dashboard header / used to drive empty states.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OtelCounts {
    pub traces: i64,
    pub spans: i64,
    pub logs: i64,
    pub metrics: i64,
    /// Approximate on-disk size of the store in bytes.
    pub db_bytes: i64,
}

/// Filter args for the logs query. All optional; absent = no constraint.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub service: Option<String>,
    /// Minimum severity number (inclusive). 9 = INFO and above, etc.
    pub min_severity: Option<i32>,
    /// Case-insensitive substring match against the body.
    pub search: Option<String>,
    pub trace_id: Option<String>,
    /// Only records received at or after this epoch-ms (time window).
    pub since_ms: Option<i64>,
    /// Case-insensitive substring match against the attributes JSON
    /// (e.g. `tenant.id` or a value).
    pub attr_search: Option<String>,
    pub limit: Option<i64>,
}

/// Sort order for the traces list.
#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TraceSort {
    /// Newest first (by start time). Default.
    #[default]
    Recent,
    /// Slowest first (by total trace duration).
    Slowest,
}

/// Filter args for the traces query.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TraceQuery {
    pub service: Option<String>,
    /// Only traces containing an error span.
    pub errors_only: Option<bool>,
    /// Substring match against the root span name.
    pub search: Option<String>,
    /// Only traces whose total duration is at least this many nanoseconds.
    pub min_duration_nano: Option<u64>,
    /// Only traces received at or after this epoch-ms (time window).
    pub since_ms: Option<i64>,
    /// Match traces that contain a span whose attributes JSON contains this
    /// substring (e.g. `http.response.status_code":500` or a tenant id).
    pub attr_search: Option<String>,
    pub sort: Option<TraceSort>,
    pub limit: Option<i64>,
}

/// One directed edge of the service dependency graph: calls from one service to
/// another, derived from cross-service parent/child span links.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEdge {
    pub from: String,
    pub to: String,
    /// Number of cross-service calls observed on this edge.
    pub calls: i64,
    /// Calls whose child span errored.
    pub errors: i64,
    /// p50 / p95 child-span duration in nanoseconds.
    pub p50_nano: u64,
    pub p95_nano: u64,
}

/// One node of the service graph: a service plus its own call/error totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceNode {
    pub service: String,
    pub spans: i64,
    pub errors: i64,
}

/// The service dependency graph for the mesh view.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMap {
    pub nodes: Vec<ServiceNode>,
    pub edges: Vec<ServiceEdge>,
}

/// One aggregated group for the attribute-breakdown ("user / tenant") dashboard.
/// Spans are grouped by the value of a chosen attribute key (e.g. `tenant.id`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrGroup {
    /// The attribute value this group represents (e.g. a tenant id).
    pub value: String,
    pub spans: i64,
    pub traces: i64,
    pub errors: i64,
    pub avg_nano: u64,
    pub p95_nano: u64,
    /// Most-recent activity for this group (epoch ms).
    pub last_seen_ms: i64,
    /// Top operation names for this group, busiest first (up to a few).
    pub top_ops: Vec<String>,
}

/// One aggregated database statement for the DB dashboard. Rows are grouped by
/// the normalized `db.statement` (or span name when absent) of `db.system` spans.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStatement {
    pub statement: String,
    /// db.system value (e.g. "postgresql"), best-effort.
    pub system: String,
    pub service: String,
    pub calls: i64,
    pub errors: i64,
    pub avg_nano: u64,
    pub p95_nano: u64,
    pub max_nano: u64,
    /// Sum of all call durations (nanoseconds) - the total time in this query.
    pub total_nano: u64,
}
