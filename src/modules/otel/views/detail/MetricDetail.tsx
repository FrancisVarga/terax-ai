import { cn } from "@/lib/utils";
import { ChartLineData01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo } from "react";
import {
  fmtClock,
  metricScalar,
  otel,
  useOtelResource,
  type MetricRow,
} from "../../lib/useOtel";
import {
  attrSignature,
  histogramBuckets,
  isCounter,
  isHistogram,
  toRateSeries,
  toSeries,
} from "../../lib/metrics";
import { DetailSection, DetailShell } from "./DetailShell";
import { HistogramChart, LineChart } from "./charts";
import { OtelGrid } from "./OtelGrid";

/**
 * Full-page metric detail with deep charts: a per-series overlay line chart
 * (each label combination its own colored line) with a min–max envelope band
 * and hover crosshair; for monotonic counters a derived per-interval rate
 * chart; for histograms a bucket-distribution chart with estimated p50/p90/p99;
 * plus summary stats, a series table, and the raw data points.
 */
export function MetricDetail({
  name,
  tick,
  onBack,
}: {
  name: string;
  tick: number;
  onBack: () => void;
}) {
  const { data: series, loading } = useOtelResource<MetricRow[]>(
    () => otel.metricSeries(name, 2000),
    [],
    [name, tick],
  );

  const {
    stats,
    seriesGroups,
    lineSeries,
    rateSeries,
    histo,
    meta,
    counter,
    histogram,
    rawPoints,
  } = useMemo(() => {
      const vals = series.map(metricScalar);
      const peak = vals.length ? Math.max(...vals) : 0;
      const low = vals.length ? Math.min(...vals) : 0;
      const last = vals.length ? vals[vals.length - 1] : 0;
      const sum = vals.reduce((a, b) => a + b, 0);
      const avg = vals.length ? sum / vals.length : 0;

      const lineSeries = toSeries(series);
      const counter = isCounter(series);
      const histogram = isHistogram(series);
      const rateSeries = counter ? toRateSeries(series) : [];
      const histo = histogram ? histogramBuckets(series) : { buckets: [], percentiles: [] };

      const seriesGroups = lineSeries.map((s) => {
        const gv = s.points.map((p) => p.v);
        return {
          sig: s.label,
          color: s.color,
          points: s.points.length,
          last: gv[gv.length - 1] ?? 0,
          max: gv.length ? Math.max(...gv) : 0,
          min: gv.length ? Math.min(...gv) : 0,
        };
      });

      const rawPoints: RawPointRow[] = series
        .slice()
        .reverse()
        .slice(0, 500)
        .map((r) => ({
          timeNano: r.timeNano,
          value: metricScalar(r),
          labels: attrSignature(r.attributes ?? {}) || "—",
        }));

      return {
        stats: { peak, low, last, avg, sum, count: vals.length },
        seriesGroups,
        lineSeries,
        rateSeries,
        histo,
        counter,
        histogram,
        rawPoints,
        meta: {
          kind: series[0]?.kind ?? "",
          unit: series[0]?.unit ?? "",
          description: series[0]?.description ?? "",
        },
      };
    }, [series]);

  const fmtVal = (v: number) =>
    Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");

  return (
    <DetailShell
      title={name}
      subtitle={
        [meta.kind, meta.unit].filter(Boolean).join(" · ") || "metric"
      }
      icon={
        <HugeiconsIcon icon={ChartLineData01Icon} size={16} strokeWidth={1.75} className="text-primary" />
      }
      onBack={onBack}
    >
      {loading || series.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground">
          {loading ? "Loading series…" : "No data points."}
        </p>
      ) : (
        <>
          {meta.description && (
            <p className="text-[11.5px] text-muted-foreground">{meta.description}</p>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Cell label="last" value={fmtVal(stats.last)} />
            <Cell label="avg" value={fmtVal(stats.avg)} />
            <Cell label="peak" value={fmtVal(stats.peak)} />
            <Cell label="min" value={fmtVal(stats.low)} />
            <Cell label="sum" value={fmtVal(stats.sum)} />
            <Cell label="points" value={String(stats.count)} />
          </div>

          <DetailSection
            title={histogram ? "Value over time" : "Time series"}
            count={seriesGroups.length > 1 ? seriesGroups.length : undefined}
          >
            <LineChart series={lineSeries} showBand height={220} />
          </DetailSection>

          {counter && rateSeries.length > 0 && (
            <DetailSection title="Rate (per second)">
              <LineChart series={rateSeries} height={180} />
            </DetailSection>
          )}

          {histogram && histo.buckets.length > 0 && (
            <DetailSection title="Distribution (latest)">
              <HistogramChart
                buckets={histo.buckets}
                percentiles={histo.percentiles}
                unit={meta.unit}
              />
            </DetailSection>
          )}

          {seriesGroups.length > 1 && (
            <DetailSection title="Series (by labels)" count={seriesGroups.length}>
              <OtelGrid
                columnDefs={seriesColumns}
                rowData={seriesGroups}
                height={Math.min(360, 64 + seriesGroups.length * 28)}
              />
            </DetailSection>
          )}

          <DetailSection title="Raw points" count={series.length}>
            <OtelGrid columnDefs={pointColumns} rowData={rawPoints} height={340} />
          </DetailSection>
        </>
      )}
    </DetailShell>
  );
}

type SeriesGroupRow = {
  sig: string;
  color: string;
  points: number;
  last: number;
  min: number;
  max: number;
};

type RawPointRow = { timeNano: number; value: number; labels: string };

const fmtNum = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");

const seriesColumns: ColDef<SeriesGroupRow>[] = [
  {
    field: "sig",
    headerName: "Labels",
    flex: 2,
    minWidth: 200,
    cellRenderer: (p: ICellRendererParams<SeriesGroupRow>) => {
      const s = p.data;
      if (!s) return null;
      return (
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 shrink-0 rounded-sm" style={{ background: s.color }} />
          <span className="truncate" title={s.sig}>
            {s.sig}
          </span>
        </span>
      );
    },
  },
  { field: "points", headerName: "Points", type: "numericColumn", flex: 0, width: 90 },
  {
    field: "last",
    headerName: "Last",
    type: "numericColumn",
    flex: 0,
    width: 100,
    valueFormatter: (p) => fmtNum(Number(p.value ?? 0)),
  },
  {
    field: "min",
    headerName: "Min",
    type: "numericColumn",
    flex: 0,
    width: 100,
    valueFormatter: (p) => fmtNum(Number(p.value ?? 0)),
  },
  {
    field: "max",
    headerName: "Max",
    type: "numericColumn",
    flex: 0,
    width: 100,
    valueFormatter: (p) => fmtNum(Number(p.value ?? 0)),
  },
];

const pointColumns: ColDef<RawPointRow>[] = [
  {
    field: "timeNano",
    headerName: "Time",
    flex: 0,
    width: 140,
    valueFormatter: (p) => fmtClock(Number(p.value ?? 0)),
  },
  {
    field: "value",
    headerName: "Value",
    type: "numericColumn",
    flex: 0,
    width: 120,
    valueFormatter: (p) => fmtNum(Number(p.value ?? 0)),
  },
  { field: "labels", headerName: "Labels", flex: 1, minWidth: 160 },
];

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn("flex flex-col rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5")}>
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <span className="font-mono text-[12.5px] text-foreground/90">{value}</span>
    </div>
  );
}
