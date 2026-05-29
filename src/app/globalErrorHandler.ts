import { toast } from "sonner";

import { redactSensitive } from "@/modules/ai/lib/redact";

// React error boundaries catch render/lifecycle crashes only. They do NOT see
// errors thrown in async callbacks, event handlers, timers, or rejected
// promises. In the Tauri webview the only global hooks for those are
// `window.onerror` and `unhandledrejection` — there is no Node `process.on`.
// This module wires both, surfaces a redacted toast, and forwards the message
// to the Rust log so crashes are recoverable from the backend logs too.

// Toasts are throttled per-message so a tight error loop (e.g. a render that
// rejects every frame) can't bury the UI under a wall of duplicate toasts.
const TOAST_THROTTLE_MS = 4000;
const lastShownAt = new Map<string, number>();

function safeRedact(text: string): string {
  try {
    return redactSensitive(text);
  } catch {
    return text;
  }
}

// Pull a human-readable string out of whatever was thrown. Promise rejections
// and `window.onerror` can hand us anything — Error, string, DOMException, or a
// bare object — so normalize before redacting.
function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Forward to the Rust side for durable logging. Best-effort: the command may
// not exist in every build, so swallow failures (we never want logging to
// throw inside the error handler and re-enter the loop).
function logToBackend(message: string): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("log_renderer_error", { message }).catch(() => {}),
    )
    .catch(() => {});
}

function report(rawMessage: string, source: "error" | "rejection"): void {
  const message = safeRedact(rawMessage);

  // Dedupe on the first line so the same error firing repeatedly only toasts
  // once per throttle window.
  const key = message.split("\n")[0]?.slice(0, 200) ?? message;
  const now = Date.now();
  const prev = lastShownAt.get(key);
  if (prev !== undefined && now - prev < TOAST_THROTTLE_MS) {
    // Still log every occurrence; only the toast is throttled.
    logToBackend(message);
    return;
  }
  lastShownAt.set(key, now);

  // Keep the map from growing unbounded across a long session.
  if (lastShownAt.size > 50) {
    for (const [k, t] of lastShownAt) {
      if (now - t > TOAST_THROTTLE_MS) lastShownAt.delete(k);
    }
  }

  console.error(`[terax] unhandled ${source}:`, message);
  logToBackend(message);

  toast.error(
    source === "rejection"
      ? "An unexpected error occurred (unhandled promise)"
      : "An unexpected error occurred",
    {
      description: key,
    },
  );
}

let installed = false;

/**
 * Install global handlers for uncaught errors and unhandled promise
 * rejections. Idempotent — calling more than once is a no-op. Returns a
 * disposer that removes the listeners (mainly for tests / HMR).
 */
export function installGlobalErrorHandler(): () => void {
  if (installed) return () => {};
  installed = true;

  const onError = (event: ErrorEvent) => {
    // `event.error` carries the stack when available; fall back to the message.
    report(describe(event.error ?? event.message), "error");
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    report(describe(event.reason), "rejection");
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    installed = false;
  };
}
