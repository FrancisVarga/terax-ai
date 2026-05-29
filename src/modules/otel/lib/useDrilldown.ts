import { useMemo } from "react";
import {
  otel,
  useOtelResource,
  type SpanRow,
  type TraceSummary,
} from "./useOtel";
import {
  errorBreakdown,
  latencyHistogram,
  spanStats,
  topOps,
  tracesFromSpans,
} from "./drilldown";

/**
 * Fetch the spans for a drill-down filter and derive the shared analytics from
 * them. The backend exposes no "spans matching attribute X" command, so we
 * compose the two primitives it does have: list the matching traces
 * (`otel.traces` understands service / attr / errors filters), then pull every
 * span of each (`otel.traceSpans`) and aggregate client-side. Trace fan-out is
 * capped so a huge match set can't issue thousands of span queries.
 */

export type DrilldownFilter = {
  /** Root-service filter (TraceQuery.service). */
  service?: string;
  /** Whole-trace attribute EXISTS match (TraceQuery.attrSearch). */
  attrSearch?: string;
  /** Only error traces. */
  errorsOnly?: boolean;
  sinceMs?: number;
  /** Max traces to fan out into span fetches (default 60). */
  maxTraces?: number;
  /**
   * Keep only spans satisfying this predicate after fetch. Used by pages that
   * need a tighter scope than the whole-trace match (e.g. only spans whose own
   * attribute equals the value, or only the spans of one service/edge).
   */
  spanFilter?: (s: SpanRow) => boolean;
};

export type Drilldown = {
  loading: boolean;
  /** Traces matched by the filter (pre span-fetch), newest first. */
  matchedTraces: TraceSummary[];
  /** Every span fetched across the matched traces, post `spanFilter`. */
  spans: SpanRow[];
  /** True when the trace fan-out was capped (span stats are a sample). */
  capped: boolean;
  stats: ReturnType<typeof spanStats>;
  ops: ReturnType<typeof topOps>;
  errors: ReturnType<typeof errorBreakdown>;
  histogram: ReturnType<typeof latencyHistogram>;
  traces: ReturnType<typeof tracesFromSpans>;
};

export function useDrilldown(
  filter: DrilldownFilter,
  deps: unknown[],
): Drilldown {
  const maxTraces = filter.maxTraces ?? 60;

  const { data: matchedTraces, loading: tracesLoading } = useOtelResource<
    TraceSummary[]
  >(
    () =>
      otel.traces({
        service: filter.service,
        attrSearch: filter.attrSearch,
        errorsOnly: filter.errorsOnly || undefined,
        sinceMs: filter.sinceMs,
        sort: "recent",
        limit: maxTraces,
      }),
    [],
    deps,
  );

  const traceIds = useMemo(
    () => matchedTraces.map((t) => t.traceId),
    [matchedTraces],
  );
  const idKey = traceIds.join(",");

  // Fan out to span fetches for the matched traces, in parallel.
  const { data: spans, loading: spansLoading } = useOtelResource<SpanRow[]>(
    async () => {
      if (traceIds.length === 0) return [];
      const batches = await Promise.all(
        traceIds.map((id) => otel.traceSpans(id).catch(() => [] as SpanRow[])),
      );
      let flat = batches.flat();
      if (filter.spanFilter) flat = flat.filter(filter.spanFilter);
      return flat;
    },
    [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKey],
  );

  return useMemo(() => {
    const capped = matchedTraces.length >= maxTraces;
    return {
      loading: tracesLoading || spansLoading,
      matchedTraces,
      spans,
      capped,
      stats: spanStats(spans),
      ops: topOps(spans),
      errors: errorBreakdown(spans),
      histogram: latencyHistogram(spans),
      traces: tracesFromSpans(spans),
    };
  }, [matchedTraces, spans, tracesLoading, spansLoading, maxTraces]);
}
