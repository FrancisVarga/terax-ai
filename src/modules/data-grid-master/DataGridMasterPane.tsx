import { cn } from "@/lib/utils";
import { buildDataGridTheme } from "@/modules/data/lib/agGridTheme";
import { useTheme } from "@/modules/theme";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IRowNode,
  IsFullWidthRowParams,
  RowHeightParams,
} from "ag-grid-community";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildColumnDefs, buildFileColumnDefs } from "./lib/columns";
import {
  makeFileDatasource,
  makeSyntheticDatasource,
  type FileFormat,
} from "./lib/datasource";
import type { GridRow } from "./lib/types";
import { useGridState } from "./lib/useGridState";

const BLOCK_SIZE = 200;

type Source =
  | { kind: "synthetic" }
  | { kind: "file"; path: string; format: FileFormat; name: string };

const FILE_FILTERS = [
  { name: "Data", extensions: ["csv", "parquet", "pq", "sqlite", "sqlite3", "db"] },
];

function formatForExt(path: string): FileFormat | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "parquet" || ext === "pq") return "parquet";
  if (ext === "sqlite" || ext === "sqlite3" || ext === "db") return "sqlite";
  return null;
}

/**
 * The data-grid-master showcase. One AG Grid wired to a background-loaded
 * source (synthetic generator Worker by default, or a real workspace file via
 * the `data_*` Rust commands) using the Infinite Row Model. The control bar
 * toggles Community features live; the footer is a custom status bar driven by
 * grid events (Community has no StatusBar module).
 *
 * Kept thin: generation, the datasource, and column defs are pure functions in
 * `lib/`. This component owns lifecycle (worker, grid api) and view state only.
 */
export function DataGridMasterPane({ visible }: { visible: boolean }) {
  const { resolvedMode } = useTheme();
  const theme = useMemo(() => buildDataGridTheme(resolvedMode), [resolvedMode]);

  const { features, toggle, counters, setCount } = useGridState();
  const [source, setSource] = useState<Source>({ kind: "synthetic" });
  const [quickFilter, setQuickFilter] = useState("");
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const gridApiRef = useRef<GridApi<GridRow> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  // Feature flags the datasource/filter closures read without rebuilding.
  const highPerfRef = useRef(features.highPerformersOnly);
  highPerfRef.current = features.highPerformersOnly;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // The generator worker is created lazily and lives for the pane's lifetime.
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("./lib/generate.worker.ts", import.meta.url),
        { type: "module" },
      );
    }
    return workerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Column defs depend on the source: fixed showcase schema for synthetic,
  // dynamic string columns for a real file.
  const columnDefs = useMemo<(ColDef<GridRow> | object)[]>(() => {
    if (source.kind === "file") return buildFileColumnDefs(fileColumns);
    return buildColumnDefs();
  }, [source, fileColumns]);

  const defaultColDef = useMemo<ColDef<GridRow>>(
    () => ({
      sortable: true,
      resizable: true,
      floatingFilter: features.floatingFilters,
      minWidth: 90,
    }),
    [features.floatingFilters],
  );

  // Build the datasource for the active source and push it to the grid. A
  // source switch rebuilds it so the grid drops cached blocks and refetches.
  const applyDatasource = useCallback(
    (api: GridApi<GridRow>) => {
      if (source.kind === "synthetic") {
        api.setGridOption(
          "datasource",
          makeSyntheticDatasource(getWorker()),
        );
      } else {
        api.setGridOption(
          "datasource",
          makeFileDatasource({
            path: source.path,
            format: source.format,
            table: null,
            onColumns: (cols, total) => {
              setFileColumns(cols);
              setCount({ total });
            },
          }),
        );
      }
    },
    [source, getWorker, setCount],
  );

  useEffect(() => {
    const api = gridApiRef.current;
    if (api) applyDatasource(api);
  }, [applyDatasource]);

  // Quick filter spans all columns server-of-cache side via the grid's own
  // quick-filter (works on loaded blocks in the infinite model).
  useEffect(() => {
    gridApiRef.current?.setGridOption("quickFilterText", quickFilter);
  }, [quickFilter]);

  // External filter (high performers only) — re-evaluated when toggled.
  useEffect(() => {
    gridApiRef.current?.onFilterChanged();
  }, [features.highPerformersOnly]);

  const onGridReady = useCallback(
    (e: GridReadyEvent<GridRow>) => {
      gridApiRef.current = e.api;
      applyDatasource(e.api);
    },
    [applyDatasource],
  );

  const refreshCounters = useCallback(() => {
    const api = gridApiRef.current;
    if (!api) return;
    setCount({
      displayed: api.getDisplayedRowCount(),
      selected: api.getSelectedRows().length,
    });
  }, [setCount]);

  // Full-width detail row (Community master-detail equivalent): an expanded row
  // gets a second full-width row beneath it. We model this by toggling a flag in
  // `expanded` and asking the grid to treat the *next* synthetic node as full
  // width is not possible in the infinite model, so instead we render the detail
  // inline via row height + a full-width renderer keyed on expansion.
  const isFullWidthRow = useCallback(
    (params: IsFullWidthRowParams<GridRow>) => {
      const id = params.rowNode.data?.id;
      return id != null && expandedRef.current.has(id);
    },
    [],
  );

  const getRowHeight = useCallback(
    (params: RowHeightParams<GridRow>): number | undefined | null => {
      const id = params.data?.id;
      if (id != null && expandedRef.current.has(id)) return 120;
      return undefined;
    },
    [],
  );

  const fullWidthCellRenderer = useCallback(
    (params: { data?: GridRow }) => {
      const d = params.data;
      if (!d) return null;
      return (
        <div className="flex h-full flex-col gap-1 overflow-auto bg-accent/40 px-4 py-2 text-[12px]">
          <div className="font-semibold text-foreground">
            {d.firstName} {d.lastName} — detail
          </div>
          <div className="text-muted-foreground">{d.notes}</div>
          <div className="text-muted-foreground">
            {d.department} · {d.status} · hired {d.hireDate}
          </div>
        </div>
      );
    },
    [],
  );

  const toggleExpand = useCallback(
    (node: IRowNode<GridRow>) => {
      const id = node.data?.id;
      if (id == null) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Re-measure + re-render the affected row.
      requestAnimationFrame(() => {
        gridApiRef.current?.resetRowHeights();
        gridApiRef.current?.redrawRows({ rowNodes: [node] });
      });
    },
    [],
  );

  const onExportCsv = useCallback(() => {
    gridApiRef.current?.exportDataAsCsv({ fileName: "data-grid-master.csv" });
  }, []);

  const onCaptureState = useCallback(() => {
    const state = gridApiRef.current?.getState();
    // Surfaced to the console for the showcase; capturing grid state is the
    // documented Community way to persist/restore sort, filter, columns.
    console.info("[data-grid-master] grid state", state);
  }, []);

  const onPickFile = useCallback(async () => {
    const picked = await open({ multiple: false, filters: FILE_FILTERS });
    if (typeof picked !== "string") return;
    const fmt = formatForExt(picked);
    if (!fmt) return;
    const name = picked.split(/[\\/]/).pop() ?? picked;
    setFileColumns([]);
    setExpanded(new Set());
    setSource({ kind: "file", path: picked, format: fmt, name });
  }, []);

  const onUseSynthetic = useCallback(() => {
    setExpanded(new Set());
    setCount({ total: null });
    setSource({ kind: "synthetic" });
  }, [setCount]);

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      {/* Source + feature control bar. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px]">
        <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5">
          <button
            onClick={onUseSynthetic}
            className={cn(
              "rounded px-2 py-1 text-[11px]",
              source.kind === "synthetic"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Synthetic (200k)
          </button>
          <button
            onClick={onPickFile}
            className={cn(
              "rounded px-2 py-1 text-[11px]",
              source.kind === "file"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {source.kind === "file" ? source.name : "Open file…"}
          </button>
        </div>

        <input
          type="search"
          value={quickFilter}
          onChange={(e) => setQuickFilter(e.target.value)}
          placeholder="Quick filter…"
          className="h-7 w-48 rounded-sm border border-border/60 bg-card px-2 text-[12px] outline-none focus:border-ring placeholder:text-muted-foreground/60"
        />

        <FeatureToggle
          label="Pagination"
          on={features.pagination}
          onClick={() => toggle("pagination")}
        />
        <FeatureToggle
          label="Floating filters"
          on={features.floatingFilters}
          onClick={() => toggle("floatingFilters")}
        />
        <FeatureToggle
          label="Full-row edit"
          on={features.fullRowEdit}
          onClick={() => toggle("fullRowEdit")}
        />
        <FeatureToggle
          label="High performers"
          on={features.highPerformersOnly}
          onClick={() => toggle("highPerformersOnly")}
        />
        <FeatureToggle
          label="Animate"
          on={features.animateRows}
          onClick={() => toggle("animateRows")}
        />

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onCaptureState}
            className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            title="Log captured grid state to the console"
          >
            Capture state
          </button>
          <button
            onClick={onExportCsv}
            className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Grid. */}
      <div className="relative min-h-0 flex-1">
        <AgGridReact<GridRow>
          theme={theme}
          columnDefs={columnDefs as ColDef<GridRow>[]}
          defaultColDef={defaultColDef}
          rowModelType="infinite"
          cacheBlockSize={BLOCK_SIZE}
          maxBlocksInCache={10}
          infiniteInitialRowCount={BLOCK_SIZE}
          rowNumbers={false}
          rowSelection={{ mode: "multiRow" }}
          rowDragManaged={source.kind === "synthetic"}
          editType={features.fullRowEdit ? "fullRow" : undefined}
          pagination={features.pagination}
          paginationPageSize={100}
          paginationPageSizeSelector={[50, 100, 200]}
          animateRows={features.animateRows}
          undoRedoCellEditing
          undoRedoCellEditingLimit={20}
          enableCellTextSelection
          tooltipShowDelay={300}
          isFullWidthRow={isFullWidthRow}
          fullWidthCellRenderer={fullWidthCellRenderer}
          embedFullWidthRows
          getRowHeight={getRowHeight}
          isExternalFilterPresent={() => highPerfRef.current}
          doesExternalFilterPass={(node) =>
            !highPerfRef.current || (node.data?.performance ?? 0) >= 50
          }
          onCellClicked={(e) => {
            // Click the index/drag column to expand the detail row.
            if (e.column.getColId() === "rowIndex" && e.node)
              toggleExpand(e.node);
          }}
          onGridReady={onGridReady}
          onModelUpdated={refreshCounters}
          onSelectionChanged={refreshCounters}
          onFilterChanged={refreshCounters}
        />
      </div>

      {/* Custom status footer (Community has no StatusBar module). */}
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-border/60 px-3 text-[11px] text-muted-foreground">
        <span>
          {counters.total != null
            ? `${counters.total.toLocaleString()} rows`
            : "streaming…"}
        </span>
        <span>{counters.displayed.toLocaleString()} loaded</span>
        <span>{counters.selected.toLocaleString()} selected</span>
        <span className="ml-auto text-muted-foreground/70">
          Click the # column to expand a detail row · Community features only
        </span>
      </div>
    </div>
  );
}

function FeatureToggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded border px-2 py-1 text-[11px]",
        on
          ? "border-ring/60 bg-accent text-foreground"
          : "border-border/60 text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}
