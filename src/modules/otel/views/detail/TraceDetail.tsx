import { cn } from "@/lib/utils";
import { ConnectIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import {
  fmtClock,
  fmtDuration,
  otel,
  spanKindLabel,
  useOtelResource,
  type SpanRow,
} from "../../lib/useOtel";
import { spanStats } from "../../lib/drilldown";
import { extractHttp } from "../../lib/http";
import {
  DetailSection,
  DetailShell,
  KvRow,
  StatStrip,
} from "./DetailShell";
import { HttpPanel } from "./HttpPanel";
import { MiniMesh } from "./MiniMesh";

/** Span with computed display order + depth for the waterfall. */
type LaidOutSpan = SpanRow & { depth: number };

/** Build a depth-ordered list from parent links (orphans treated as roots). */
function layoutSpans(spans: SpanRow[]): LaidOutSpan[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, SpanRow[]>();
  const roots: SpanRow[] = [];
  for (const s of spans) {
    const hasParent = s.parentSpanId && byId.has(s.parentSpanId);
    if (hasParent) {
      const arr = children.get(s.parentSpanId) ?? [];
      arr.push(s);
      children.set(s.parentSpanId, arr);
    } else {
      roots.push(s);
    }
  }
  const sortByStart = (a: SpanRow, b: SpanRow) => a.startNano - b.startNano;
  roots.sort(sortByStart);
  const out: LaidOutSpan[] = [];
  const walk = (s: SpanRow, depth: number) => {
    out.push({ ...s, depth });
    const kids = (children.get(s.spanId) ?? []).slice().sort(sortByStart);
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Full-page trace detail: header stats, a per-trace service-dependency graph,
 * the HTTP request panel for the inbound request, and the span waterfall with
 * per-span drill-down. Opened from the Traces list and from every other detail
 * page's "recent traces" table — it owns its own span fetch by trace id.
 */
export function TraceDetail({
  traceId,
  tick,
  onBack,
  onOpenGlobalMesh,
}: {
  traceId: string;
  tick: number;
  onBack: () => void;
  /** Open the global Service Mesh filtered to this trace's services. */
  onOpenGlobalMesh?: (services: string[]) => void;
}) {
  const { data: spans, loading } = useOtelResource<SpanRow[]>(
    () => otel.traceSpans(traceId),
    [],
    [traceId, tick],
  );

  const { laid, traceStart, traceDur, stats, services, rootName } = useMemo(() => {
    const laid = layoutSpans(spans);
    const stats = spanStats(spans);
    const services = Array.from(new Set(spans.map((s) => s.service))).sort();
    const rootName = laid[0]?.name ?? "(trace)";
    if (laid.length === 0) {
      return { laid, traceStart: 0, traceDur: 1, stats, services, rootName };
    }
    const start = Math.min(...spans.map((s) => s.startNano));
    const end = Math.max(...spans.map((s) => s.endNano));
    return {
      laid,
      traceStart: start,
      traceDur: Math.max(1, end - start),
      stats,
      services,
      rootName,
    };
  }, [spans]);

  return (
    <DetailShell
      title={rootName}
      subtitle={`trace ${traceId}`}
      onBack={onBack}
      actions={
        onOpenGlobalMesh && services.length > 1 ? (
          <button
            type="button"
            onClick={() => onOpenGlobalMesh(services)}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={ConnectIcon} size={12} strokeWidth={1.75} />
            Service mesh
          </button>
        ) : undefined
      }
    >
      {loading || spans.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground">
          {loading ? "Loading spans…" : "No spans for this trace."}
        </p>
      ) : (
        <>
          <StatStrip stats={stats} />

          <DetailSection title="Service graph" count={services.length}>
            <MiniMesh spans={spans} />
          </DetailSection>

          <HttpPanelForTrace spans={spans} />

          <DetailSection title="Waterfall" count={spans.length}>
            <div className="rounded-lg border border-border/50 bg-background/40 py-1">
              {laid.map((s) => (
                <WaterfallBar
                  key={s.spanId}
                  span={s}
                  traceStart={traceStart}
                  traceDur={traceDur}
                />
              ))}
            </div>
          </DetailSection>
        </>
      )}
    </DetailShell>
  );
}

/** Only render the HTTP panel section when an HTTP span exists in the trace. */
function HttpPanelForTrace({ spans }: { spans: SpanRow[] }) {
  // Prefer the inbound SERVER span; fall back to any HTTP client span.
  const server = spans.find((s) => s.kind === 2 && extractHttp(s).isHttp);
  const any = server ?? spans.find((s) => extractHttp(s).isHttp);
  if (!any) return null;
  return <HttpPanel span={any} />;
}

function WaterfallBar({
  span,
  traceStart,
  traceDur,
}: {
  span: LaidOutSpan;
  traceStart: number;
  traceDur: number;
}) {
  const [open, setOpen] = useState(false);
  const left = ((span.startNano - traceStart) / traceDur) * 100;
  const width = Math.max(0.5, (span.durationNano / traceDur) * 100);
  const isError = span.statusCode === 2;
  return (
    <div className="px-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 rounded py-0.5 text-left hover:bg-accent/40"
      >
        <div
          className="flex min-w-0 items-center gap-1.5"
          style={{ paddingLeft: `${span.depth * 14}px`, width: "44%" }}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              isError ? "bg-red-400" : "bg-primary/60",
            )}
          />
          <span className="truncate text-[11.5px] text-foreground/90">{span.name}</span>
        </div>
        <div className="relative h-3.5 flex-1">
          <div
            className={cn(
              "absolute top-0 h-full rounded-sm",
              isError ? "bg-red-400/70" : "bg-primary/55",
            )}
            style={{ left: `${left}%`, width: `${width}%`, minWidth: "2px" }}
          />
        </div>
        <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {fmtDuration(span.durationNano)}
        </span>
      </button>
      {open && <SpanDetail span={span} />}
    </div>
  );
}

function SpanDetail({ span }: { span: LaidOutSpan }) {
  const attrs = Object.entries(span.attributes ?? {});
  const resource = Object.entries(span.resource ?? {});
  return (
    <div
      className="mb-1 flex flex-col gap-1.5 rounded-md border border-border/50 bg-background/40 px-3 py-2"
      style={{ marginLeft: `${span.depth * 14 + 12}px` }}
    >
      <div className="flex flex-col gap-0.5">
        <KvRow k="span.id" v={span.spanId} />
        {span.parentSpanId && <KvRow k="parent.id" v={span.parentSpanId} />}
        <KvRow k="service" v={span.service} />
        <KvRow k="kind" v={spanKindLabel(span.kind)} />
        <KvRow k="start" v={fmtClock(span.startNano)} />
        <KvRow k="duration" v={fmtDuration(span.durationNano)} />
        {span.scopeName && <KvRow k="scope" v={span.scopeName} />}
        {span.statusMessage && <KvRow k="status" v={span.statusMessage} />}
      </div>
      {attrs.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
          <span className="mb-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">
            attributes
          </span>
          {attrs.map(([k, v]) => (
            <KvRow key={k} k={k} v={String(v)} />
          ))}
        </div>
      )}
      {resource.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
          <span className="mb-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">
            resource
          </span>
          {resource.map(([k, v]) => (
            <KvRow key={k} k={k} v={String(v)} />
          ))}
        </div>
      )}
      {span.events?.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
          <span className="mb-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">
            events
          </span>
          {span.events.map((e, i) => (
            <KvRow key={i} k={`${e.name} @ ${fmtClock(e.timeNano)}`} v={
              Object.entries(e.attributes ?? {})
                .map(([k, v]) => `${k}=${String(v)}`)
                .join("  ") || "—"
            } />
          ))}
        </div>
      )}
    </div>
  );
}
