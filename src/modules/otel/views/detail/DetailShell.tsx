import { cn } from "@/lib/utils";
import {
  ArrowLeft01Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColDef } from "ag-grid-community";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { fmtDuration } from "../../lib/useOtel";
import type { LatencyBucket, OpStat, SpanStats } from "../../lib/drilldown";
import { OtelGrid } from "./OtelGrid";

/**
 * Full-page detail shell shared by every OTEL detail page (Users / Database /
 * Service Mesh node+edge / per-trace). It owns the back button + title bar +
 * stat strip chrome, so each page just supplies a title, an optional subtitle,
 * the derived stats, and its body sections. Keeping the chrome here means all
 * six detail pages stay visually consistent and a layout tweak lands once.
 */
export function DetailShell({
  title,
  subtitle,
  icon,
  onBack,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          title="Back"
          className="flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/50 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={1.75} />
          Back
        </button>
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-foreground" title={title}>
            {title}
          </h2>
          {subtitle && (
            <div className="truncate font-mono text-[10.5px] text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/** A titled section card used to group detail content. */
export function DetailSection({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          {title}
        </h3>
        {count !== undefined && (
          <span className="rounded bg-muted/60 px-1.5 font-mono text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** The stat strip rendered from the shared SpanStats shape. */
export function StatStrip({ stats }: { stats: SpanStats }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      <StatCell label="spans" value={String(stats.spans)} />
      <StatCell label="traces" value={String(stats.traces)} />
      <StatCell
        label="errors"
        value={`${stats.errors} (${(stats.errorRate * 100).toFixed(0)}%)`}
        danger={stats.errors > 0}
      />
      <StatCell label="avg" value={fmtDuration(stats.avgNano)} />
      <StatCell label="p50" value={fmtDuration(stats.p50Nano)} />
      <StatCell label="p95" value={fmtDuration(stats.p95Nano)} />
      <StatCell label="max" value={fmtDuration(stats.maxNano)} />
    </div>
  );
}

export function StatCell({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <span className={cn("font-mono text-[12.5px] text-foreground/90", danger && "text-red-400")}>
        {value}
      </span>
    </div>
  );
}

/** Log-scale latency histogram as a small bar chart. */
export function LatencyChart({ buckets }: { buckets: LatencyBucket[] }) {
  if (buckets.length === 0) {
    return (
      <p className="text-[11.5px] text-muted-foreground">No latency data.</p>
    );
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex h-28 items-end gap-1">
        {buckets.map((b, i) => (
          <div
            key={i}
            className="group relative flex flex-1 items-end"
            title={`${fmtDuration(b.loNano)} – ${fmtDuration(b.hiNano)}: ${b.count}`}
          >
            <div
              className="w-full rounded-t bg-primary/60 transition-colors group-hover:bg-primary"
              style={{ height: `${(b.count / max) * 100}%`, minHeight: b.count > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>{fmtDuration(buckets[0].loNano)}</span>
        <span>latency distribution</span>
        <span>{fmtDuration(buckets[buckets.length - 1].hiNano)}</span>
      </div>
    </div>
  );
}

/** Top-operations grid (shared shape across Users / service / edge pages). */
export function OpsTable({ ops }: { ops: OpStat[] }) {
  const columnDefs = useMemo<ColDef<OpStat>[]>(
    () => [
      { field: "name", headerName: "Operation", flex: 2, minWidth: 200 },
      { field: "service", headerName: "Service", flex: 1, minWidth: 120 },
      { field: "calls", headerName: "Calls", type: "numericColumn", flex: 0, width: 90 },
      {
        field: "errors",
        headerName: "Err",
        type: "numericColumn",
        flex: 0,
        width: 80,
        cellClassRules: { "text-red-400": (p) => Number(p.value) > 0 },
      },
      {
        field: "avgNano",
        headerName: "Avg",
        type: "numericColumn",
        flex: 0,
        width: 100,
        valueFormatter: (p) => fmtDuration(Number(p.value ?? 0)),
      },
      {
        field: "p95Nano",
        headerName: "p95",
        type: "numericColumn",
        flex: 0,
        width: 100,
        valueFormatter: (p) => fmtDuration(Number(p.value ?? 0)),
      },
    ],
    [],
  );
  if (ops.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground">No operations.</p>;
  }
  return (
    <OtelGrid<OpStat>
      columnDefs={columnDefs}
      rowData={ops}
      height={Math.min(420, 64 + ops.length * 28)}
    />
  );
}

/** Copy-to-clipboard inline button. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (!navigator?.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [text]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy"}
      className="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        size={11}
        strokeWidth={2}
        className={copied ? "text-emerald-400" : undefined}
      />
    </button>
  );
}

/** Monospace key/value row with copy-on-hover, used for attribute lists. */
export function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="group flex gap-2 font-mono text-[10.5px]">
      <span className="w-44 shrink-0 truncate text-muted-foreground/70" title={k}>
        {k}
      </span>
      <span className="flex-1 break-all text-foreground/85">{v}</span>
      <span className="opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={v} />
      </span>
    </div>
  );
}
