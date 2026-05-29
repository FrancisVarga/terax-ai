import { cn } from "@/lib/utils";
import { Bug01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo } from "react";
import { fmtAgo, fmtDuration } from "../../lib/useOtel";
import type { TraceFromSpans } from "../../lib/drilldown";
import { OtelGrid } from "./OtelGrid";

/**
 * Recent-traces grid shared by the Users / service / edge detail pages. Backed
 * by the generic `OtelGrid` (AG Grid) so it gains sort/filter/resize; each row
 * is clickable to open the full trace detail.
 */
export function TracesTable({
  traces,
  onOpenTrace,
}: {
  traces: TraceFromSpans[];
  onOpenTrace: (traceId: string) => void;
}) {
  const columnDefs = useMemo<ColDef<TraceFromSpans>[]>(
    () => [
      {
        field: "rootName",
        headerName: "Root span",
        flex: 2,
        minWidth: 200,
        cellRenderer: (p: ICellRendererParams<TraceFromSpans>) => {
          const t = p.data;
          if (!t) return null;
          return (
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={t.hasError ? Bug01Icon : CheckmarkCircle02Icon}
                size={12}
                strokeWidth={1.75}
                className={cn("shrink-0", t.hasError ? "text-red-400" : "text-emerald-400/80")}
              />
              <span className="truncate">{t.rootName}</span>
            </span>
          );
        },
      },
      { field: "service", headerName: "Service", flex: 1, minWidth: 120 },
      {
        field: "spanCount",
        headerName: "Spans",
        type: "numericColumn",
        flex: 0,
        width: 90,
      },
      {
        field: "durationNano",
        headerName: "Duration",
        type: "numericColumn",
        flex: 0,
        width: 110,
        valueFormatter: (p) => fmtDuration(Number(p.value ?? 0)),
      },
      {
        field: "lastMs",
        headerName: "Seen",
        type: "numericColumn",
        flex: 0,
        width: 100,
        valueFormatter: (p) => fmtAgo(Number(p.value ?? 0)),
      },
    ],
    [],
  );

  if (traces.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground">No traces.</p>;
  }

  return (
    <OtelGrid<TraceFromSpans>
      columnDefs={columnDefs}
      rowData={traces}
      onRowClick={(t) => onOpenTrace(t.traceId)}
      height={Math.min(420, 64 + traces.length * 28)}
    />
  );
}
