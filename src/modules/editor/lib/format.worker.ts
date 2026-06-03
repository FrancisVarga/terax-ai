/**
 * Prettier Web Worker. Formatting a large document (parse → AST → print) is
 * pure CPU work that, run synchronously, freezes the webview's single main
 * thread for seconds. Offloading it here keeps the editor interactive: the main
 * thread only pays the postMessage copy of the source in and the formatted
 * string out.
 *
 * Plugin loaders are functions (non-cloneable), so the worker can't receive a
 * resolved `PrettierSpec` over postMessage — it receives the file `path` and
 * resolves the spec itself via `prettierSpecFor`. Prettier and its plugins are
 * dynamically imported inside the worker, so the main bundle never pulls them
 * on this path.
 *
 * Vite compiles this via the `new Worker(new URL("./format.worker.ts", …))`
 * form in `formatAsync`. Module-type so the shared `format` import resolves.
 */
import { prettierSpecFor, runPrettier } from "./format";

export type FormatRequest = { id: number; path: string; source: string };
export type FormatResponse =
  | { id: number; ok: true; formatted: string | null }
  | { id: number; ok: false; message: string };

self.onmessage = async (e: MessageEvent<FormatRequest>) => {
  const { id, path, source } = e.data;
  const post = (msg: FormatResponse) =>
    (self as unknown as Worker).postMessage(msg);

  const spec = prettierSpecFor(path);
  // No Prettier parser for this extension → signal the caller to fall back to
  // CodeMirror reindent on the main thread.
  if (!spec) {
    post({ id, ok: true, formatted: null });
    return;
  }

  try {
    const formatted = await runPrettier(spec, source);
    post({ id, ok: true, formatted });
  } catch (err) {
    // Prettier throws on syntax errors — surface the message; the caller keeps
    // the buffer unchanged rather than clobbering it.
    post({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
