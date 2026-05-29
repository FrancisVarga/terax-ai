import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { fmtDuration, type ServiceMap } from "../../lib/useOtel";
import { useDrilldown } from "../../lib/useDrilldown";
import { attrMatch, percentile, spanStats } from "../../lib/drilldown";
import {
  DetailSection,
  DetailShell,
  LatencyChart,
  OpsTable,
  StatStrip,
} from "./DetailShell";
import { CapNote } from "./ServiceDetail";
import { HttpPanelForSpans } from "./HttpPanel";
import { TracesTable } from "./TracesTable";
import { latencyHistogram, tracesFromSpans, topOps, errorBreakdown } from "../../lib/drilldown";

/**
 * Dependency-edge detail: the `from → to` cross-service calls. We fetch traces
 * touching the callee service, then keep only the child spans whose parent runs
 * in the caller service — i.e. the actual edge spans — and aggregate those.
 * Latency here is the callee-side span duration, which is the standard way a
 * service map reports per-dependency latency.
 */
export function EdgeDetail({
  from,
  to,
  map,
  tick,
  sinceMs,
  onBack,
  onOpenTrace,
  onOpenService,
}: {
  from: string;
  to: string;
  map: ServiceMap;
  tick: number;
  sinceMs?: number;
  onBack: () => void;
  onOpenTrace: (traceId: string) => void;
  onOpenService: (service: string) => void;
}) {
  // Pull traces involving the callee, then narrow to edge spans client-side:
  // a span in `to` whose parent span runs in `from`. The drilldown hook fetches
  // full traces (so parent lookup is possible), and we filter in useMemo below
  // rather than in spanFilter (which lacks cross-span parent context).
  const dd = useDrilldown(
    {
      attrSearch: attrMatch("service.name", to),
      sinceMs,
      maxTraces: 80,
    },
    [from, to, tick, sinceMs],
  );

  const edgeSpans = useMemo(() => {
    const byId = new Map(dd.spans.map((s) => [s.spanId, s]));
    return dd.spans.filter((s) => {
      if (s.service !== to) return false;
      const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
      return parent?.service === from;
    });
  }, [dd.spans, from, to]);

  const stats = useMemo(() => spanStats(edgeSpans), [edgeSpans]);
  const histogram = useMemo(() => latencyHistogram(edgeSpans), [edgeSpans]);
  const ops = useMemo(() => topOps(edgeSpans), [edgeSpans]);
  const errors = useMemo(() => errorBreakdown(edgeSpans), [edgeSpans]);
  const traces = useMemo(() => tracesFromSpans(edgeSpans), [edgeSpans]);
  const p99 = useMemo(
    () => percentile(edgeSpans.map((s) => s.durationNano), 0.99),
    [edgeSpans],
  );

  const mapEdge = map.edges.find((e) => e.from === from && e.to === to);

  return (
    <DetailShell
      title={`${from} → ${to}`}
      subtitle="service dependency"
      icon={
        <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.75} className="text-primary" />
      }
      onBack={onBack}
    >
      {dd.capped && <CapNote />}

      {/* Endpoints */}
      <div className="flex items-center gap-2 text-[12px]">
        <button
          type="button"
          onClick={() => onOpenService(from)}
          className="rounded-md border border-border/50 bg-background/40 px-2.5 py-1 font-mono text-foreground/90 transition-colors hover:bg-accent/40"
        >
          {from}
        </button>
        <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className="text-muted-foreground" />
        <button
          type="button"
          onClick={() => onOpenService(to)}
          className="rounded-md border border-border/50 bg-background/40 px-2.5 py-1 font-mono text-foreground/90 transition-colors hover:bg-accent/40"
        >
          {to}
        </button>
        {mapEdge && (
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
            map: {mapEdge.calls}× · p95 {fmtDuration(mapEdge.p95Nano)}
          </span>
        )}
      </div>

      <StatStrip stats={stats} />
      <div className="font-mono text-[10.5px] text-muted-foreground">
        p99 {fmtDuration(p99)}
      </div>

      <LatencyChart buckets={histogram} />

      <HttpPanelForSpans spans={edgeSpans} />

      <DetailSection title="Operations called" count={ops.length}>
        <OpsTable ops={ops} />
      </DetailSection>

      {errors.length > 0 && (
        <DetailSection title="Errors" count={errors.length}>
          <div className="flex flex-col gap-1">
            {errors.map((e) => (
              <div
                key={e.message}
                className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-destructive" title={e.message}>
                  {e.message}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-destructive/80">{e.count}×</span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      <DetailSection title="Sample traces" count={traces.length}>
        <TracesTable traces={traces} onOpenTrace={onOpenTrace} />
      </DetailSection>
    </DetailShell>
  );
}
