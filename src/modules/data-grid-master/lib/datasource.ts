import type { IDatasource, IGetRowsParams } from "ag-grid-community";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { GridRow, WorkerRequest, WorkerResponse } from "./types";

/**
 * Datasources for the Infinite Row Model. The grid calls `getRows` for a window
 * of rows; we resolve it from a background job and call `successCallback(rows,
 * lastRow)`. `lastRow` is the definitive total once known so the grid stops
 * paging. This mirrors the proven shape in `modules/data/DataPane.tsx`.
 */

/**
 * Synthetic source: rows come from the generator Worker. Each block is a
 * request/response keyed by `requestId` so overlapping in-flight blocks (the
 * grid prefetches ahead) resolve to the right callback. The worker is owned by
 * the caller (created once, terminated on unmount).
 */
export function makeSyntheticDatasource(worker: Worker): IDatasource {
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (r: WorkerResponse) => void; reject: () => void }
  >();

  const onMessage = (e: MessageEvent<WorkerResponse>) => {
    const res = e.data;
    if (res.type !== "rows") return;
    const entry = pending.get(res.requestId);
    if (!entry) return;
    pending.delete(res.requestId);
    entry.resolve(res);
  };
  const onError = () => {
    for (const { reject } of pending.values()) reject();
    pending.clear();
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);

  return {
    rowCount: undefined,
    getRows: (params: IGetRowsParams) => {
      const requestId = ++seq;
      const req: WorkerRequest = {
        type: "rows",
        requestId,
        startRow: params.startRow,
        endRow: params.endRow,
      };
      new Promise<WorkerResponse>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage(req);
      })
        .then((res) => {
          params.successCallback(res.rows, res.total);
        })
        .catch(() => params.failCallback());
    },
  };
}

/** Wire format returned by the `data_*` Rust commands (matches DataPane). */
type DataPreview = {
  columns: string[];
  rows: (string | null)[][];
  total: number | null;
};

export type FileFormat = "sqlite" | "csv" | "parquet";

/** Sort spec forwarded to Rust — column *index* + direction. */
type SortSpec = { col: number; desc: boolean };

const FILE_BLOCK_SIZE = 200;

/**
 * Real-file source: pages a workspace `.csv`/`.parquet`/`.sqlite` through the
 * existing `data_*` Rust commands, off the main thread (the heavy scan happens
 * in Rust). Columns are reported via `onColumns` from the first block so the
 * caller can build colDefs for an unknown schema. Cells are index-keyed
 * (`c0`, `c1`, …) to match the dynamic column ids.
 */
export function makeFileDatasource(opts: {
  path: string;
  format: FileFormat;
  table: string | null;
  onColumns: (columns: string[], total: number | null) => void;
}): IDatasource {
  const { path, format, table, onColumns } = opts;
  return {
    rowCount: undefined,
    getRows: (params: IGetRowsParams) => {
      const sm = params.sortModel[0];
      const sort: SortSpec | undefined = sm
        ? { col: Number(String(sm.colId).slice(1)), desc: sm.sort === "desc" }
        : undefined;
      const common = {
        path,
        limit: FILE_BLOCK_SIZE,
        offset: params.startRow,
        search: null,
        sort: sort ?? null,
        workspace: currentWorkspaceEnv(),
      };
      const call: Promise<DataPreview> =
        format === "sqlite"
          ? invoke<DataPreview>("data_sqlite_rows", { ...common, table })
          : format === "csv"
            ? invoke<DataPreview>("data_csv_preview", common)
            : invoke<DataPreview>("data_parquet_preview", common);

      call
        .then((res) => {
          if (params.startRow === 0) onColumns(res.columns, res.total);
          const rows = res.rows.map((row) => {
            const obj: Record<string, string | null> = {};
            row.forEach((cell, i) => {
              obj[`c${i}`] = cell;
            });
            return obj as unknown as GridRow;
          });
          const lastRow =
            res.total !== null
              ? res.total
              : res.rows.length < FILE_BLOCK_SIZE
                ? params.startRow + res.rows.length
                : -1;
          params.successCallback(rows, lastRow);
        })
        .catch(() => params.failCallback());
    },
  };
}
