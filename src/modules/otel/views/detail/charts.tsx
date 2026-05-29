import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { fmtClock } from "../../lib/useOtel";

/**
 * Lightweight, dependency-free chart primitives for the metric detail page.
 * Everything is inline SVG + a thin React hover layer, matching the app's
 * "no chart library" convention. Three primitives cover the deep-metrics needs:
 * a multi-series line chart (overlay + min/max band + hover crosshair), and a
 * histogram-bucket bar chart.
 */

export type SeriesPoint = { t: number; v: number };
export type Series = { label: string; color: string; points: SeriesPoint[] };

/** A categorical palette for overlaid series. Cycles for >N series. */
export const SERIES_COLORS = [
  "#6366f1", // indigo (primary)
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#ec4899", // pink
  "#84cc16", // lime
];

const W = 920;
const H = 220;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 8;

function niceVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.001) return v.toExponential(2);
  return v.toFixed(3).replace(/\.?0+$/, "");
}

/**
 * Multi-series time-series line chart. Optionally shades a min–max band (the
 * envelope across all series at each x) and shows a hover crosshair with the
 * value of every series at the hovered point. All series are sampled to a
 * shared x-domain by index position (points are assumed time-ordered).
 */
export function LineChart({
  series,
  showBand = false,
  height = 220,
}: {
  series: Series[];
  showBand?: boolean;
  height?: number;
}) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  const model = useMemo(() => {
    const allV = series.flatMap((s) => s.points.map((p) => p.v));
    const allT = series.flatMap((s) => s.points.map((p) => p.t));
    if (allV.length === 0) return null;
    const lo = Math.min(...allV);
    const hi = Math.max(...allV);
    const span = Math.max(1e-9, hi - lo);
    const maxLen = Math.max(...series.map((s) => s.points.length));
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const x = (i: number, len: number) =>
      PAD_L + (len <= 1 ? innerW : (i / (len - 1)) * innerW);
    const y = (v: number) => PAD_T + innerH - ((v - lo) / span) * innerH;

    const paths = series.map((s) => {
      const pts = s.points.map((p, i) => `${x(i, s.points.length).toFixed(1)},${y(p.v).toFixed(1)}`);
      return { label: s.label, color: s.color, d: pts.length ? `M${pts.join(" L")}` : "" };
    });

    // Min/max envelope band across all series, by index.
    let band = "";
    if (showBand && series.length > 0) {
      const lens = series.map((s) => s.points.length);
      const n = Math.max(...lens);
      const top: string[] = [];
      const bot: string[] = [];
      for (let i = 0; i < n; i++) {
        const vs = series.map((s) => s.points[i]?.v).filter((v): v is number => v != null);
        if (vs.length === 0) continue;
        const xi = x(i, n);
        top.push(`${xi.toFixed(1)},${y(Math.max(...vs)).toFixed(1)}`);
        bot.unshift(`${xi.toFixed(1)},${y(Math.min(...vs)).toFixed(1)}`);
      }
      if (top.length) band = `M${top.join(" L")} L${bot.join(" L")} Z`;
    }

    const times = series[0]?.points.map((p) => p.t) ?? allT;
    return { lo, hi, maxLen, x, y, paths, band, times };
  }, [series, showBand]);

  if (!model) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-border/50 bg-background/40 text-[11.5px] text-muted-foreground">
        No data points.
      </div>
    );
  }

  // Hovered index from pointer x (px within the svg's logical W coordinate).
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.round(frac * (model.maxLen - 1));
    setHoverX(Math.max(0, Math.min(model.maxLen - 1, i)));
  };

  const hoverPxX =
    hoverX != null ? model.x(hoverX, model.maxLen) : null;
  const hoverTime = hoverX != null ? model.times[hoverX] : null;

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
        role="img"
      >
        <line x1={0} y1={H - 1} x2={W} y2={H - 1} stroke="currentColor" className="text-border/50" strokeWidth={1} />
        {model.band && <path d={model.band} fill="var(--primary, #6366f1)" opacity={0.08} />}
        {model.paths.map((p) => (
          <path
            key={p.label}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
          />
        ))}
        {hoverPxX != null && (
          <line
            x1={hoverPxX}
            y1={PAD_T}
            x2={hoverPxX}
            y2={H - PAD_B}
            stroke="currentColor"
            className="text-muted-foreground/40"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {hoverPxX != null &&
          series.map((s) => {
            const p = s.points[hoverX!];
            if (!p) return null;
            return (
              <circle
                key={s.label}
                cx={hoverPxX}
                cy={model.y(p.v)}
                r={2.5}
                fill={s.color}
                stroke="var(--background, #000)"
                strokeWidth={1}
              />
            );
          })}
      </svg>
      {/* Axis labels */}
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>peak {niceVal(model.hi)}</span>
        {hoverTime != null ? (
          <span className="text-foreground/70">{fmtClock(hoverTime)}</span>
        ) : (
          <span>min {niceVal(model.lo)}</span>
        )}
        <span>{model.maxLen} pts</span>
      </div>
      {/* Hover readout */}
      {hoverX != null && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9.5px]">
          {series.map((s) => {
            const p = s.points[hoverX];
            if (!p) return null;
            return (
              <span key={s.label} className="flex items-center gap-1">
                <span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="text-foreground/85">{niceVal(p.v)}</span>
              </span>
            );
          })}
        </div>
      )}
      {/* Legend (when multiple series) */}
      {series.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/40 pt-1.5 font-mono text-[9.5px]">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />
              <span className="truncate text-muted-foreground" title={s.label} style={{ maxWidth: 220 }}>
                {s.label}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export type HistoBucket = { lo: number; hi: number; count: number };

/**
 * Histogram bucket distribution bars with optional percentile markers. `lo`/`hi`
 * are the explicit bounds (`hi = +Inf` for the overflow bucket). Percentiles are
 * estimated from the cumulative bucket counts and drawn as labeled vlines.
 */
export function HistogramChart({
  buckets,
  percentiles,
  unit,
}: {
  buckets: HistoBucket[];
  percentiles?: Array<{ label: string; value: number }>;
  unit?: string;
}) {
  if (buckets.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground">No histogram buckets.</p>;
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const fmtBound = (v: number) =>
    !Number.isFinite(v) ? "∞" : Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex h-32 items-end gap-0.5">
        {buckets.map((b, i) => (
          <div
            key={i}
            className="group relative flex flex-1 items-end"
            title={`[${fmtBound(b.lo)}, ${fmtBound(b.hi)})${unit ? ` ${unit}` : ""}: ${b.count}`}
          >
            <div
              className="w-full rounded-t bg-primary/60 transition-colors group-hover:bg-primary"
              style={{ height: `${(b.count / max) * 100}%`, minHeight: b.count > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>{fmtBound(buckets[0].lo)}</span>
        <span>bucket distribution{unit ? ` (${unit})` : ""}</span>
        <span>{fmtBound(buckets[buckets.length - 1].hi)}</span>
      </div>
      {percentiles && percentiles.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/40 pt-1.5 font-mono text-[9.5px]">
          {percentiles.map((p) => (
            <span key={p.label} className={cn("text-muted-foreground")}>
              {p.label} <span className="text-foreground/85">{fmtBound(p.value)}{unit ? ` ${unit}` : ""}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
