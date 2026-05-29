import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IDatasource,
  IGetRowsParams,
} from "ag-grid-community";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDataGridTheme } from "./lib/agGridTheme";
import {
  SqlQueryBar,
  type ExportFormat,
  type SqlQueryBarHandle,
} from "./SqlQueryBar";

/** Wire format returned by the `data_*` Rust commands. */
type DataPreview = {
  columns: string[];
  rows: (string | null)[][];
  total: number | null;
};

/** Sort spec forwarded to Rust — column *index* + direction. */
type SortSpec = { col: number; desc: boolean };

type Format = "sqlite" | "csv" | "parquet";

type Props = {
  path: string;
  format: Format;
  visible: boolean;
};

/** Rows fetched per infinite-scroll block. The grid requests the next block as
 * the user nears the bottom; Rust pages the underlying file by LIMIT/OFFSET so
 * the IPC payload (and SQLite/Parquet scan) stays bounded for million-row files. */
const BLOCK_SIZE = 200;

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/**
 * Renders one tabular data file in an AG Grid using the **Infinite Row Model**:
 * the grid pulls blocks on demand as the user scrolls, and forwards the active
 * search term + sort to the `data_*` Rust commands so filtering/sorting span the
 * *entire* file, not just loaded rows. SQLite files get a table picker. Each
 * cell is a string (Rust stringifies every value); a `null` cell renders as a
 * muted "NULL" so it's distinguishable from "".
 */
export function DataPane({ path, format, visible }: Props) {
  const { resolvedMode } = useTheme();
  const theme = useMemo(
    () => buildDataGridTheme(resolvedMode),
    [resolvedMode],
  );

  const [tables, setTables] = useState<string[] | null>(null);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);

  // SQL query mode. `query` holds the SQL the grid is currently paging through;
  // `null` means plain browse mode (table/file paging). Switching to query mode
  // rebuilds the datasource so the grid pages via `data_query` instead.
  const [query, setQuery] = useState<string | null>(null);
  const sqlBarRef = useRef<SqlQueryBarHandle>(null);
  const queryRef = useRef<string | null>(null);
  queryRef.current = query;

  // Search box: `searchInput` is what the user types; `search` is the debounced
  // value actually sent to Rust (so we don't re-scan the file on every keypress).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const gridApiRef = useRef<GridApi | null>(null);
  // Latest search/columns visible to the datasource closure without rebuilding
  // it. The datasource reads these refs each `getRows` call.
  const searchRef = useRef("");
  const columnsRef = useRef<string[]>([]);
  searchRef.current = search;
  columnsRef.current = columns;

  // Debounce the search input → `search` (250ms).
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Discover SQLite tables once. CSV/Parquet have no picker step.
  useEffect(() => {
    if (format !== "sqlite") {
      setTables(null);
      return;
    }
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<string[]>("data_sqlite_tables", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((names) => {
        if (cancelled) return;
        setTables(names);
        setActiveTable(names[0] ?? null);
        if (names.length === 0) {
          setStatus({ kind: "error", message: "No tables in this database." });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, format]);

  // One IPC fetch for a block. Translates the grid's row window + sort into the
  // shared `data_*` command arguments. `activeTable` is read fresh via closure
  // (the datasource is rebuilt when it changes). When a SQL query is active it
  // pages that result via `data_query` instead — search/sort don't apply (the
  // user expresses those in SQL), so they're omitted.
  const fetchBlock = useCallback(
    (
      startRow: number,
      sort: SortSpec | undefined,
      table: string | null,
      sql: string | null,
    ): Promise<DataPreview> => {
      if (sql) {
        return invoke<DataPreview>("data_query", {
          path,
          format,
          sql,
          limit: BLOCK_SIZE,
          offset: startRow,
          workspace: currentWorkspaceEnv(),
        });
      }
      const common = {
        path,
        limit: BLOCK_SIZE,
        offset: startRow,
        search: searchRef.current || null,
        sort: sort ?? null,
        workspace: currentWorkspaceEnv(),
      };
      if (format === "sqlite") {
        return invoke<DataPreview>("data_sqlite_rows", { ...common, table });
      }
      if (format === "csv") {
        return invoke<DataPreview>("data_csv_preview", common);
      }
      return invoke<DataPreview>("data_parquet_preview", common);
    },
    [path, format],
  );

  // Build the datasource for the current source (file + selected table). Rebuilt
  // when the table changes so the grid drops stale blocks. Search changes are
  // handled by purging the existing datasource (see effect below) rather than
  // rebuilding, which keeps the column set stable.
  const datasource = useMemo<IDatasource>(() => {
    return {
      rowCount: undefined,
      getRows: (params: IGetRowsParams) => {
        // The grid sends at most one sort column for the infinite model. colId
        // is `c<index>`, so slice(1) recovers the column index Rust expects.
        // In query mode sort is expressed in SQL, so the grid's header sort is
        // ignored (columns are non-sortable then — see `columnDefs`).
        const sm = params.sortModel[0];
        const sortSpec: SortSpec | undefined =
          sm && !query
            ? {
                col: Number(String(sm.colId).slice(1)),
                desc: sm.sort === "desc",
              }
            : undefined;

        setStatus({ kind: "loading" });
        fetchBlock(params.startRow, sortSpec, activeTable, query)
          .then((res) => {
            // First block also establishes columns + total for the toolbar.
            if (params.startRow === 0) {
              setColumns(res.columns);
              setTotal(res.total);
            }
            const rows = res.rows.map((row) => {
              const obj: Record<string, string | null> = {};
              row.forEach((cell, i) => {
                obj[`c${i}`] = cell;
              });
              return obj;
            });
            // lastRow tells the grid the definitive total so it stops paging.
            const lastRow =
              res.total !== null
                ? res.total
                : res.rows.length < BLOCK_SIZE
                  ? params.startRow + res.rows.length
                  : -1;
            params.successCallback(rows, lastRow);
            setStatus({ kind: "ready" });
          })
          .catch((e) => {
            params.failCallback();
            setStatus({ kind: "error", message: String(e) });
          });
      },
    };
    // activeTable + query in deps so a table switch or a run/clear yields a
    // fresh datasource (the grid drops cached blocks and refetches from row 0).
  }, [fetchBlock, activeTable, query]);

  // Push a new datasource whenever it changes (table switch) so the grid resets.
  useEffect(() => {
    gridApiRef.current?.setGridOption("datasource", datasource);
  }, [datasource]);

  // A search change keeps the same datasource (and columns) but invalidates all
  // cached blocks so they refetch with the new term, and snaps back to the top.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    api.refreshInfiniteCache();
    api.ensureIndexVisible(0, "top");
  }, [search]);

  const columnDefs = useMemo<ColDef[]>(() => {
    return columns.map((name, i) => ({
      headerName: name,
      field: `c${i}`,
      // colId is stable + index-encoded so sortModel maps back to a column index.
      colId: `c${i}`,
      valueFormatter: (p) => (p.value === null ? "NULL" : p.value),
      cellClass: (p) =>
        p.value === null ? "italic text-muted-foreground/60" : "",
    }));
  }, [columns]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      // Server-side sort in browse mode (grid emits sortModel → Rust). In query
      // mode the user sorts via SQL `ORDER BY`, so header sort is turned off to
      // avoid implying a client-side reorder of the partial cache.
      sortable: query === null,
      // Per-column client filters are disabled — search spans the whole file
      // server-side instead, which client filters on a partial cache can't do.
      filter: false,
      resizable: true,
      minWidth: 80,
      flex: 1,
    }),
    [query],
  );

  // A reasonable starting query for the current source. SQLite selects from the
  // active table; CSV/Parquet select from the synthetic `data` view DuckDB
  // mounts the file as. Also used as the export query when in browse mode.
  const defaultQuery = useMemo(() => {
    if (format === "sqlite") {
      const t = activeTable ?? "table";
      // Quote the identifier (double embedded quotes) so spaces/keywords work.
      return `SELECT * FROM "${t.replace(/"/g, '""')}"`;
    }
    return "SELECT * FROM data";
  }, [format, activeTable]);

  const runQuery = useCallback((sql: string) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setQuery(trimmed);
  }, []);

  const clearQuery = useCallback(() => {
    setQuery(null);
  }, []);

  // Export the *effective* result: the active query in query mode, else a
  // `SELECT *` over the current table/file. Opens a native Save dialog, then
  // streams the full result to the chosen path via `data_export`.
  const handleExport = useCallback(
    async (out: ExportFormat) => {
      const sql = query ?? defaultQuery;
      const base =
        path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, "") || "export";
      const dest = await save({
        defaultPath: `${base}.${out}`,
        filters: [{ name: out.toUpperCase(), extensions: [out] }],
      });
      if (!dest) return; // user cancelled
      setStatus({ kind: "loading" });
      try {
        await invoke<number>("data_export", {
          path,
          format,
          sql,
          destPath: dest,
          outFormat: out,
          workspace: currentWorkspaceEnv(),
        });
        setStatus({ kind: "ready" });
      } catch (e) {
        setStatus({ kind: "error", message: String(e) });
      }
    },
    [query, defaultQuery, path, format],
  );

  const onGridReady = useCallback(
    (e: GridReadyEvent) => {
      gridApiRef.current = e.api;
      e.api.setGridOption("datasource", datasource);
    },
    [datasource],
  );

  const onTableChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setActiveTable(e.target.value);
    },
    [],
  );

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      {/* SQL query editor — runs arbitrary SELECTs against this file. Remounted
          per source (path+table) so its seeded query tracks the active table. */}
      <SqlQueryBar
        key={`${path}:${activeTable ?? ""}`}
        ref={sqlBarRef}
        initialSql={defaultQuery}
        onRun={runQuery}
        onClear={clearQuery}
        onExport={handleExport}
        busy={status.kind === "loading"}
        hasResult={query !== null}
      />

      {/* Toolbar: SQLite table picker + search + status. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[12px]">
        {format === "sqlite" && tables && tables.length > 0 ? (
          <>
            <span className="text-muted-foreground">Table</span>
            <select
              value={activeTable ?? ""}
              onChange={onTableChange}
              className="h-6 rounded-sm border border-border/60 bg-card px-1.5 text-[12px] outline-none focus:border-ring"
            >
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="font-medium text-foreground/80 uppercase tracking-wide text-[10.5px]">
            {format}
          </span>
        )}

        {/* Browse-mode search is meaningless once a query drives the grid —
            sorting/filtering lives in SQL then, so the box is hidden. */}
        {query === null && (
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search all rows…"
            className="h-6 w-48 rounded-sm border border-border/60 bg-card px-2 text-[12px] outline-none focus:border-ring placeholder:text-muted-foreground/60"
          />
        )}
        {query !== null && (
          <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-foreground/80">
            query
          </span>
        )}

        <div className="ml-auto text-muted-foreground">
          {status.kind === "loading" && "Loading…"}
          {status.kind === "ready" && total !== null && (
            <span>
              {total.toLocaleString()} {total === 1 ? "row" : "rows"}
              {query !== null ? " (query)" : search && " (filtered)"}
            </span>
          )}
        </div>
      </div>

      {/* Grid / error. */}
      <div className="relative min-h-0 flex-1">
        {status.kind === "error" ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-[12px] text-destructive">{status.message}</p>
          </div>
        ) : (
          <div className="h-full w-full">
            <AgGridReact
              theme={theme}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              // Infinite Row Model: blocks fetched on demand via the datasource.
              rowModelType="infinite"
              cacheBlockSize={BLOCK_SIZE}
              // Keep a bounded number of blocks so memory stays flat on huge files.
              maxBlocksInCache={10}
              infiniteInitialRowCount={BLOCK_SIZE}
              onGridReady={onGridReady}
              animateRows={false}
              suppressCellFocus={false}
              enableCellTextSelection
              ensureDomOrder
            />
          </div>
        )}
      </div>
    </div>
  );
}
