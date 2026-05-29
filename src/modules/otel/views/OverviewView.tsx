import { cn } from "@/lib/utils";
import {
  Activity03Icon,
  AlertCircleIcon,
  Database02Icon,
  FilterIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  fmtClock,
  otel,
  severityLevel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type LogRow,
  type OtelCounts,
  type ServiceMap,
} from "../lib/useOtel";
import { SegmentedControl } from "./TracesView";
import { LogDetail } from "./detail/LogDetail";
import { TraceDetail } from "./detail/TraceDetail";
import { AttrFilterInput } from "./detail/AttrFilterInput";
import { LineChart, SERIES_COLORS, type Series } from "./detail/charts";

/** A rolling sample of cumulative counts, used to derive realtime throughput. */
type Sample = { t: number; counts: OtelCounts };
const MAX_SAMPLES = 60;

type OverviewNav =
  | { kind: "dash" }
  | { kind: "log"; log: LogRow }
  | { kind: "trace"; traceId: string };

const LEVELS: Array<{ label: string; min: number }> = [
  { label: "All", min: 0 },
  { label: "Info+", min: 9 },
  { label: "Warn+", min: 13 },
  { label: "Error+", min: 17 },
];

/**
 * Overview: the realtime landing dashboard. Live throughput tiles + sparklines
 * derived client-side from the cumulative `counts` (sampled each ingest tick),
 * and an embedded log feed sharing the Logs view's filter + query semantics.
 * This is the at-a-glance "is data flowing, and what just happened" surface.
 */
export function OverviewView({ tick }: { tick: number }) {
  const [nav, setNav] = useState<OverviewNav>({ kind: "dash" });

  // Log-feed filters (same shape as LogsView).
  const [service, setService] = useState("");
  const [minSeverity, setMinSeverity] = useState(0);
  const [search, setSearch] = useState("");
  const [attrSearch, setAttrSearch] = useState("");
  const [windowMs, setWindowMs] = useState(5 * 60_000);

  const { data: counts } = useOtelResource<OtelCounts>(
    () => otel.counts(),
    { traces: 0, spans: 0, logs: 0, metrics: 0, dbBytes: 0 },
    [tick],
  );
  const { data: services } = useOtelResource<string[]>(() => otel.services(), [], [tick]);
  const { data: attrKeys } = useOtelResource<string[]>(() => otel.attributeKeys(), [], [tick]);
  const { data: serviceMap } = useOtelResource<ServiceMap>(
    () => otel.serviceMap(sinceFromWindow(windowMs)),
    { nodes: [], edges: [] },
    [tick, windowMs],
  );

  const { data: logs } = useOtelResource<LogRow[]>(
    () =>
      otel.logs({
        service: service || undefined,
        minSeverity: minSeverity || undefined,
        search: search.trim() || undefined,
        attrSearch: attrSearch.trim() || undefined,
        sinceMs: sinceFromWindow(windowMs),
        limit: 500,
      }),
    [],
    [tick, service, minSeverity, search, attrSearch, windowMs],
  );

  // Rolling samples of the cumulative counts → realtime throughput sparklines.
  const samplesRef = useRef<Sample[]>([]);
  const [, force] = useState(0);
  useEffect(() => {
    const buf = samplesRef.current;
    const prev = buf[buf.length - 1];
    // Avoid stacking identical samples (counts haven't moved).
    if (
      !prev ||
      prev.counts.spans !== counts.spans ||
      prev.counts.logs !== counts.logs ||
      prev.counts.metrics !== counts.metrics
    ) {
      buf.push({ t: Date.now(), counts });
      if (buf.length > MAX_SAMPLES) buf.shift();
      force((n) => n + 1);
    }
  }, [counts]);

  // Detail navigation (after all hooks — Rules of Hooks).
  if (nav.kind === "log") {
    return (
      <LogDetail
        log={nav.log}
        onBack={() => setNav({ kind: "dash" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
      />
    );
  }
  if (nav.kind === "trace") {
    return (
      <TraceDetail
        traceId={nav.traceId}
        tick={tick}
        onBack={() => setNav({ kind: "dash" })}
      />
    );
  }

  const samples = samplesRef.current;
  const spanRate = deltaSeries(samples, (c) => c.spans);
  const logRate = deltaSeries(samples, (c) => c.logs);
  const metricRate = deltaSeries(samples, (c) => c.metrics);
  const errCount = logs.filter((l) => l.severityNumber >= 17).length;

  // Throughput overlay (spans/logs/metrics per second) from the rolling samples.
  const throughput: Series[] = [
    { label: "spans/s", color: SERIES_COLORS[0], points: ratePoints(samples, (c) => c.spans) },
    { label: "logs/s", color: SERIES_COLORS[1], points: ratePoints(samples, (c) => c.logs) },
    { label: "metrics/s", color: SERIES_COLORS[4], points: ratePoints(samples, (c) => c.metrics) },
  ].filter((s) => s.points.length > 0);

  // Top services by span volume (from the service map nodes).
  const topServices = serviceMap.nodes
    .slice()
    .sort((a, b) => b.spans - a.spans)
    .slice(0, 8);
  const maxSvcSpans = Math.max(1, ...topServices.map((n) => n.spans));

  // Severity distribution of the current log window.
  const sevDist = severityDistribution(logs);
  const maxSev = Math.max(1, ...sevDist.map((s) => s.count));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Live tiles */}
      <div className="grid grid-cols-2 gap-2 border-b border-border/60 p-3 sm:grid-cols-4">
        <Tile
          icon={Activity03Icon}
          label="Spans"
          value={counts.spans}
          rate={spanRate}
          color="#6366f1"
        />
        <Tile icon={Activity03Icon} label="Logs" value={counts.logs} rate={logRate} color="#10b981" />
        <Tile
          icon={Database02Icon}
          label="Metrics"
          value={counts.metrics}
          rate={metricRate}
          color="#06b6d4"
        />
        <Tile
          icon={AlertCircleIcon}
          label="Errors (window)"
          value={errCount}
          rate={[]}
          color="#ef4444"
          danger={errCount > 0}
        />
      </div>

      {/* Deep charts: throughput + service breakdown + severity */}
      <div className="grid grid-cols-1 gap-3 border-b border-border/60 p-3 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Ingest throughput (per second)
          </div>
          {throughput.length > 0 ? (
            <LineChart series={throughput} showBand height={150} />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg border border-border/50 bg-background/40 text-[11px] text-muted-foreground">
              Waiting for live samples…
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Top services by span volume
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-3">
            {topServices.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No services yet.</p>
            ) : (
              topServices.map((n) => {
                const errRate = n.spans > 0 ? n.errors / n.spans : 0;
                return (
                  <div key={n.service} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                      <span className="truncate text-foreground/85" title={n.service}>
                        {n.service}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {n.spans}
                        {n.errors > 0 && <span className="text-red-400"> · {n.errors} err</span>}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          errRate > 0.01 ? "bg-red-400/70" : "bg-primary/60",
                        )}
                        style={{ width: `${(n.spans / maxSvcSpans) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Log severity distribution (window)
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-3">
            {sevDist.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No logs in window.</p>
            ) : (
              sevDist.map((s) => (
                <div key={s.label} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                    <span className={cn("font-semibold", s.cls)}>{s.label}</span>
                    <span className="text-muted-foreground">{s.count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary/55"
                      style={{ width: `${(s.count / maxSev) * 100}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Log feed filters */}
      <div className="flex flex-col gap-2 border-b border-border/60 p-2.5">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.75} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search log bodies…"
              className="w-full bg-transparent py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-[11.5px] outline-none"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="flex items-center overflow-hidden rounded-md border border-border/60">
            {LEVELS.map((l) => (
              <button
                key={l.min}
                type="button"
                onClick={() => setMinSeverity(l.min)}
                className={cn(
                  "px-2 py-1 text-[11px] font-medium transition-colors",
                  minSeverity === l.min
                    ? "bg-accent text-foreground"
                    : "bg-background/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
            <HugeiconsIcon icon={FilterIcon} size={12} strokeWidth={1.75} className="text-muted-foreground" />
            <AttrFilterInput
              value={attrSearch}
              onChange={setAttrSearch}
              attributeKeys={attrKeys}
              placeholder="Attribute / query match (e.g. tenant.id, a request id)…"
            />
          </div>
          <SegmentedControl
            label="Window"
            options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
            value={windowMs}
            onChange={setWindowMs}
          />
        </div>
      </div>

      {/* Live log feed */}
      <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        <span>Live log feed</span>
        <span>{logs.length} records</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {logs.length === 0 ? (
          <p className="p-4 text-center text-[11.5px] text-muted-foreground">
            No logs match the current filters.
          </p>
        ) : (
          <ul className="flex flex-col">
            {logs.map((l, i) => {
              const sev = severityLevel(l.severityNumber);
              return (
                <li key={`${l.timeNano}:${i}`} className="border-b border-border/30">
                  <button
                    type="button"
                    onClick={() => setNav({ kind: "log", log: l })}
                    className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-accent/40"
                  >
                    <span className="shrink-0 text-muted-foreground/60">{fmtClock(l.timeNano)}</span>
                    <span className={cn("w-12 shrink-0 font-semibold", sev.cls)}>
                      {sev.label || l.severityText}
                    </span>
                    <span className="shrink-0 truncate text-foreground/60" style={{ maxWidth: 120 }}>
                      {l.service}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground/90">{l.body}</span>
                    {l.traceId && (
                      <span className="shrink-0 rounded bg-primary/10 px-1 text-[9.5px] text-primary/80">
                        trace
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  rate,
  color,
  danger,
}: {
  icon: typeof Activity03Icon;
  label: string;
  value: number;
  rate: number[];
  color: string;
  danger?: boolean;
}) {
  const perSec = rate.length > 0 ? rate[rate.length - 1] : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        <HugeiconsIcon icon={icon} size={11} strokeWidth={1.75} />
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("font-mono text-[18px] font-semibold text-foreground", danger && "text-red-400")}>
          {value > 99999 ? `${(value / 1000).toFixed(0)}k` : value}
        </span>
        {rate.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground">
            +{perSec.toFixed(perSec < 10 ? 1 : 0)}/s
          </span>
        )}
      </div>
      {rate.length > 1 && <Sparkline values={rate} color={color} />}
    </div>
  );
}

/** Tiny inline sparkline of recent per-interval rates. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 120;
  const H = 22;
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? W : (i / (n - 1)) * W;
    const y = H - (v / max) * (H - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-5 w-full">
      <path
        d={pts.length ? `M${pts.join(" L")}` : ""}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Per-second deltas of a cumulative count across rolling samples. */
function deltaSeries(samples: Sample[], pick: (c: OtelCounts) => number): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const dv = pick(samples[i].counts) - pick(samples[i - 1].counts);
    out.push(dv < 0 ? 0 : dv / dt);
  }
  return out;
}

/** Per-second rate points (t in ns to match the chart's clock formatter). */
function ratePoints(
  samples: Sample[],
  pick: (c: OtelCounts) => number,
): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const dv = pick(samples[i].counts) - pick(samples[i - 1].counts);
    out.push({ t: samples[i].t * 1e6, v: dv < 0 ? 0 : dv / dt });
  }
  return out;
}

/** Count logs per severity label for the distribution bars. */
function severityDistribution(logs: LogRow[]): Array<{ label: string; cls: string; count: number }> {
  const order = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
  const counts = new Map<string, { cls: string; count: number }>();
  for (const l of logs) {
    const { label, cls } = severityLevel(l.severityNumber);
    const key = label || l.severityText || "INFO";
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { cls, count: 1 });
  }
  return Array.from(counts.entries())
    .map(([label, v]) => ({ label, cls: v.cls, count: v.count }))
    .sort((a, b) => {
      const ia = order.indexOf(a.label);
      const ib = order.indexOf(b.label);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}
