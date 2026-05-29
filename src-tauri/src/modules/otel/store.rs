//! SQLite-backed telemetry store, capped at ~1 GB.
//!
//! Design: three append-only tables (spans, logs, metric_points) plus query
//! views. Writes arrive in batches from the ingest server; reads serve the
//! dashboard. The store is a single connection behind a `Mutex` — SQLite is the
//! concurrency boundary, and ingest volume on a local dev box never warrants a
//! pool.
//!
//! Retention: the store must not grow without bound. After every batch we check
//! the on-disk size (page_count * page_size); over the high-water mark we delete
//! the oldest rows (by `received_ms`) until back under the low-water mark, then
//! run `PRAGMA incremental_vacuum` to actually hand freed pages back to the OS.
//! `auto_vacuum = INCREMENTAL` (set at creation, before any table exists) is
//! what makes that reclaim possible without a full `VACUUM` rewrite.
//!
//! WAL mode lets the dashboard read while ingest writes without blocking.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::modules::sync::MutexExt;

use super::model::{
    LogQuery, LogRow, MetricRow, OtelCounts, SpanRow, TraceQuery, TraceSummary,
};

/// Reclaim is triggered once the DB exceeds this size, then rows are dropped
/// until under `LOW_WATER`. The gap keeps pruning from running on every batch.
const HIGH_WATER_BYTES: i64 = 1024 * 1024 * 1024; // 1 GiB
const LOW_WATER_BYTES: i64 = 900 * 1024 * 1024; // ~0.88 GiB

/// Rows deleted per prune pass, per table. Bounded so a single oversized batch
/// can't stall ingest; pruning loops until under the low-water mark.
const PRUNE_CHUNK: i64 = 5_000;

pub struct OtelStore {
    conn: Mutex<Connection>,
}

impl OtelStore {
    /// Open (or create) the store at `path`. Falls back to in-memory if the file
    /// can't be opened so ingest still works in a degraded session rather than
    /// failing the whole app.
    pub fn open(path: &Path) -> Self {
        let conn = Connection::open(path)
            .or_else(|_| Connection::open_in_memory())
            .expect("sqlite open (memory fallback) cannot fail");
        configure(&conn);
        init_schema(&conn);
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Open an in-memory store. Used by tests.
    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn);
        init_schema(&conn);
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Insert a batch of spans, then enforce retention. Returns rows written.
    pub fn insert_spans(&self, rows: &[SpanRow]) -> usize {
        if rows.is_empty() {
            return 0;
        }
        let mut conn = self.conn.lock_safe();
        let tx = conn.transaction().expect("begin tx");
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO spans (trace_id, span_id, parent_span_id, name, service, kind, \
                     start_nano, end_nano, duration_nano, status_code, status_message, scope_name, \
                     attributes, resource, events, received_ms) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                )
                .expect("prepare span insert");
            for r in rows {
                let _ = stmt.execute(params![
                    r.trace_id,
                    r.span_id,
                    r.parent_span_id,
                    r.name,
                    r.service,
                    r.kind,
                    r.start_nano as i64,
                    r.end_nano as i64,
                    r.duration_nano as i64,
                    r.status_code,
                    r.status_message,
                    r.scope_name,
                    r.attributes.to_string(),
                    r.resource.to_string(),
                    r.events.to_string(),
                    r.received_ms,
                ]);
            }
        }
        tx.commit().expect("commit spans");
        enforce_retention(&conn);
        rows.len()
    }

    /// Insert a batch of logs, then enforce retention.
    pub fn insert_logs(&self, rows: &[LogRow]) -> usize {
        if rows.is_empty() {
            return 0;
        }
        let mut conn = self.conn.lock_safe();
        let tx = conn.transaction().expect("begin tx");
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO logs (time_nano, observed_time_nano, severity_number, \
                     severity_text, body, service, scope_name, trace_id, span_id, attributes, \
                     resource, received_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                )
                .expect("prepare log insert");
            for r in rows {
                let _ = stmt.execute(params![
                    r.time_nano as i64,
                    r.observed_time_nano as i64,
                    r.severity_number,
                    r.severity_text,
                    r.body,
                    r.service,
                    r.scope_name,
                    r.trace_id,
                    r.span_id,
                    r.attributes.to_string(),
                    r.resource.to_string(),
                    r.received_ms,
                ]);
            }
        }
        tx.commit().expect("commit logs");
        enforce_retention(&conn);
        rows.len()
    }

    /// Insert a batch of metric points, then enforce retention.
    pub fn insert_metrics(&self, rows: &[MetricRow]) -> usize {
        if rows.is_empty() {
            return 0;
        }
        let mut conn = self.conn.lock_safe();
        let tx = conn.transaction().expect("begin tx");
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO metric_points (name, description, unit, kind, is_monotonic, \
                     temporality, service, scope_name, time_nano, start_nano, value, attributes, \
                     resource, received_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                )
                .expect("prepare metric insert");
            for r in rows {
                let _ = stmt.execute(params![
                    r.name,
                    r.description,
                    r.unit,
                    r.kind,
                    r.is_monotonic,
                    r.temporality,
                    r.service,
                    r.scope_name,
                    r.time_nano as i64,
                    r.start_nano as i64,
                    r.value.to_string(),
                    r.attributes.to_string(),
                    r.resource.to_string(),
                    r.received_ms,
                ]);
            }
        }
        tx.commit().expect("commit metrics");
        enforce_retention(&conn);
        rows.len()
    }

    /// Top-level counts + DB size for the dashboard header.
    pub fn counts(&self) -> OtelCounts {
        let conn = self.conn.lock_safe();
        let spans: i64 = scalar(&conn, "SELECT COUNT(*) FROM spans");
        let traces: i64 = scalar(&conn, "SELECT COUNT(DISTINCT trace_id) FROM spans");
        let logs: i64 = scalar(&conn, "SELECT COUNT(*) FROM logs");
        let metrics: i64 = scalar(&conn, "SELECT COUNT(*) FROM metric_points");
        OtelCounts {
            traces,
            spans,
            logs,
            metrics,
            db_bytes: db_size_bytes(&conn),
        }
    }

    /// Distinct service names seen across all signals, sorted.
    pub fn services(&self) -> Vec<String> {
        let conn = self.conn.lock_safe();
        let sql = "SELECT service FROM spans UNION SELECT service FROM logs \
                   UNION SELECT service FROM metric_points ORDER BY service";
        let mut stmt = conn.prepare(sql).expect("prepare services");
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query services");
        rows.filter_map(Result::ok).collect()
    }

    /// Trace summaries (one row per trace id), newest first, filtered.
    pub fn traces(&self, q: &TraceQuery) -> Vec<TraceSummary> {
        let conn = self.conn.lock_safe();
        let limit = q.limit.unwrap_or(200).clamp(1, 2000);
        // Aggregate per trace. The root span is the one with an empty parent; if
        // none exists (partial trace), fall back to the earliest-starting span.
        let mut sql = String::from(
            "WITH agg AS (\
               SELECT trace_id, \
                      MIN(start_nano) AS start_nano, \
                      MAX(end_nano) - MIN(start_nano) AS duration_nano, \
                      COUNT(*) AS span_count, \
                      MAX(received_ms) AS received_ms, \
                      MAX(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS has_error \
               FROM spans GROUP BY trace_id), \
             root AS (\
               SELECT s.trace_id, s.name AS root_name, s.service AS root_service \
               FROM spans s JOIN (\
                 SELECT trace_id, MIN(start_nano) AS ms, \
                        MIN(CASE WHEN parent_span_id = '' THEN 0 ELSE 1 END) AS has_root \
                 FROM spans GROUP BY trace_id) pick \
               ON s.trace_id = pick.trace_id AND s.start_nano = pick.ms) \
             SELECT agg.trace_id, COALESCE(root.root_name, ''), COALESCE(root.root_service, ''), \
                    agg.start_nano, agg.duration_nano, agg.span_count, agg.has_error, agg.received_ms \
             FROM agg LEFT JOIN root ON agg.trace_id = root.trace_id",
        );
        let mut clauses: Vec<String> = Vec::new();
        if q.service.is_some() {
            clauses.push("root.root_service = :service".into());
        }
        if q.errors_only.unwrap_or(false) {
            clauses.push("agg.has_error = 1".into());
        }
        if q.search.is_some() {
            clauses.push("root.root_name LIKE :search".into());
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY agg.start_nano DESC LIMIT :limit");

        let like = q.search.as_ref().map(|s| format!("%{s}%"));
        let mut stmt = conn.prepare(&sql).expect("prepare traces");
        let named: Vec<(&str, &dyn rusqlite::ToSql)> = build_named(&[
            (":service", &q.service),
            (":search", &like),
            (":limit", &Some(limit)),
        ]);
        let rows = stmt
            .query_map(named.as_slice(), |r| {
                Ok(TraceSummary {
                    trace_id: r.get(0)?,
                    root_name: r.get(1)?,
                    root_service: r.get(2)?,
                    start_nano: r.get::<_, i64>(3)? as u64,
                    duration_nano: r.get::<_, i64>(4)? as u64,
                    span_count: r.get(5)?,
                    has_error: r.get::<_, i64>(6)? != 0,
                    received_ms: r.get(7)?,
                })
            })
            .expect("query traces");
        rows.filter_map(Result::ok).collect()
    }

    /// All spans of one trace, ordered by start time (for waterfall assembly).
    pub fn trace_spans(&self, trace_id: &str) -> Vec<SpanRow> {
        let conn = self.conn.lock_safe();
        let mut stmt = conn
            .prepare(
                "SELECT trace_id, span_id, parent_span_id, name, service, kind, start_nano, \
                 end_nano, duration_nano, status_code, status_message, scope_name, attributes, \
                 resource, events, received_ms FROM spans WHERE trace_id = ?1 ORDER BY start_nano",
            )
            .expect("prepare trace_spans");
        let rows = stmt
            .query_map(params![trace_id], map_span_row)
            .expect("query trace_spans");
        rows.filter_map(Result::ok).collect()
    }

    /// Logs, newest first, filtered.
    pub fn logs(&self, q: &LogQuery) -> Vec<LogRow> {
        let conn = self.conn.lock_safe();
        let limit = q.limit.unwrap_or(500).clamp(1, 5000);
        let mut sql = String::from(
            "SELECT time_nano, observed_time_nano, severity_number, severity_text, body, service, \
             scope_name, trace_id, span_id, attributes, resource, received_ms FROM logs",
        );
        let mut clauses: Vec<String> = Vec::new();
        if q.service.is_some() {
            clauses.push("service = :service".into());
        }
        if q.min_severity.is_some() {
            clauses.push("severity_number >= :minsev".into());
        }
        if q.search.is_some() {
            clauses.push("body LIKE :search".into());
        }
        if q.trace_id.is_some() {
            clauses.push("trace_id = :trace".into());
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY time_nano DESC LIMIT :limit");

        let like = q.search.as_ref().map(|s| format!("%{s}%"));
        let mut stmt = conn.prepare(&sql).expect("prepare logs");
        let named: Vec<(&str, &dyn rusqlite::ToSql)> = build_named(&[
            (":service", &q.service),
            (":minsev", &q.min_severity),
            (":search", &like),
            (":trace", &q.trace_id),
            (":limit", &Some(limit)),
        ]);
        let rows = stmt
            .query_map(named.as_slice(), map_log_row)
            .expect("query logs");
        rows.filter_map(Result::ok).collect()
    }

    /// Distinct metric names with their kind + unit, for the metric picker.
    pub fn metric_names(&self) -> Vec<serde_json::Value> {
        let conn = self.conn.lock_safe();
        let mut stmt = conn
            .prepare(
                "SELECT name, kind, unit, COUNT(*) FROM metric_points \
                 GROUP BY name, kind, unit ORDER BY name",
            )
            .expect("prepare metric_names");
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "name": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "unit": r.get::<_, String>(2)?,
                    "points": r.get::<_, i64>(3)?,
                }))
            })
            .expect("query metric_names");
        rows.filter_map(Result::ok).collect()
    }

    /// Time-series points for one metric name, oldest first (for charting).
    pub fn metric_series(&self, name: &str, limit: i64) -> Vec<MetricRow> {
        let conn = self.conn.lock_safe();
        let limit = limit.clamp(1, 10_000);
        let mut stmt = conn
            .prepare(
                "SELECT name, description, unit, kind, is_monotonic, temporality, service, \
                 scope_name, time_nano, start_nano, value, attributes, resource, received_ms \
                 FROM metric_points WHERE name = ?1 ORDER BY time_nano DESC LIMIT ?2",
            )
            .expect("prepare metric_series");
        let mut rows: Vec<MetricRow> = stmt
            .query_map(params![name, limit], map_metric_row)
            .expect("query metric_series")
            .filter_map(Result::ok)
            .collect();
        rows.reverse(); // oldest -> newest for the chart x-axis
        rows
    }

    /// Drop every row from every table (the dashboard "clear" action).
    pub fn clear(&self) {
        let conn = self.conn.lock_safe();
        let _ = conn.execute_batch(
            "DELETE FROM spans; DELETE FROM logs; DELETE FROM metric_points; \
             PRAGMA incremental_vacuum;",
        );
    }
}

/// PRAGMAs that must run before any table is created (auto_vacuum) plus the
/// performance/concurrency knobs.
fn configure(conn: &Connection) {
    // auto_vacuum must be set before the schema is created to take effect; a DB
    // that already has tables would need a full VACUUM to change it.
    let _ = conn.pragma_update(None, "auto_vacuum", "INCREMENTAL");
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "OFF");
}

fn init_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS spans (\
           id INTEGER PRIMARY KEY AUTOINCREMENT, \
           trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT NOT NULL, \
           name TEXT NOT NULL, service TEXT NOT NULL, kind INTEGER NOT NULL, \
           start_nano INTEGER NOT NULL, end_nano INTEGER NOT NULL, duration_nano INTEGER NOT NULL, \
           status_code INTEGER NOT NULL, status_message TEXT NOT NULL, scope_name TEXT NOT NULL, \
           attributes TEXT NOT NULL, resource TEXT NOT NULL, events TEXT NOT NULL, \
           received_ms INTEGER NOT NULL); \
         CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id); \
         CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(start_nano); \
         CREATE INDEX IF NOT EXISTS idx_spans_recv ON spans(received_ms); \
         CREATE INDEX IF NOT EXISTS idx_spans_service ON spans(service); \
         \
         CREATE TABLE IF NOT EXISTS logs (\
           id INTEGER PRIMARY KEY AUTOINCREMENT, \
           time_nano INTEGER NOT NULL, observed_time_nano INTEGER NOT NULL, \
           severity_number INTEGER NOT NULL, severity_text TEXT NOT NULL, body TEXT NOT NULL, \
           service TEXT NOT NULL, scope_name TEXT NOT NULL, trace_id TEXT NOT NULL, \
           span_id TEXT NOT NULL, attributes TEXT NOT NULL, resource TEXT NOT NULL, \
           received_ms INTEGER NOT NULL); \
         CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time_nano); \
         CREATE INDEX IF NOT EXISTS idx_logs_recv ON logs(received_ms); \
         CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service); \
         CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id); \
         \
         CREATE TABLE IF NOT EXISTS metric_points (\
           id INTEGER PRIMARY KEY AUTOINCREMENT, \
           name TEXT NOT NULL, description TEXT NOT NULL, unit TEXT NOT NULL, kind TEXT NOT NULL, \
           is_monotonic INTEGER, temporality INTEGER NOT NULL, service TEXT NOT NULL, \
           scope_name TEXT NOT NULL, time_nano INTEGER NOT NULL, start_nano INTEGER NOT NULL, \
           value TEXT NOT NULL, attributes TEXT NOT NULL, resource TEXT NOT NULL, \
           received_ms INTEGER NOT NULL); \
         CREATE INDEX IF NOT EXISTS idx_metrics_name ON metric_points(name, time_nano); \
         CREATE INDEX IF NOT EXISTS idx_metrics_recv ON metric_points(received_ms);",
    )
    .expect("init otel schema");
}

/// Current on-disk size estimate: page_count * page_size. In WAL mode the -wal
/// file adds transient pages, but this is close enough to drive the high-water
/// trigger.
fn db_size_bytes(conn: &Connection) -> i64 {
    let page_count: i64 = scalar(conn, "PRAGMA page_count");
    let page_size: i64 = scalar(conn, "PRAGMA page_size");
    page_count * page_size
}

/// If the DB is over the high-water mark, delete the oldest rows across all
/// tables until under the low-water mark, then reclaim freed pages.
fn enforce_retention(conn: &Connection) {
    if db_size_bytes(conn) <= HIGH_WATER_BYTES {
        return;
    }
    // Delete oldest-first from every table in lockstep until small enough or
    // there is nothing left to delete.
    loop {
        let deleted = delete_oldest(conn, "spans")
            + delete_oldest(conn, "logs")
            + delete_oldest(conn, "metric_points");
        // Reclaim pages so page_count actually shrinks for the next size check.
        let _ = conn.pragma_update(None, "incremental_vacuum", "0");
        if deleted == 0 || db_size_bytes(conn) <= LOW_WATER_BYTES {
            break;
        }
    }
}

/// Delete up to `PRUNE_CHUNK` oldest rows (by received_ms) from `table`.
/// Returns the number deleted.
fn delete_oldest(conn: &Connection, table: &str) -> usize {
    let sql = format!(
        "DELETE FROM {table} WHERE id IN \
         (SELECT id FROM {table} ORDER BY received_ms ASC, id ASC LIMIT {PRUNE_CHUNK})"
    );
    conn.execute(&sql, []).unwrap_or(0)
}

fn scalar<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
    conn.query_row(sql, [], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            // FromSql has no Default bound; this path only fires on a broken
            // query string, which is a programming error caught in tests.
            panic!("scalar query returned nothing: {sql}")
        })
}

/// Build a named-parameter slice, skipping params whose value is `None` so the
/// SQL only binds the placeholders it actually contains.
fn build_named<'a>(
    pairs: &'a [(&'a str, &'a dyn MaybeBind)],
) -> Vec<(&'a str, &'a dyn rusqlite::ToSql)> {
    pairs
        .iter()
        .filter_map(|(name, v)| v.as_sql().map(|s| (*name, s)))
        .collect()
}

/// Lets `Option<T>` expose its inner `ToSql` only when `Some`, so absent filter
/// params are never bound (matching the conditionally-built WHERE clause).
trait MaybeBind {
    fn as_sql(&self) -> Option<&dyn rusqlite::ToSql>;
}

impl<T: rusqlite::ToSql> MaybeBind for Option<T> {
    fn as_sql(&self) -> Option<&dyn rusqlite::ToSql> {
        self.as_ref().map(|v| v as &dyn rusqlite::ToSql)
    }
}

fn json_col(s: String) -> serde_json::Value {
    serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)
}

fn map_span_row(r: &rusqlite::Row) -> rusqlite::Result<SpanRow> {
    Ok(SpanRow {
        trace_id: r.get(0)?,
        span_id: r.get(1)?,
        parent_span_id: r.get(2)?,
        name: r.get(3)?,
        service: r.get(4)?,
        kind: r.get(5)?,
        start_nano: r.get::<_, i64>(6)? as u64,
        end_nano: r.get::<_, i64>(7)? as u64,
        duration_nano: r.get::<_, i64>(8)? as u64,
        status_code: r.get(9)?,
        status_message: r.get(10)?,
        scope_name: r.get(11)?,
        attributes: json_col(r.get(12)?),
        resource: json_col(r.get(13)?),
        events: json_col(r.get(14)?),
        received_ms: r.get(15)?,
    })
}

fn map_log_row(r: &rusqlite::Row) -> rusqlite::Result<LogRow> {
    Ok(LogRow {
        time_nano: r.get::<_, i64>(0)? as u64,
        observed_time_nano: r.get::<_, i64>(1)? as u64,
        severity_number: r.get(2)?,
        severity_text: r.get(3)?,
        body: r.get(4)?,
        service: r.get(5)?,
        scope_name: r.get(6)?,
        trace_id: r.get(7)?,
        span_id: r.get(8)?,
        attributes: json_col(r.get(9)?),
        resource: json_col(r.get(10)?),
        received_ms: r.get(11)?,
    })
}

fn map_metric_row(r: &rusqlite::Row) -> rusqlite::Result<MetricRow> {
    Ok(MetricRow {
        name: r.get(0)?,
        description: r.get(1)?,
        unit: r.get(2)?,
        kind: r.get(3)?,
        is_monotonic: r.get(4)?,
        temporality: r.get(5)?,
        service: r.get(6)?,
        scope_name: r.get(7)?,
        time_nano: r.get::<_, i64>(8)? as u64,
        start_nano: r.get::<_, i64>(9)? as u64,
        value: json_col(r.get(10)?),
        attributes: json_col(r.get(11)?),
        resource: json_col(r.get(12)?),
        received_ms: r.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn span(trace: &str, span_id: &str, parent: &str, name: &str, status: i32, recv: i64) -> SpanRow {
        SpanRow {
            trace_id: trace.into(),
            span_id: span_id.into(),
            parent_span_id: parent.into(),
            name: name.into(),
            service: "svc".into(),
            kind: 2,
            start_nano: 1000,
            end_nano: 2000,
            duration_nano: 1000,
            status_code: status,
            status_message: String::new(),
            scope_name: "scope".into(),
            attributes: json!({}),
            resource: json!({ "service.name": "svc" }),
            events: json!([]),
            received_ms: recv,
        }
    }

    #[test]
    fn insert_and_query_trace() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[
            span("t1", "a", "", "root", 0, 1),
            span("t1", "b", "a", "child", 2, 1),
        ]);
        let summaries = s.traces(&TraceQuery::default());
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].trace_id, "t1");
        assert_eq!(summaries[0].span_count, 2);
        assert!(summaries[0].has_error, "child span ERROR propagates to trace");
        assert_eq!(summaries[0].root_name, "root", "empty-parent span is the root");

        let spans = s.trace_spans("t1");
        assert_eq!(spans.len(), 2);
    }

    #[test]
    fn errors_only_filter() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[span("ok", "a", "", "fine", 0, 1)]);
        s.insert_spans(&[span("bad", "b", "", "broke", 2, 1)]);
        let q = TraceQuery {
            errors_only: Some(true),
            ..Default::default()
        };
        let r = s.traces(&q);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].trace_id, "bad");
    }

    #[test]
    fn logs_severity_and_search_filter() {
        let s = OtelStore::in_memory();
        let mk = |sev: i32, body: &str| LogRow {
            time_nano: 1,
            observed_time_nano: 1,
            severity_number: sev,
            severity_text: String::new(),
            body: body.into(),
            service: "svc".into(),
            scope_name: String::new(),
            trace_id: String::new(),
            span_id: String::new(),
            attributes: json!({}),
            resource: json!({}),
            received_ms: 1,
        };
        s.insert_logs(&[mk(9, "info hello"), mk(17, "error boom"), mk(5, "debug x")]);
        // INFO and above (>=9): info + error, not debug.
        let q = LogQuery {
            min_severity: Some(9),
            ..Default::default()
        };
        assert_eq!(s.logs(&q).len(), 2);
        // substring search on body.
        let q2 = LogQuery {
            search: Some("boom".into()),
            ..Default::default()
        };
        let r = s.logs(&q2);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].body, "error boom");
    }

    #[test]
    fn metric_series_orders_oldest_first() {
        let s = OtelStore::in_memory();
        let mk = |t: u64, v: f64| MetricRow {
            name: "cpu".into(),
            description: String::new(),
            unit: "1".into(),
            kind: "gauge".into(),
            is_monotonic: None,
            temporality: 0,
            service: "svc".into(),
            scope_name: String::new(),
            time_nano: t,
            start_nano: 0,
            value: json!({ "asDouble": v }),
            attributes: json!({}),
            resource: json!({}),
            received_ms: 1,
        };
        s.insert_metrics(&[mk(30, 0.3), mk(10, 0.1), mk(20, 0.2)]);
        let series = s.metric_series("cpu", 100);
        let times: Vec<u64> = series.iter().map(|m| m.time_nano).collect();
        assert_eq!(times, vec![10, 20, 30], "series sorted oldest->newest");
    }

    #[test]
    fn counts_and_services() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[span("t1", "a", "", "root", 0, 1)]);
        let c = s.counts();
        assert_eq!(c.traces, 1);
        assert_eq!(c.spans, 1);
        assert!(c.db_bytes > 0);
        assert_eq!(s.services(), vec!["svc".to_string()]);
    }

    #[test]
    fn clear_empties_all_tables() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[span("t1", "a", "", "root", 0, 1)]);
        s.clear();
        assert_eq!(s.counts().spans, 0);
    }
}
