/**
 * Main-thread client for Prettier formatting. Routes small documents through
 * the synchronous `formatWithPrettier` (the postMessage round-trip + plugin
 * import in a fresh worker would cost more than the format itself) and large
 * documents through a shared Web Worker so the parse/print never blocks the
 * webview's single UI thread.
 *
 * Returns the same contract as `formatWithPrettier`:
 *   - `string`  → formatted output
 *   - `null`    → no Prettier parser for this extension (caller reindents)
 * and throws if Prettier fails (syntax error) so the caller can surface it.
 */
import { formatWithPrettier } from "./format";
import type { FormatRequest, FormatResponse } from "./format.worker";

// Documents at or above this byte length are formatted in the worker. Below it,
// Prettier finishes in a frame or two and the worker hop only adds latency.
// ~100 KB is roughly where a synchronous format starts to produce a visible
// hitch on the webview thread.
const WORKER_THRESHOLD_BYTES = 100 * 1024;

type Pending = {
  resolve: (out: string | null) => void;
  reject: (err: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./format.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent<FormatResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.formatted);
    else p.reject(new Error(e.data.message));
  };
  worker.onerror = () => {
    // A worker fault rejects every in-flight format; the worker is dropped so
    // the next call recreates it fresh. Callers fall back per their own logic.
    for (const p of pending.values()) p.reject(new Error("Format worker crashed"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** UTF-8 byte length without allocating the full encoded array. */
function byteLength(s: string): number {
  // Blob is the cheapest exact UTF-8 size in a browser/worker context.
  return new Blob([s]).size;
}

/**
 * Format `source` for `path`, offloading large documents to a Web Worker.
 * Small documents and the worker-unavailable fallback run inline on the main
 * thread. Resolves to the formatted string, or `null` when no Prettier parser
 * matches the extension. Rejects when Prettier itself errors.
 */
export function formatWithPrettierAsync(
  path: string,
  source: string,
): Promise<string | null> {
  if (byteLength(source) < WORKER_THRESHOLD_BYTES) {
    return formatWithPrettier(path, source);
  }

  return new Promise<string | null>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req: FormatRequest = { id, path, source };
    try {
      getWorker().postMessage(req);
    } catch {
      // Worker construction can fail in locked-down webviews; fall back to a
      // synchronous format so the command still works (with a frame hitch).
      pending.delete(id);
      formatWithPrettier(path, source).then(resolve, reject);
    }
  });
}
