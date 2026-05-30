import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Frontend bindings for the local OTEL collector. Mirrors the Rust row model
 * (`src-tauri/src/modules/otel/model.rs`) field-for-field (serde camelCase ->
 * these names). All 64-bit nanosecond timestamps arrive as JS numbers; the
 * backend already parsed the OTLP string-int64 wire form, and values within a
 * dev session never exceed Number.MAX_SAFE_INTEGER meaningfully for display.
 */

export type SpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  service: string;
  kind: number;
  startNano: number;
  endNano: number;
  durationNano: number;
  statusCode: number;
  statusMessage: string;
  scopeName: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: Array<{ name: string; timeNano: number; attributes: Record<string, unknown> }>;
  receivedMs: number;
};

export type LogRow = {
  timeNano: number;
  observedTimeNano: number;
  severityNumber: number;
  severityText: string;
  body: string;
  service: string;
  scopeName: string;
  traceId: string;
  spanId: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  receivedMs: number;
};

export type MetricRow = {
  name: string;
  description: string;
  unit: string;
  kind: string;
  isMonotonic: boolean | null;
  temporality: number;
  service: string;
  scopeName: string;
  timeNano: number;
  startNano: number;
  value: Record<string, unknown>;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  receivedMs: number;
};

export type TraceSummary = {
  traceId: string;
  rootName: string;
  rootService: string;
  startNano: number;
  durationNano: number;
  spanCount: number;
  hasError: boolean;
  receivedMs: number;
};

export type OtelCounts = {
  traces: number;
  spans: number;
  logs: number;
  metrics: number;
  dbBytes: number;
};

export type MetricName = {
  name: string;
  kind: string;
  unit: string;
  points: number;
};

export type TraceSort = "recent" | "slowest";

export type TraceQuery = {
  service?: string;
  errorsOnly?: boolean;
  search?: string;
  minDurationNano?: number;
  sinceMs?: number;
  attrSearch?: string;
  sort?: TraceSort;
  limit?: number;
};

export type LogQuery = {
  service?: string;
  minSeverity?: number;
  search?: string;
  traceId?: string;
  sinceMs?: number;
  attrSearch?: string;
  limit?: number;
};

export type ServiceNode = { service: string; spans: number; errors: number };
export type ServiceEdge = {
  from: string;
  to: string;
  calls: number;
  errors: number;
  p50Nano: number;
  p95Nano: number;
};
export type ServiceMap = { nodes: ServiceNode[]; edges: ServiceEdge[] };

export type DbStatement = {
  statement: string;
  system: string;
  service: string;
  calls: number;
  errors: number;
  avgNano: number;
  p95Nano: number;
  maxNano: number;
  totalNano: number;
};

export type AttrGroup = {
  value: string;
  spans: number;
  traces: number;
  errors: number;
  avgNano: number;
  p95Nano: number;
  lastSeenMs: number;
  topOps: string[];
};

/** The fired-on-ingest event payload (see `ingest.rs` IngestEvent). */
type IngestEvent = { signal: "traces" | "logs" | "metrics"; count: number };

export const otel = {
  ingestPort: () => invoke<number>("otel_ingest_port"),
  counts: () => invoke<OtelCounts>("otel_counts"),
  services: () => invoke<string[]>("otel_services"),
  traces: (query?: TraceQuery) => invoke<TraceSummary[]>("otel_traces", { query }),
  traceSpans: (traceId: string) => invoke<SpanRow[]>("otel_trace_spans", { traceId }),
  logs: (query?: LogQuery) => invoke<LogRow[]>("otel_logs", { query }),
  metricNames: () => invoke<MetricName[]>("otel_metric_names"),
  metricSeries: (name: string, limit?: number) =>
    invoke<MetricRow[]>("otel_metric_series", { name, limit }),
  serviceMap: (sinceMs?: number) => invoke<ServiceMap>("otel_service_map", { sinceMs }),
  dbQueries: (sinceMs?: number) => invoke<DbStatement[]>("otel_db_queries", { sinceMs }),
  attributeKeys: () => invoke<string[]>("otel_attribute_keys"),
  attrBreakdown: (key: string, sinceMs?: number, limit?: number) =>
    invoke<AttrGroup[]>("otel_attr_breakdown", { key, sinceMs, limit }),
  query: (sql: string, limit?: number, offset?: number) =>
    invoke<QueryResult>("otel_query", { sql, limit, offset }),
  clear: () => invoke<void>("otel_clear"),
};

/** Result of a read-only `otel.query` — column headers + JSON-typed cells. */
export type QueryResult = {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  truncated: boolean;
};

/**
 * The telemetry store schema, mirrored from `store.rs` `init_schema`. Drives the
 * Query page's autocomplete and the table/column reference. Kept in sync by hand
 * since the schema is fixed and small; a drift would only weaken completion, not
 * correctness (the backend is the source of truth for what runs).
 */
export const OTEL_SCHEMA: Record<string, string[]> = {
  spans: [
    "id", "trace_id", "span_id", "parent_span_id", "name", "service", "kind",
    "start_nano", "end_nano", "duration_nano", "status_code", "status_message",
    "scope_name", "attributes", "resource", "events", "received_ms",
  ],
  logs: [
    "id", "time_nano", "observed_time_nano", "severity_number", "severity_text",
    "body", "service", "scope_name", "trace_id", "span_id", "attributes",
    "resource", "received_ms",
  ],
  metric_points: [
    "id", "name", "description", "unit", "kind", "is_monotonic", "temporality",
    "service", "scope_name", "time_nano", "start_nano", "value", "attributes",
    "resource", "received_ms",
  ],
};

/** Time-window presets shared by the views. value = lookback ms, or 0 = all. */
export const TIME_WINDOWS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "All", ms: 0 },
];

/** Resolve a window's lookback (ms) into an absolute `sinceMs`, or undefined. */
export function sinceFromWindow(ms: number): number | undefined {
  return ms > 0 ? Date.now() - ms : undefined;
}

/**
 * Subscribe to ingest events with a debounced callback. An app under load emits
 * `terax:otel-ingest` continuously; we coalesce a burst into one `onIngest`
 * call (default 250ms) so the dashboard refetches once per quiet window rather
 * than per batch. Pausing while the document is hidden avoids work for an
 * off-screen tab.
 */
export function useOtelLive(
  onIngest: (signal: IngestEvent["signal"]) => void,
  debounceMs = 250,
) {
  const cbRef = useRef(onIngest);
  cbRef.current = onIngest;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    let pending: IngestEvent["signal"] | null = null;
    let disposed = false;

    void listen<IngestEvent>("terax:otel-ingest", (event) => {
      if (document.visibilityState !== "visible") return;
      pending = event.payload.signal;
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const sig = pending;
        pending = null;
        if (sig) cbRef.current(sig);
      }, debounceMs);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [debounceMs]);
}

/** Severity-number -> short level label + a tailwind color class. */
export function severityLevel(n: number): { label: string; cls: string } {
  if (n >= 21) return { label: "FATAL", cls: "text-red-400" };
  if (n >= 17) return { label: "ERROR", cls: "text-red-400" };
  if (n >= 13) return { label: "WARN", cls: "text-amber-400" };
  if (n >= 9) return { label: "INFO", cls: "text-sky-400" };
  if (n >= 5) return { label: "DEBUG", cls: "text-muted-foreground" };
  if (n >= 1) return { label: "TRACE", cls: "text-muted-foreground/70" };
  return { label: "", cls: "text-muted-foreground" };
}

/** SpanKind int -> label. */
export function spanKindLabel(kind: number): string {
  return (
    ["unspecified", "internal", "server", "client", "producer", "consumer"][kind] ??
    "unspecified"
  );
}

/** Format a nanosecond duration as a human string (µs / ms / s). */
export function fmtDuration(nanos: number): string {
  if (nanos <= 0) return "0ms";
  const ms = nanos / 1e6;
  if (ms < 1) return `${(nanos / 1e3).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : ms < 100 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format epoch-ms-since age as "12s ago" / "3m ago". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Format a nanosecond unix timestamp as a local HH:MM:SS.mmm clock string. */
export function fmtClock(nanos: number): string {
  if (nanos <= 0) return "--:--:--";
  const d = new Date(nanos / 1e6);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Compact bytes, e.g. 1536 -> "1.5 KB", 1.1e9 -> "1.0 GB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Pull a numeric value out of a metric data-point `value` blob. Gauge/sum use
 * `asDouble`/`asInt`; histogram exposes `sum`/`count`. Returns the most
 * chart-worthy scalar.
 */
export function metricScalar(m: MetricRow): number {
  const v = m.value as Record<string, unknown>;
  if (typeof v.asDouble === "number") return v.asDouble;
  if (typeof v.asInt === "number") return v.asInt;
  if (typeof v.asInt === "string") return Number(v.asInt);
  if (typeof v.sum === "number") return v.sum;
  if (typeof v.count === "number") return v.count;
  return 0;
}

/**
 * Generic poll-on-mount + refetch-on-demand state container. The dashboard
 * panes call the provided `fetcher`; `reload` re-runs it (wired to ingest
 * events and the manual refresh button).
 */
export function useOtelResource<T>(
  fetcher: () => Promise<T>,
  initial: T,
  deps: unknown[],
): { data: T; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cancel = reload();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload };
}
