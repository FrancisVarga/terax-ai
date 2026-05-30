import { cn } from "@/lib/utils";
import { Database02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import { SegmentedControl } from "./TracesView";
import {
  fmtDuration,
  otel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type DbStatement,
} from "../lib/useOtel";
import { DbDetail } from "./detail/DbDetail";
import { TraceDetail } from "./detail/TraceDetail";
import { OtelGrid } from "./detail/OtelGrid";

type DbNav =
  | { kind: "list" }
  | { kind: "stmt"; row: DbStatement }
  | { kind: "trace"; traceId: string };

/**
 * Database dashboard: aggregates `db.system` spans (e.g. PostgreSQL) by
 * statement, surfacing the slowest/most-expensive queries. Sorted by total time
 * spent so the queries worth optimizing rise to the top - the standard
 * "top SQL by total time" view.
 */
export function DatabaseView({ tick }: { tick: number }) {
  const [windowMs, setWindowMs] = useState(0);
  const [nav, setNav] = useState<DbNav>({ kind: "list" });
  const { data: rows, loading } = useOtelResource<DbStatement[]>(
    () => otel.dbQueries(sinceFromWindow(windowMs)),
    [],
    [tick, windowMs],
  );

  if (nav.kind === "stmt") {
    return (
      <DbDetail
        row={nav.row}
        tick={tick}
        sinceMs={sinceFromWindow(windowMs)}
        onBack={() => setNav({ kind: "list" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
      />
    );
  }
  if (nav.kind === "trace") {
    return (
      <TraceDetail
        traceId={nav.traceId}
        tick={tick}
        onBack={() => setNav({ kind: "list" })}
      />
    );
  }

  if (!loading && rows.length === 0) {
    return (
      <OtelEmpty
        loading={loading}
        what="database queries"
        hint="Spans carrying a db.system attribute (e.g. PostgreSQL client spans) are aggregated here by statement: call counts, latency percentiles, error rate, and total time."
      />
    );
  }

  const totalTime = rows.reduce((n, r) => n + r.totalNano, 0);
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const totalErrors = rows.reduce((n, r) => n + r.errors, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <HugeiconsIcon icon={Database02Icon} size={13} strokeWidth={1.75} />
          <span>
            {rows.length} statements · {totalCalls} calls
            {totalErrors > 0 && <span className="text-red-400"> · {totalErrors} errors</span>} ·{" "}
            {fmtDuration(totalTime)} total
          </span>
        </div>
        <SegmentedControl
          label="Window"
          options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
          value={windowMs}
          onChange={setWindowMs}
        />
      </div>
      <div className="min-h-0 flex-1">
        <DbGrid
          rows={rows}
          totalTime={totalTime}
          onOpen={(row) => setNav({ kind: "stmt", row })}
        />
      </div>
    </div>
  );
}

function DbGrid({
  rows,
  totalTime,
  onOpen,
}: {
  rows: DbStatement[];
  totalTime: number;
  onOpen: (row: DbStatement) => void;
}) {
  const columnDefs = useMemo<ColDef<DbStatement>[]>(
    () => [
      {
        field: "statement",
        headerName: "Statement",
        flex: 3,
        minWidth: 280,
        autoHeight: true,
        cellRenderer: (p: ICellRendererParams<DbStatement>) => {
          const r = p.data;
          if (!r) return null;
          const errRate = r.calls > 0 ? r.errors / r.calls : 0;
          return (
            <div className="flex flex-col py-1 leading-tight">
              <div className="flex items-center gap-2">
                {r.errors > 0 && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-red-400"
                    title={`${r.errors} errors (${(errRate * 100).toFixed(0)}%)`}
                  />
                )}
                <span className="truncate text-foreground/90" title={r.statement}>
                  {r.statement || "(unnamed)"}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-muted-foreground/70">
                <span className="rounded bg-muted/60 px-1">{r.system || "db"}</span>
                <span>{r.service}</span>
              </div>
            </div>
          );
        },
      },
      { field: "calls", headerName: "Calls", type: "numericColumn", flex: 0, width: 90 },
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
      {
        field: "maxNano",
        headerName: "Max",
        type: "numericColumn",
        flex: 0,
        width: 100,
        valueFormatter: (p) => fmtDuration(Number(p.value ?? 0)),
      },
      {
        field: "totalNano",
        headerName: "Total",
        flex: 1,
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams<DbStatement>) => {
          const r = p.data;
          if (!r) return null;
          const pct = totalTime > 0 ? (r.totalNano / totalTime) * 100 : 0;
          const errRate = r.calls > 0 ? r.errors / r.calls : 0;
          return (
            <div className="flex flex-col gap-1 py-1">
              <span className="text-foreground/90">{fmtDuration(r.totalNano)}</span>
              <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
                <div
                  className={cn(
                    "h-full rounded-full",
                    errRate > 0.01 ? "bg-red-400/70" : "bg-primary/60",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        },
      },
    ],
    [totalTime],
  );

  return (
    <OtelGrid<DbStatement>
      columnDefs={columnDefs}
      rowData={rows}
      onRowClick={onOpen}
      fill
    />
  );
}
