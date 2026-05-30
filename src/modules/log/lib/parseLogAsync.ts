/**
 * Main-thread client for the log parser. Routes small logs through the
 * synchronous `parseLog` (the postMessage round-trip would cost more than the
 * parse itself) and large logs through a shared Web Worker so the classify
 * loop never blocks the webview's single UI thread.
 */
import { parseLog, type LogLine } from "./parseLog";
import type { ParseRequest, ParseResponse } from "./parseLog.worker";

// Below this, parse inline — the regex pass is sub-millisecond and the worker
// hop (serialize raw in, structured-clone lines out) would only add latency.
const WORKER_THRESHOLD_LINES = 5_000;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (lines: LogLine[]) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./parseLog.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent<ParseResponse>) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data.lines);
    }
  };
  worker.onerror = () => {
    // A worker fault rejects nothing — callers already have the sync fallback
    // path on the next file; drop the worker so it's recreated fresh.
    for (const resolve of pending.values()) resolve([]);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Parse + classify log text without blocking the UI for large files. Returns a
 * promise so the caller can keep painting "Loading…" while the worker runs.
 * Cheap files resolve synchronously-fast on a microtask.
 */
export function parseLogAsync(raw: string): Promise<LogLine[]> {
  // A quick newline count is far cheaper than the full classify pass and lets
  // us decide whether the worker hop is worth it without parsing twice.
  let approxLines = 1;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10 /* \n */) approxLines++;
  }
  if (approxLines < WORKER_THRESHOLD_LINES) {
    return Promise.resolve(parseLog(raw));
  }

  return new Promise<LogLine[]>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const req: ParseRequest = { id, raw };
    try {
      getWorker().postMessage(req);
    } catch {
      // Worker construction can fail in locked-down webviews; fall back to a
      // synchronous parse so the log still renders (just with a frame hitch).
      pending.delete(id);
      resolve(parseLog(raw));
    }
  });
}
