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
use serde::{Deserialize, Serialize};

use crate::modules::sync::MutexExt;

use super::model::{
    AttrGroup, DbStatement, LogQuery, LogRow, MetricRow, OtelCounts, ServiceEdge, ServiceMap,
    ServiceNode, SpanRow, TraceQuery, TraceSort, TraceSummary,
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
        // Aggregate per trace, then pick exactly one representative root span.
        // `root` uses ROW_NUMBER to choose a single span per trace, preferring a
        // true root (empty parent) and breaking ties on earliest start. Without
        // the rn=1 filter, spans that tie on MIN(start_nano) would each match and
        // fan the aggregate row out into duplicates.
        // `attr_hit` in agg marks a trace where ANY span's attributes match, so
        // the attribute filter is a whole-trace EXISTS, not a root-row test.
        let mut sql = String::from(
            "WITH agg AS (\
               SELECT trace_id, \
                      MIN(start_nano) AS start_nano, \
                      MAX(end_nano) - MIN(start_nano) AS duration_nano, \
                      COUNT(*) AS span_count, \
                      MAX(received_ms) AS received_ms, \
                      MAX(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS has_error, \
                      MAX(CASE WHEN attributes LIKE :attr THEN 1 ELSE 0 END) AS attr_hit \
               FROM spans GROUP BY trace_id), \
             ranked AS (\
               SELECT trace_id, name AS root_name, service AS root_service, \
                      ROW_NUMBER() OVER (\
                        PARTITION BY trace_id \
                        ORDER BY CASE WHEN parent_span_id = '' THEN 0 ELSE 1 END, start_nano, id\
                      ) AS rn \
               FROM spans), \
             root AS (SELECT trace_id, root_name, root_service FROM ranked WHERE rn = 1) \
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
        if q.min_duration_nano.is_some() {
            clauses.push("agg.duration_nano >= :mindur".into());
        }
        if q.since_ms.is_some() {
            clauses.push("agg.received_ms >= :since".into());
        }
        if q.attr_search.is_some() {
            clauses.push("agg.attr_hit = 1".into());
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        let order = match q.sort.unwrap_or_default() {
            TraceSort::Recent => "agg.start_nano DESC",
            TraceSort::Slowest => "agg.duration_nano DESC",
        };
        sql.push_str(&format!(" ORDER BY {order} LIMIT :limit"));

        // Owned locals so the &dyn ToSql references in `named` outlive query_map.
        let like = q.search.as_ref().map(|s| format!("%{s}%"));
        let attr_like = q.attr_search.as_ref().map(|s| format!("%{s}%"));
        let min_dur = q.min_duration_nano.map(|d| d as i64);
        // `:attr` is always bound (the agg CTE references it even when the filter
        // is off); a no-op default of '%' matches everything.
        let attr_bind = attr_like.clone().unwrap_or_else(|| "%".to_string());
        let mut named: Vec<(&str, &dyn rusqlite::ToSql)> =
            vec![(":limit", &limit), (":attr", &attr_bind)];
        if let Some(svc) = &q.service {
            named.push((":service", svc));
        }
        if let Some(s) = &like {
            named.push((":search", s));
        }
        if let Some(d) = &min_dur {
            named.push((":mindur", d));
        }
        if let Some(s) = &q.since_ms {
            named.push((":since", s));
        }
        let mut stmt = conn.prepare(&sql).expect("prepare traces");
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
        if q.since_ms.is_some() {
            clauses.push("received_ms >= :since".into());
        }
        if q.attr_search.is_some() {
            clauses.push("attributes LIKE :attr".into());
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY time_nano DESC LIMIT :limit");

        // Owned locals so the &dyn ToSql references in `named` outlive query_map.
        let like = q.search.as_ref().map(|s| format!("%{s}%"));
        let attr_like = q.attr_search.as_ref().map(|s| format!("%{s}%"));
        let mut named: Vec<(&str, &dyn rusqlite::ToSql)> = vec![(":limit", &limit)];
        if let Some(svc) = &q.service {
            named.push((":service", svc));
        }
        if let Some(sev) = &q.min_severity {
            named.push((":minsev", sev));
        }
        if let Some(s) = &like {
            named.push((":search", s));
        }
        if let Some(t) = &q.trace_id {
            named.push((":trace", t));
        }
        if let Some(s) = &q.since_ms {
            named.push((":since", s));
        }
        if let Some(a) = &attr_like {
            named.push((":attr", a));
        }
        let mut stmt = conn.prepare(&sql).expect("prepare logs");
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

    /// Service dependency graph. Edges are cross-service parent/child span
    /// links (a span whose service differs from its parent's); nodes carry each
    /// service's own span + error totals. p50/p95 per edge are computed in Rust
    /// since SQLite has no percentile aggregate.
    pub fn service_map(&self, since_ms: Option<i64>) -> ServiceMap {
        let conn = self.conn.lock_safe();
        let since = since_ms.unwrap_or(0);

        // Nodes: per-service span + error counts.
        let nodes = {
            let mut stmt = conn
                .prepare(
                    "SELECT service, COUNT(*), SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) \
                     FROM spans WHERE received_ms >= ?1 GROUP BY service ORDER BY service",
                )
                .expect("prepare service nodes");
            stmt.query_map(params![since], |r| {
                Ok(ServiceNode {
                    service: r.get(0)?,
                    spans: r.get(1)?,
                    errors: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                })
            })
            .expect("query service nodes")
            .filter_map(Result::ok)
            .collect()
        };

        // Edge rows: one per cross-service call, with the child duration + error
        // flag. Aggregated into edges (with percentiles) below.
        let mut stmt = conn
            .prepare(
                "SELECT p.service AS from_svc, c.service AS to_svc, c.duration_nano, c.status_code \
                 FROM spans c JOIN spans p \
                   ON c.parent_span_id = p.span_id AND c.trace_id = p.trace_id \
                 WHERE c.service <> p.service AND c.received_ms >= ?1",
            )
            .expect("prepare service edges");
        let raw = stmt
            .query_map(params![since], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                    r.get::<_, i64>(3)?,
                ))
            })
            .expect("query service edges")
            .filter_map(Result::ok);

        // Group by (from, to): collect durations + error count.
        let mut groups: std::collections::HashMap<(String, String), (Vec<u64>, i64)> =
            std::collections::HashMap::new();
        for (from, to, dur, code) in raw {
            let e = groups.entry((from, to)).or_default();
            e.0.push(dur);
            if code == 2 {
                e.1 += 1;
            }
        }
        let mut edges: Vec<ServiceEdge> = groups
            .into_iter()
            .map(|((from, to), (mut durs, errors))| {
                durs.sort_unstable();
                ServiceEdge {
                    from,
                    to,
                    calls: durs.len() as i64,
                    errors,
                    p50_nano: percentile(&durs, 0.50),
                    p95_nano: percentile(&durs, 0.95),
                }
            })
            .collect();
        edges.sort_by(|a, b| b.calls.cmp(&a.calls));

        ServiceMap { nodes, edges }
    }

    /// Database statement analytics: aggregate `db.system` spans by statement.
    /// Durations are pulled per group and reduced in Rust (avg/p95/max/total).
    pub fn db_queries(&self, since_ms: Option<i64>) -> Vec<DbStatement> {
        let conn = self.conn.lock_safe();
        let since = since_ms.unwrap_or(0);
        // A DB span is one whose attributes carry `db.system`. Group key is the
        // `db.statement` value when present, else the span name. We extract both
        // via json_extract (rusqlite bundles JSON1).
        let mut stmt = conn
            .prepare(
                "SELECT \
                   COALESCE(NULLIF(json_extract(attributes, '$.\"db.statement\"'), ''), name) AS stmt, \
                   COALESCE(json_extract(attributes, '$.\"db.system\"'), '') AS system, \
                   service, duration_nano, status_code \
                 FROM spans \
                 WHERE json_extract(attributes, '$.\"db.system\"') IS NOT NULL \
                   AND received_ms >= ?1",
            )
            .expect("prepare db_queries");
        let raw = stmt
            .query_map(params![since], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)? as u64,
                    r.get::<_, i64>(4)?,
                ))
            })
            .expect("query db_queries")
            .filter_map(Result::ok);

        // Group by (statement, system, service).
        #[derive(Default)]
        struct Acc {
            durs: Vec<u64>,
            errors: i64,
        }
        let mut groups: std::collections::HashMap<(String, String, String), Acc> =
            std::collections::HashMap::new();
        for (stmt_text, system, service, dur, code) in raw {
            let acc = groups.entry((stmt_text, system, service)).or_default();
            acc.durs.push(dur);
            if code == 2 {
                acc.errors += 1;
            }
        }
        let mut out: Vec<DbStatement> = groups
            .into_iter()
            .map(|((statement, system, service), mut acc)| {
                acc.durs.sort_unstable();
                let total: u64 = acc.durs.iter().sum();
                let calls = acc.durs.len() as i64;
                DbStatement {
                    statement,
                    system,
                    service,
                    calls,
                    errors: acc.errors,
                    avg_nano: if calls > 0 { total / calls as u64 } else { 0 },
                    p95_nano: percentile(&acc.durs, 0.95),
                    max_nano: acc.durs.last().copied().unwrap_or(0),
                    total_nano: total,
                }
            })
            .collect();
        // Most total time first - the queries worth optimizing.
        out.sort_by(|a, b| b.total_nano.cmp(&a.total_nano));
        out
    }

    /// Distinct attribute keys seen across span attributes, for the breakdown
    /// dimension picker. Uses JSON1 `json_each` over each span's attributes
    /// object. Bounded to the most common keys.
    pub fn attribute_keys(&self) -> Vec<String> {
        let conn = self.conn.lock_safe();
        let mut stmt = conn
            .prepare(
                "SELECT key, COUNT(*) AS n FROM spans, json_each(spans.attributes) \
                 GROUP BY key ORDER BY n DESC LIMIT 50",
            )
            .expect("prepare attribute_keys");
        stmt.query_map([], |r| r.get::<_, String>(0))
            .expect("query attribute_keys")
            .filter_map(Result::ok)
            .collect()
    }

    /// Group spans by the value of attribute `key` (e.g. `tenant.id`, `user.id`)
    /// into analytics rows: span/trace/error counts, latency percentiles, last
    /// activity, and top operation names. Powers the user/tenant dashboard.
    pub fn attr_breakdown(&self, key: &str, since_ms: Option<i64>, limit: i64) -> Vec<AttrGroup> {
        let conn = self.conn.lock_safe();
        let since = since_ms.unwrap_or(0);
        let limit = limit.clamp(1, 500);
        // Pull the per-span value for `key` plus the fields we aggregate. The
        // JSON path is parameterized via printf since json_extract needs a
        // literal-ish path; `key` is constrained by the picker, but we still
        // guard it to attribute-name characters to avoid path injection.
        let safe_key: String = key
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
            .collect();
        if safe_key.is_empty() {
            return Vec::new();
        }
        let path = format!("$.\"{safe_key}\"");
        let mut stmt = conn
            .prepare(
                "SELECT json_extract(attributes, ?1) AS v, trace_id, name, duration_nano, \
                 status_code, received_ms \
                 FROM spans \
                 WHERE json_extract(attributes, ?1) IS NOT NULL AND received_ms >= ?2",
            )
            .expect("prepare attr_breakdown");
        let raw = stmt
            .query_map(params![path, since], |r| {
                Ok((
                    // value may be string or number; normalize to string.
                    match r.get_ref(0)? {
                        rusqlite::types::ValueRef::Text(t) => {
                            String::from_utf8_lossy(t).into_owned()
                        }
                        rusqlite::types::ValueRef::Integer(i) => i.to_string(),
                        rusqlite::types::ValueRef::Real(f) => f.to_string(),
                        _ => String::new(),
                    },
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)? as u64,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            })
            .expect("query attr_breakdown")
            .filter_map(Result::ok);

        struct Acc {
            durs: Vec<u64>,
            traces: std::collections::HashSet<String>,
            errors: i64,
            last_ms: i64,
            ops: std::collections::HashMap<String, i64>,
        }
        impl Default for Acc {
            fn default() -> Self {
                Acc {
                    durs: Vec::new(),
                    traces: std::collections::HashSet::new(),
                    errors: 0,
                    last_ms: 0,
                    ops: std::collections::HashMap::new(),
                }
            }
        }
        let mut groups: std::collections::HashMap<String, Acc> = std::collections::HashMap::new();
        for (value, trace_id, name, dur, code, recv) in raw {
            let a = groups.entry(value).or_default();
            a.durs.push(dur);
            a.traces.insert(trace_id);
            if code == 2 {
                a.errors += 1;
            }
            a.last_ms = a.last_ms.max(recv);
            *a.ops.entry(name).or_insert(0) += 1;
        }
        let mut out: Vec<AttrGroup> = groups
            .into_iter()
            .map(|(value, mut a)| {
                a.durs.sort_unstable();
                let spans = a.durs.len() as i64;
                let total: u64 = a.durs.iter().sum();
                let mut ops: Vec<(String, i64)> = a.ops.into_iter().collect();
                ops.sort_by(|x, y| y.1.cmp(&x.1));
                AttrGroup {
                    value,
                    spans,
                    traces: a.traces.len() as i64,
                    errors: a.errors,
                    avg_nano: if spans > 0 { total / spans as u64 } else { 0 },
                    p95_nano: percentile(&a.durs, 0.95),
                    last_seen_ms: a.last_ms,
                    top_ops: ops.into_iter().take(3).map(|(n, _)| n).collect(),
                }
            })
            .collect();
        // Busiest groups first.
        out.sort_by(|a, b| b.spans.cmp(&a.spans));
        out.truncate(limit as usize);
        out
    }

    /// Drop every row from every table (the dashboard "clear" action).
    pub fn clear(&self) {
        let conn = self.conn.lock_safe();
        let _ = conn.execute_batch(
            "DELETE FROM spans; DELETE FROM logs; DELETE FROM metric_points; \
             PRAGMA incremental_vacuum;",
        );
    }

    /// Run a user-supplied read-only query against the telemetry store and
    /// return its columns + rows. The Query page surfaces this; it is guarded to
    /// SELECT-only (see `is_read_only_sql`) so the UI can never mutate or drop
    /// the captured telemetry.
    ///
    /// `limit`/`offset` window the result for infinite-scroll paging: the user's
    /// statement is wrapped as a subquery (`SELECT * FROM (<sql>) LIMIT ?cap
    /// OFFSET ?off`) so the outer window applies regardless of the user's own
    /// ORDER BY/LIMIT. One extra row beyond `cap` is fetched to detect whether
    /// more rows exist (`truncated`), which the infinite datasource uses to set
    /// the last-row boundary. Values are serialized to JSON so the frontend
    /// renders any column type uniformly.
    pub fn query(&self, sql: &str, limit: i64, offset: i64) -> Result<QueryResult, String> {
        if !is_read_only_sql(sql) {
            return Err(
                "Only read-only SELECT queries are allowed. Statements that modify or \
                 inspect the database (INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH/…) \
                 are blocked."
                    .to_string(),
            );
        }
        let cap = limit.clamp(1, 10_000);
        let off = offset.max(0);
        // Strip a trailing `;` so the statement nests cleanly as a subquery.
        let inner = strip_sql_comments(sql);
        let inner = inner.trim().strip_suffix(';').unwrap_or(inner.trim());
        // Fetch one extra row to learn whether more pages exist.
        let paged = format!("SELECT * FROM ({inner}) LIMIT {} OFFSET {off}", cap + 1);

        let conn = self.conn.lock_safe();
        let mut stmt = conn.prepare(&paged).map_err(|e| e.to_string())?;
        let col_count = stmt.column_count();
        let columns: Vec<String> =
            stmt.column_names().iter().map(|s| s.to_string()).collect();

        let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut truncated = false;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if rows_out.len() as i64 >= cap {
                // The (cap+1)-th row exists → there is at least one more page.
                truncated = true;
                break;
            }
            let mut out_row = Vec::with_capacity(col_count);
            for i in 0..col_count {
                out_row.push(sqlite_value_to_json(row, i));
            }
            rows_out.push(out_row);
        }

        Ok(QueryResult {
            columns,
            rows: rows_out,
            truncated,
        })
    }
}

/// Result of a user query: column headers + JSON-typed cells, plus whether the
/// row cap clipped the result.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub truncated: bool,
}

/// Convert a SQLite cell to a JSON value for transport to the frontend.
fn sqlite_value_to_json(row: &rusqlite::Row, idx: usize) -> serde_json::Value {
    use rusqlite::types::ValueRef;
    match row.get_ref(idx) {
        Ok(ValueRef::Null) => serde_json::Value::Null,
        Ok(ValueRef::Integer(i)) => serde_json::Value::from(i),
        Ok(ValueRef::Real(f)) => serde_json::Value::from(f),
        Ok(ValueRef::Text(t)) => {
            serde_json::Value::from(String::from_utf8_lossy(t).into_owned())
        }
        Ok(ValueRef::Blob(b)) => serde_json::Value::from(format!("<{} bytes>", b.len())),
        Err(_) => serde_json::Value::Null,
    }
}

/// Whether `sql` is a single read-only SELECT/WITH statement. Conservative: it
/// strips comments, requires the statement to begin with SELECT or WITH, rejects
/// any statement-terminating `;` followed by more SQL (no statement batching),
/// and bans write/DDL/side-effecting keywords as whole words anywhere.
fn is_read_only_sql(sql: &str) -> bool {
    let stripped = strip_sql_comments(sql);
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Disallow batching: a `;` may only appear as an optional trailing terminator.
    let core = trimmed.strip_suffix(';').unwrap_or(trimmed);
    if core.contains(';') {
        return false;
    }
    let lower = core.to_ascii_lowercase();
    let starts_ok = lower.starts_with("select") || lower.starts_with("with");
    if !starts_ok {
        return false;
    }
    // Ban write / DDL / side-effecting keywords as whole words. `pragma` is
    // included because write-PRAGMAs can change durability/behavior.
    const BANNED: &[&str] = &[
        "insert", "update", "delete", "drop", "alter", "create", "replace",
        "truncate", "attach", "detach", "pragma", "vacuum", "reindex", "commit",
        "rollback", "begin", "savepoint",
    ];
    let bytes = lower.as_bytes();
    for kw in BANNED {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(kw) {
            let start = from + pos;
            let end = start + kw.len();
            let prev_ok = start == 0 || !is_ident_byte(bytes[start - 1]);
            let next_ok = end >= bytes.len() || !is_ident_byte(bytes[end]);
            if prev_ok && next_ok {
                return false;
            }
            from = end;
        }
    }
    true
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Remove `--` line comments and `/* */` block comments so keyword scanning
/// can't be fooled by a write keyword hidden in a comment (or vice-versa).
fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// Nearest-rank percentile over a pre-sorted ascending slice. Empty -> 0.
fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
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

    /// Fully-specified span for the filter/mesh/db tests.
    #[allow(clippy::too_many_arguments)]
    fn span_full(
        trace: &str,
        span_id: &str,
        parent: &str,
        service: &str,
        dur: u64,
        status: i32,
        attrs: serde_json::Value,
        recv: i64,
    ) -> SpanRow {
        SpanRow {
            trace_id: trace.into(),
            span_id: span_id.into(),
            parent_span_id: parent.into(),
            name: "op".into(),
            service: service.into(),
            kind: 3,
            start_nano: 1000,
            end_nano: 1000 + dur,
            duration_nano: dur,
            status_code: status,
            status_message: String::new(),
            scope_name: "scope".into(),
            attributes: attrs,
            resource: json!({ "service.name": service }),
            events: json!([]),
            received_ms: recv,
        }
    }

    #[test]
    fn trace_min_duration_and_sort() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[span_full("fast", "a", "", "api", 1000, 0, json!({}), 1)]);
        s.insert_spans(&[span_full("slow", "b", "", "api", 9000, 0, json!({}), 2)]);
        // min-duration drops the fast trace.
        let q = TraceQuery {
            min_duration_nano: Some(5000),
            ..Default::default()
        };
        let r = s.traces(&q);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].trace_id, "slow");
        // slowest-first sort puts slow ahead of fast.
        let q2 = TraceQuery {
            sort: Some(TraceSort::Slowest),
            ..Default::default()
        };
        let r2 = s.traces(&q2);
        assert_eq!(r2[0].trace_id, "slow");
    }

    #[test]
    fn trace_attr_search_matches_any_span() {
        let s = OtelStore::in_memory();
        s.insert_spans(&[
            span_full("t1", "a", "", "api", 100, 0, json!({}), 1),
            span_full("t1", "b", "a", "api", 100, 0, json!({ "http.status": 500 }), 1),
        ]);
        s.insert_spans(&[span_full("t2", "c", "", "api", 100, 0, json!({ "http.status": 200 }), 1)]);
        // Substring match against the attributes JSON of any span in the trace.
        let q = TraceQuery {
            attr_search: Some("\"http.status\":500".into()),
            ..Default::default()
        };
        let r = s.traces(&q);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].trace_id, "t1");
    }

    #[test]
    fn service_map_builds_cross_service_edges() {
        let s = OtelStore::in_memory();
        // web -> api (ok), api -> db (error). Same-service link is not an edge.
        s.insert_spans(&[
            span_full("t", "root", "", "web", 500, 0, json!({}), 1),
            span_full("t", "apicall", "root", "api", 300, 0, json!({}), 1),
            span_full("t", "apiinternal", "apicall", "api", 50, 0, json!({}), 1),
            span_full("t", "dbcall", "apicall", "db", 100, 2, json!({}), 1),
        ]);
        let map = s.service_map(None);
        // Three services as nodes.
        assert_eq!(map.nodes.len(), 3);
        // Two cross-service edges: web->api and api->db. api->api is excluded.
        assert_eq!(map.edges.len(), 2);
        let db_edge = map.edges.iter().find(|e| e.to == "db").unwrap();
        assert_eq!(db_edge.from, "api");
        assert_eq!(db_edge.calls, 1);
        assert_eq!(db_edge.errors, 1, "db child errored");
    }

    #[test]
    fn db_queries_aggregate_by_statement() {
        let s = OtelStore::in_memory();
        let dbattr = |stmt: &str| json!({ "db.system": "postgresql", "db.statement": stmt });
        s.insert_spans(&[
            span_full("t1", "a", "", "api", 100, 0, dbattr("SELECT users"), 1),
            span_full("t2", "b", "", "api", 300, 0, dbattr("SELECT users"), 1),
            span_full("t3", "c", "", "api", 50, 2, dbattr("INSERT order"), 1),
        ]);
        // A non-db span is ignored.
        s.insert_spans(&[span_full("t4", "d", "", "api", 999, 0, json!({}), 1)]);
        let rows = s.db_queries(None);
        assert_eq!(rows.len(), 2, "two distinct statements");
        let sel = rows.iter().find(|r| r.statement == "SELECT users").unwrap();
        assert_eq!(sel.calls, 2);
        assert_eq!(sel.system, "postgresql");
        assert_eq!(sel.total_nano, 400);
        assert_eq!(sel.avg_nano, 200);
        assert_eq!(sel.max_nano, 300);
        let ins = rows.iter().find(|r| r.statement == "INSERT order").unwrap();
        assert_eq!(ins.errors, 1);
    }

    #[test]
    fn attr_breakdown_groups_by_value() {
        let s = OtelStore::in_memory();
        let t = |id: &str| json!({ "tenant.id": id });
        s.insert_spans(&[
            span_full("t1", "a", "", "api", 100, 0, t("acme"), 10),
            span_full("t1", "b", "a", "api", 200, 2, t("acme"), 10),
            span_full("t2", "c", "", "api", 50, 0, t("globex"), 20),
        ]);
        let groups = s.attr_breakdown("tenant.id", None, 100);
        assert_eq!(groups.len(), 2);
        // Busiest first: acme has 2 spans.
        assert_eq!(groups[0].value, "acme");
        assert_eq!(groups[0].spans, 2);
        assert_eq!(groups[0].traces, 1);
        assert_eq!(groups[0].errors, 1);
        assert_eq!(groups[0].avg_nano, 150);
        assert!(groups[0].top_ops.contains(&"op".to_string()));
        // Distinct keys include the tenant attribute.
        assert!(s.attribute_keys().contains(&"tenant.id".to_string()));
        // Unknown key -> empty.
        assert!(s.attr_breakdown("nope.key", None, 100).is_empty());
    }

    #[test]
    fn percentile_nearest_rank() {
        let v = vec![10u64, 20, 30, 40, 50];
        assert_eq!(percentile(&v, 0.0), 10);
        assert_eq!(percentile(&v, 0.5), 30);
        assert_eq!(percentile(&v, 0.95), 50);
        assert_eq!(percentile(&[], 0.5), 0);
    }

    #[test]
    fn logs_since_and_attr_filter() {
        let s = OtelStore::in_memory();
        let mk = |recv: i64, attrs: serde_json::Value| LogRow {
            time_nano: recv as u64,
            observed_time_nano: 1,
            severity_number: 9,
            severity_text: "INFO".into(),
            body: "x".into(),
            service: "api".into(),
            scope_name: String::new(),
            trace_id: String::new(),
            span_id: String::new(),
            attributes: attrs,
            resource: json!({}),
            received_ms: recv,
        };
        s.insert_logs(&[
            mk(100, json!({ "tenant.id": "abc" })),
            mk(200, json!({ "tenant.id": "xyz" })),
        ]);
        // since filter.
        let q = LogQuery {
            since_ms: Some(150),
            ..Default::default()
        };
        assert_eq!(s.logs(&q).len(), 1);
        // attr substring.
        let q2 = LogQuery {
            attr_search: Some("xyz".into()),
            ..Default::default()
        };
        let r = s.logs(&q2);
        assert_eq!(r.len(), 1);
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
