import { cn } from "@/lib/utils";
import { Database02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fmtDuration, type DbStatement, type SpanRow } from "../../lib/useOtel";
import { useDrilldown } from "../../lib/useDrilldown";
import { attrMatch } from "../../lib/drilldown";
import {
  CopyButton,
  DetailSection,
  DetailShell,
  LatencyChart,
  StatStrip,
} from "./DetailShell";
import { CapNote } from "./ServiceDetail";
import { TracesTable } from "./TracesTable";

/**
 * Database statement detail: deep view of one aggregated SQL/NoSQL statement —
 * the full text, system/service, the precomputed aggregate row from the
 * backend, plus a live drill-down (latency distribution, error samples, and the
 * traces that ran it). Drilling matches `db.system`, then keeps only spans whose
 * own `db.statement` equals this row — robust against statement text that would
 * break an exact JSON substring match.
 */
export function DbDetail({
  row,
  tick,
  sinceMs,
  onBack,
  onOpenTrace,
}: {
  row: DbStatement;
  tick: number;
  sinceMs?: number;
  onBack: () => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const dd = useDrilldown(
    {
      attrSearch: row.system ? attrMatch("db.system", row.system) : undefined,
      sinceMs,
      maxTraces: 80,
      spanFilter: (s) => stmtOf(s) === row.statement,
    },
    [row.statement, row.system, tick, sinceMs],
  );

  return (
    <DetailShell
      title={row.statement || "(unnamed statement)"}
      subtitle={`${row.system || "db"} · ${row.service}`}
      icon={
        <HugeiconsIcon icon={Database02Icon} size={16} strokeWidth={1.75} className="text-primary" />
      }
      onBack={onBack}
    >
      {/* Full statement text */}
      <DetailSection title="Statement">
        <div className="relative rounded-lg border border-border/50 bg-background/40 p-3">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
            {row.statement || "(empty)"}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={row.statement} />
          </div>
        </div>
      </DetailSection>

      {/* Backend aggregate (authoritative full-window numbers) */}
      <DetailSection title="Aggregate (full window)">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Agg label="calls" value={String(row.calls)} />
          <Agg label="errors" value={String(row.errors)} danger={row.errors > 0} />
          <Agg label="avg" value={fmtDuration(row.avgNano)} />
          <Agg label="p95" value={fmtDuration(row.p95Nano)} />
          <Agg label="max" value={fmtDuration(row.maxNano)} />
          <Agg label="total" value={fmtDuration(row.totalNano)} />
        </div>
      </DetailSection>

      {/* Live drill-down sample */}
      {dd.capped && <CapNote />}
      {dd.spans.length > 0 && (
        <>
          <DetailSection title="Recent sample">
            <StatStrip stats={dd.stats} />
          </DetailSection>
          <LatencyChart buckets={dd.histogram} />
        </>
      )}

      {dd.errors.length > 0 && (
        <DetailSection title="Errors" count={dd.errors.length}>
          <div className="flex flex-col gap-1">
            {dd.errors.map((e) => (
              <button
                key={e.message}
                type="button"
                onClick={() => onOpenTrace(e.sampleTraceId)}
                className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2.5 py-1.5 text-left transition-colors hover:bg-destructive/10"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-destructive" title={e.message}>
                  {e.message}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-destructive/80">{e.count}×</span>
              </button>
            ))}
          </div>
        </DetailSection>
      )}

      <DetailSection title="Traces running this" count={dd.traces.length}>
        <TracesTable traces={dd.traces} onOpenTrace={onOpenTrace} />
      </DetailSection>
    </DetailShell>
  );
}

function Agg({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <span className={cn("font-mono text-[12.5px] text-foreground/90", danger && "text-red-400")}>
        {value}
      </span>
    </div>
  );
}

/** A span's statement text, across the current + legacy attribute names. */
function stmtOf(s: SpanRow): string {
  const a = s.attributes ?? {};
  const v = a["db.statement"] ?? a["db.query.text"];
  return v == null ? "" : String(v);
}
