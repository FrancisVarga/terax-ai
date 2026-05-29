/**
 * Log-parsing Web Worker. Classifying a large log (hundreds of thousands of
 * lines) runs five regex tests per line — synchronously that freezes the
 * webview's single main thread for hundreds of ms on tab open. Offloading the
 * parse here keeps the UI responsive; the main thread only pays the
 * postMessage copy of the raw text in and the classified lines out.
 *
 * Vite compiles this via the `new Worker(new URL("./parseLog.worker.ts", …))`
 * form in `parseLogAsync`. It is module-type so the shared `parseLog` import
 * resolves normally.
 */
import { parseLog, type LogLine } from "./parseLog";

export type ParseRequest = { id: number; raw: string };
export type ParseResponse = { id: number; lines: LogLine[] };

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, raw } = e.data;
  const lines = parseLog(raw);
  const msg: ParseResponse = { id, lines };
  // No Transferable: LogLine[] holds strings, which structured-clone copies.
  (self as unknown as Worker).postMessage(msg);
};
