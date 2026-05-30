/// <reference lib="webworker" />
import { generateBlock } from "./generate";
import type { WorkerRequest, WorkerResponse } from "./types";

/**
 * Generator worker. Runs the (pure) row generator off the main thread so
 * producing a block of a 200k-row dataset never blocks paint or scrolling.
 * The grid's datasource posts a `WorkerRequest` per block and resolves the
 * matching `WorkerResponse` by `requestId`.
 *
 * A small artificial latency makes the async loading visible (the showcase is
 * about *background* loading) without being slow; it is generation-bound work,
 * not IO, so the delay is intentional UX, kept tiny.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== "rows") return;
  const { rows, total } = generateBlock(req.startRow, req.endRow);
  const res: WorkerResponse = {
    type: "rows",
    requestId: req.requestId,
    startRow: req.startRow,
    rows,
    total,
  };
  ctx.postMessage(res);
};
