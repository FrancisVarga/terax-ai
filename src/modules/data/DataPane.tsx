import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildDataGridTheme } from "./lib/agGridTheme";

/** Wire format returned by the `data_*` Rust commands. */
type DataPreview = {
  columns: string[];
  rows: (string | null)[][];
  total: number | null;
};

type Format = "sqlite" | "csv" | "parquet";

type Props = {
  path: string;
  format: Format;
  visible: boolean;
};

/** Rows fetched per page. The grid virtualizes the DOM, so a few thousand rows
 * stay smooth; paging keeps the IPC payload (and SQLite/Parquet scan) bounded
 * for files with millions of rows. */
const PAGE_SIZE = 1000;

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/**
 * Renders one tabular data file in an AG Grid. SQLite files get a table picker;
 * CSV/Parquet show their single sheet. Paging is offset-based, driven by the
 * footer controls. Each cell is a string (Rust stringifies every value), and a
 * `null` cell is shown as a muted "NULL" so it's distinguishable from "".
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
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [page, setPage] = useState(0);

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

  // Reset to the first page whenever the source (file or selected table)
  // changes, so we never request an offset past a smaller table's end.
  useEffect(() => {
    setPage(0);
  }, [path, activeTable]);

  // Fetch the active page. SQLite waits for a selected table; CSV/Parquet load
  // immediately.
  useEffect(() => {
    if (format === "sqlite" && !activeTable) return;
    let cancelled = false;
    setStatus({ kind: "loading" });
    const offset = page * PAGE_SIZE;
    const common = {
      path,
      limit: PAGE_SIZE,
      offset,
      workspace: currentWorkspaceEnv(),
    };
    const call =
      format === "sqlite"
        ? invoke<DataPreview>("data_sqlite_rows", {
            ...common,
            table: activeTable,
          })
        : format === "csv"
          ? invoke<DataPreview>("data_csv_preview", common)
          : invoke<DataPreview>("data_parquet_preview", common);
    call
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setStatus({ kind: "ready" });
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, format, activeTable, page]);

  // The Rust side returns row-major arrays; AG Grid wants row objects. We key
  // columns by index (`c0`, `c1`, …) so duplicate or empty column names in the
  // source file don't collide.
  const columnDefs = useMemo<ColDef[]>(() => {
    if (!preview) return [];
    return preview.columns.map((name, i) => ({
      headerName: name,
      field: `c${i}`,
      // Show NULL distinctly from an empty string.
      valueFormatter: (p) => (p.value === null ? "NULL" : p.value),
      cellClass: (p) =>
        p.value === null ? "italic text-muted-foreground/60" : "",
    }));
  }, [preview]);

  const rowData = useMemo(() => {
    if (!preview) return [];
    return preview.rows.map((row) => {
      const obj: Record<string, string | null> = {};
      row.forEach((cell, i) => {
        obj[`c${i}`] = cell;
      });
      return obj;
    });
  }, [preview]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      filter: true,
      floatingFilter: false,
      resizable: true,
      minWidth: 80,
      flex: 1,
    }),
    [],
  );

  const total = preview?.total ?? null;
  const pageCount =
    total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const offset = page * PAGE_SIZE;
  const showingFrom = preview && preview.rows.length > 0 ? offset + 1 : 0;
  const showingTo = offset + (preview?.rows.length ?? 0);

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
      {/* Toolbar: SQLite table picker + status. */}
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
        <div className="ml-auto text-muted-foreground">
          {status.kind === "loading" && "Loading…"}
          {status.kind === "ready" && total !== null && (
            <span>
              {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of{" "}
              {total.toLocaleString()} rows
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
              rowData={rowData}
              defaultColDef={defaultColDef}
              // DOM virtualization is on by default (rowBuffer 10); these keep
              // big-page scrolling smooth.
              suppressColumnVirtualisation={false}
              animateRows={false}
              suppressCellFocus={false}
              enableCellTextSelection
              ensureDomOrder
            />
          </div>
        )}
      </div>

      {/* Pager. */}
      {pageCount !== null && pageCount > 1 && status.kind !== "error" ? (
        <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-t border-border/60 px-3 text-[12px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-sm border border-border/60 bg-card px-2 py-0.5 disabled:opacity-40 hover:bg-accent/50"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            className="rounded-sm border border-border/60 bg-card px-2 py-0.5 disabled:opacity-40 hover:bg-accent/50"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
