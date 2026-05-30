import { metricScalar, type MetricRow } from "./useOtel";
import type { HistoBucket, Series, SeriesPoint } from "../views/detail/charts";
import { SERIES_COLORS } from "../views/detail/charts";

/**
 * Metric-shaping helpers for the deep metric charts. Metrics are
 * multi-dimensional (one name → many label combinations over time), and the
 * raw `value` blob differs by kind (gauge/sum scalars vs. histogram buckets).
 * These functions turn the flat `MetricRow[]` the backend returns into the
 * series / buckets / rate shapes the chart primitives consume.
 */

/** Stable `k=v` signature of a data point's attribute set (the series key). */
export function attrSignature(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join(", ");
}

/** Split rows into one Series per attribute signature, time-ordered. */
export function toSeries(rows: MetricRow[]): Series[] {
  const groups = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const sig = attrSignature(r.attributes ?? {});
    const arr = groups.get(sig);
    if (arr) arr.push(r);
    else groups.set(sig, [r]);
  }
  return Array.from(groups.entries())
    .map(([sig, group], i) => {
      const points: SeriesPoint[] = group
        .slice()
        .sort((a, b) => a.timeNano - b.timeNano)
        .map((r) => ({ t: r.timeNano, v: metricScalar(r) }));
      return {
        label: sig || "(no labels)",
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        points,
      };
    })
    .sort((a, b) => b.points.length - a.points.length);
}

/**
 * Per-interval rate for a monotonic cumulative counter. Δvalue / Δseconds
 * between consecutive points; counter resets (Δ<0) are clamped to 0 so a restart
 * doesn't spike the chart. Computed per series so multi-dimensional counters
 * rate correctly.
 */
export function toRateSeries(rows: MetricRow[]): Series[] {
  return toSeries(rows).map((s) => {
    const pts: SeriesPoint[] = [];
    for (let i = 1; i < s.points.length; i++) {
      const prev = s.points[i - 1];
      const cur = s.points[i];
      const dt = (cur.t - prev.t) / 1e9; // ns → s
      if (dt <= 0) continue;
      const dv = cur.v - prev.v;
      pts.push({ t: cur.t, v: dv < 0 ? 0 : dv / dt });
    }
    return { ...s, points: pts };
  });
}

/** True when a metric is a monotonic cumulative sum (counter) worth a rate chart. */
export function isCounter(rows: MetricRow[]): boolean {
  const r = rows[0];
  return !!r && r.kind === "sum" && r.isMonotonic === true;
}

export function isHistogram(rows: MetricRow[]): boolean {
  return rows[0]?.kind === "histogram";
}

/**
 * Aggregate explicit-bounds histogram buckets across all data points of the
 * latest time window into a single distribution. OTLP histogram value blob:
 * `{ bucketCounts: number[], explicitBounds: number[], count, sum, min, max }`.
 * `bucketCounts` has length `explicitBounds.length + 1` (last = +Inf overflow).
 */
export function histogramBuckets(rows: MetricRow[]): {
  buckets: HistoBucket[];
  percentiles: Array<{ label: string; value: number }>;
} {
  // Sum bucket counts across the most recent points per series (cumulative
  // histograms already accumulate, so taking the last point per series and
  // summing across series gives the current distribution).
  const bySeries = new Map<string, MetricRow>();
  for (const r of rows) {
    const sig = attrSignature(r.attributes ?? {});
    const cur = bySeries.get(sig);
    if (!cur || r.timeNano > cur.timeNano) bySeries.set(sig, r);
  }

  let bounds: number[] | null = null;
  let counts: number[] | null = null;
  for (const r of bySeries.values()) {
    const v = r.value as Record<string, unknown>;
    const eb = numArray(v.explicitBounds);
    const bc = numArray(v.bucketCounts);
    if (!eb || !bc || bc.length !== eb.length + 1) continue;
    if (!bounds) {
      bounds = eb;
      counts = bc.slice();
    } else if (bounds.length === eb.length) {
      for (let i = 0; i < bc.length; i++) counts![i] += bc[i];
    }
  }

  if (!bounds || !counts) return { buckets: [], percentiles: [] };

  const buckets: HistoBucket[] = counts.map((c, i) => ({
    lo: i === 0 ? 0 : bounds![i - 1],
    hi: i < bounds!.length ? bounds![i] : Number.POSITIVE_INFINITY,
    count: c,
  }));

  const total = counts.reduce((a, b) => a + b, 0);
  const estimate = (p: number): number => {
    if (total === 0) return 0;
    const target = p * total;
    let cum = 0;
    for (let i = 0; i < buckets.length; i++) {
      cum += buckets[i].count;
      if (cum >= target) {
        // Linear interpolation within the bucket.
        const lo = buckets[i].lo;
        const hi = Number.isFinite(buckets[i].hi) ? buckets[i].hi : lo;
        const inBucket = buckets[i].count || 1;
        const prevCum = cum - buckets[i].count;
        const frac = (target - prevCum) / inBucket;
        return lo + (hi - lo) * frac;
      }
    }
    return buckets[buckets.length - 1].lo;
  };

  const percentiles = [
    { label: "p50", value: estimate(0.5) },
    { label: "p90", value: estimate(0.9) },
    { label: "p99", value: estimate(0.99) },
  ];
  return { buckets, percentiles };
}

function numArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    if (Number.isNaN(n)) return null;
    out.push(n);
  }
  return out;
}
