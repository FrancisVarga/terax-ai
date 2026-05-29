import { Spinner } from "@/components/ui/spinner";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useDockerStats, type StatsSample } from "./lib/useDockerContainers";

type Props = {
  containerId: string;
  host: string | null;
  /** Skip polling for stopped containers (stats would be all-zero). */
  running: boolean;
};

/** Human bytes (SI), e.g. 1500 → "1.5 kB". */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / 10 ** (i * 3);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Bytes/sec → human rate. */
function fmtRate(n: number): string {
  return `${fmtBytes(n)}/s`;
}

/**
 * Live resource graphs for a container: CPU%, memory%, network rate, and block
 * I/O rate. Samples are polled by `useDockerStats`; this just renders the
 * sliding window as lightweight SVG sparklines that update each tick.
 */
export function DockerStatsGraphs({ containerId, host, running }: Props) {
  const { samples, loading, error } = useDockerStats(
    containerId,
    host,
    // Don't poll a stopped container — but keep the hook mounted (rules-of-hooks)
    // by using a very slow interval; `running` gates the displayed UI below.
    running ? undefined : { intervalMs: 60_000 },
  );

  // Net/block are cumulative counters — convert to per-second rates between
  // consecutive samples so the graph shows throughput, not a monotonic climb.
  const rates = useMemo(() => deriveRates(samples), [samples]);

  if (!running) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Container is not running — no live stats.
      </p>
    );
  }

  if (error && samples.length === 0) {
    return (
      <div className="flex items-start gap-2 text-[11.5px] text-destructive">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={13}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0"
        />
        <span className="break-words">{error}</span>
      </div>
    );
  }

  if (loading && samples.length === 0) {
    return (
      <div className="flex items-center gap-2 py-2 text-[11.5px] text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>Sampling stats…</span>
      </div>
    );
  }

  const latest = samples[samples.length - 1];
  const latestRate = rates[rates.length - 1];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Graph
        label="CPU"
        value={`${latest.cpu_percent.toFixed(1)}%`}
        series={samples.map((s) => s.cpu_percent)}
        max={100}
        color="var(--chart-cpu, #22c55e)"
      />
      <Graph
        label="Memory"
        value={`${latest.mem_percent.toFixed(1)}% · ${fmtBytes(latest.mem_used)}`}
        series={samples.map((s) => s.mem_percent)}
        max={100}
        color="var(--chart-mem, #3b82f6)"
      />
      <Graph
        label="Network"
        value={
          latestRate
            ? `↓ ${fmtRate(latestRate.net_rx)}  ↑ ${fmtRate(latestRate.net_tx)}`
            : "—"
        }
        series={rates.map((r) => r.net_rx + r.net_tx)}
        color="var(--chart-net, #a855f7)"
      />
      <Graph
        label="Block I/O"
        value={
          latestRate
            ? `R ${fmtRate(latestRate.block_read)}  W ${fmtRate(latestRate.block_write)}`
            : "—"
        }
        series={rates.map((r) => r.block_read + r.block_write)}
        color="var(--chart-block, #f59e0b)"
      />
    </div>
  );
}

type Rate = {
  net_rx: number;
  net_tx: number;
  block_read: number;
  block_write: number;
};

/** Per-second deltas between consecutive cumulative samples. */
function deriveRates(samples: StatsSample[]): Rate[] {
  const out: Rate[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    // Counters reset to a smaller value when the container restarts; clamp
    // negatives to 0 so a reset doesn't render as a huge spike.
    const rate = (x: number, y: number) => Math.max(0, (y - x) / dt);
    out.push({
      net_rx: rate(a.net_rx, b.net_rx),
      net_tx: rate(a.net_tx, b.net_tx),
      block_read: rate(a.block_read, b.block_read),
      block_write: rate(a.block_write, b.block_write),
    });
  }
  return out;
}

/**
 * A single sparkline card. `max` fixes the Y scale (used for percentages); when
 * omitted the series auto-scales to its own peak (used for rates).
 */
function Graph({
  label,
  value,
  series,
  max,
  color,
}: {
  label: string;
  value: string;
  series: number[];
  max?: number;
  color: string;
}) {
  const W = 240;
  const H = 56;
  const peak = max ?? Math.max(1, ...series);
  const n = series.length;

  const { line, area } = useMemo(() => {
    if (n === 0) return { line: "", area: "" };
    const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
    const y = (v: number) => H - (Math.min(v, peak) / peak) * (H - 2) - 1;
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const line = `M${pts.join(" L")}`;
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { line, area };
  }, [series, n, peak]);

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          {label}
        </span>
        <span className="truncate font-mono text-[10.5px] text-foreground">
          {value}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={`${label} graph`}
      >
        {/* baseline */}
        <line
          x1={0}
          y1={H - 1}
          x2={W}
          y2={H - 1}
          stroke="currentColor"
          className="text-border/50"
          strokeWidth={1}
        />
        {area ? <path d={area} fill={color} opacity={0.12} /> : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {max ? (
        <div className="flex justify-between text-[9px] text-muted-foreground/60">
          <span>0</span>
          <span>{max}%</span>
        </div>
      ) : (
        <div className="flex justify-end text-[9px] text-muted-foreground/60">
          <span>peak {fmtRate(peak)}</span>
        </div>
      )}
    </div>
  );
}
