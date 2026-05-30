import { buildDataGridTheme } from "@/modules/data/lib/agGridTheme";
import { useTheme } from "@/modules/theme";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IDatasource,
  RowClickedEvent,
} from "ag-grid-community";
import { useEffect, useMemo, useRef } from "react";

/**
 * Generic AG Grid wrapper for the observability views — the one place that
 * touches `AgGridReact` so every otel table shares sort/filter/resize, the
 * app-matched theme (`buildDataGridTheme`), and a consistent look. AG Grid's
 * community modules are registered globally in `main.tsx`, so this just needs
 * column defs + data.
 *
 * Two data modes:
 *  - `rowData`: client-side model for the small derived aggregate tables
 *    (ops, traces, severity, metric series). All rows in memory, instant
 *    sort/filter.
 *  - `datasource`: infinite row model for large/unbounded results (the Query
 *    page), where blocks are fetched lazily on scroll via an async datasource
 *    (IPC to the Rust backend) so the UI never holds the whole result set.
 *
 * Exactly one of `rowData` / `datasource` should be supplied.
 */
export type OtelGridProps<T> = {
  columnDefs: ColDef<T>[];
  /** Client-side rows. Omit when using `datasource`. */
  rowData?: T[];
  /** Infinite-model datasource. Omit when using `rowData`. */
  datasource?: IDatasource;
  /** Row click handler (e.g. open a detail page). */
  onRowClick?: (row: T) => void;
  /** Pixel height of the grid viewport. Default 360. Ignored when `fill`. */
  height?: number;
  /** Fill the parent container's height (for full-pane grids). */
  fill?: boolean;
  /** Block size for the infinite model. Default 100. */
  cacheBlockSize?: number;
  /** Optional default col def overrides merged over the shared defaults. */
  defaultColDef?: ColDef<T>;
};

export function OtelGrid<T>({
  columnDefs,
  rowData,
  datasource,
  onRowClick,
  height = 360,
  fill = false,
  cacheBlockSize = 100,
  defaultColDef,
}: OtelGridProps<T>) {
  const { resolvedMode } = useTheme();
  const theme = useMemo(() => buildDataGridTheme(resolvedMode), [resolvedMode]);
  const apiRef = useRef<GridApi<T> | null>(null);

  const mergedDefaultColDef = useMemo<ColDef<T>>(
    () => ({
      sortable: true,
      resizable: true,
      minWidth: 80,
      flex: 1,
      ...defaultColDef,
    }),
    [defaultColDef],
  );

  const infinite = datasource != null;

  // Push a new datasource into a live grid when it changes (infinite mode).
  useEffect(() => {
    const api = apiRef.current;
    if (api && datasource) api.setGridOption("datasource", datasource);
  }, [datasource]);

  const onGridReady = (e: GridReadyEvent<T>) => {
    apiRef.current = e.api;
    if (datasource) e.api.setGridOption("datasource", datasource);
  };

  const onRowClicked = (e: RowClickedEvent<T>) => {
    if (onRowClick && e.data) onRowClick(e.data);
  };

  return (
    <div style={fill ? { height: "100%" } : { height }} className="h-full w-full">
      <AgGridReact<T>
        theme={theme}
        columnDefs={columnDefs}
        defaultColDef={mergedDefaultColDef}
        rowData={infinite ? undefined : (rowData ?? [])}
        rowModelType={infinite ? "infinite" : "clientSide"}
        cacheBlockSize={infinite ? cacheBlockSize : undefined}
        maxBlocksInCache={infinite ? 10 : undefined}
        infiniteInitialRowCount={infinite ? cacheBlockSize : undefined}
        rowSelection={undefined}
        enableCellTextSelection
        suppressCellFocus={!onRowClick}
        rowStyle={onRowClick ? { cursor: "pointer" } : undefined}
        onRowClicked={onRowClicked}
        onGridReady={onGridReady}
      />
    </div>
  );
}
