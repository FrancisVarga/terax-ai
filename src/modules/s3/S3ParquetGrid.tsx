import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  IDatasource,
  IGetRowsParams,
} from "ag-grid-community";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildDataGridTheme,
  ensureAgGridRegistered,
} from "@/modules/data/lib/agGridTheme";

ensureAgGridRegistered();
import { useTheme } from "@/modules/theme";
import { cn } from "@/lib/utils";

/** Wire format returned by `s3_parquet_preview` (same shape as `DataPreview`). */
type DataPreview = {
  columns: string[];
  rows: (string | null)[][];
  total: number | null;
};

type Props = {
  connId: string;
  bucket: string;
  objectKey: string;
  visible: boolean;
};

/**
 * Rows fetched per infinite-scroll block. The grid requests the next block as
 * the user nears the bottom; `s3_parquet_preview` pages the remote parquet by
 * LIMIT/OFFSET so the IPC payload stays bounded for large files. Mirrors
 * `DataPane`'s BLOCK_SIZE.
 */
const BLOCK_SIZE = 200;

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/**
 * Streams a remote parquet object straight from S3 into an AG Grid using the
 * **Infinite Row Model**, paging via `s3_parquet_preview` rather than
 * downloading the whole file first. This is the preferred parquet viewer; the
 * generic `DataPane`-on-cache path is the fallback. `search`/`sort` are sent
 * for forward-compat but the backend currently ignores them, so we omit the
 * search box and column sorting to avoid implying behavior that isn't wired.
 */
export function S3ParquetGrid({ connId, bucket, objectKey, visible }: Props) {
  const { resolvedMode } = useTheme();
  const theme = useMemo(() => buildDataGridTheme(resolvedMode), [resolvedMode]);

  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);

  const gridApiRef = useRef<GridApi | null>(null);

  // One IPC fetch for a block. `search`/`sort` are accepted-but-ignored
  // server-side; we pass null to keep the contract explicit.
  const fetchBlock = useCallback(
    (startRow: number): Promise<DataPreview> => {
      return invoke<DataPreview>("s3_parquet_preview", {
        id: connId,
        bucket,
        key: objectKey,
        limit: BLOCK_SIZE,
        offset: startRow,
        search: null,
        sort: null,
      });
    },
    [connId, bucket, objectKey],
  );

  // Rebuilt when the source object changes so the grid drops stale blocks.
  const datasource = useMemo<IDatasource>(() => {
    return {
      rowCount: undefined,
      getRows: (params: IGetRowsParams) => {
        setStatus({ kind: "loading" });
        fetchBlock(params.startRow)
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
  }, [fetchBlock]);

  const columnDefs = useMemo<ColDef[]>(() => {
    return columns.map((name, i) => ({
      headerName: name,
      field: `c${i}`,
      colId: `c${i}`,
      valueFormatter: (p) => (p.value === null ? "NULL" : p.value),
      cellClass: (p) =>
        p.value === null ? "italic text-muted-foreground/60" : "",
    }));
  }, [columns]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      // Sorting/filtering are server-ignored for parquet, so disable both
      // rather than offer controls that silently do nothing.
      sortable: false,
      filter: false,
      resizable: true,
      minWidth: 80,
      flex: 1,
    }),
    [],
  );

  const onGridReady = useCallback(
    (e: GridReadyEvent) => {
      gridApiRef.current = e.api;
      e.api.setGridOption("datasource", datasource);
    },
    [datasource],
  );

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[12px]">
        <span className="font-medium uppercase tracking-wide text-[10.5px] text-foreground/80">
          parquet
        </span>
        <div className="ml-auto text-muted-foreground">
          {status.kind === "loading" && "Loading…"}
          {status.kind === "ready" && total !== null && (
            <span>
              {total.toLocaleString()} {total === 1 ? "row" : "rows"}
            </span>
          )}
        </div>
      </div>

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
              rowModelType="infinite"
              cacheBlockSize={BLOCK_SIZE}
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
