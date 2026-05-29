/// <reference lib="webworker" />
/**
 * Off-main-thread loader for ccusage reports. The Rust `ccusage_collect`
 * command re-aggregates the same on-disk session stores agentlytics scans and
 * returns daily/weekly/monthly/session/block tables — a large JSON payload.
 * Running the `invoke` here keeps the IPC round-trip and structured-clone
 * deserialization off the render thread so the dashboard stays interactive
 * while a report is computed.
 *
 * Tauri injects its IPC internals into worker globals, so `invoke` works here
 * as on the main thread. The worker is stateless; the main thread owns the
 * localStorage cache (workers have no DOM storage).
 */
import { invoke } from "@tauri-apps/api/core";
import type { CcusageReport, CostMode } from "./useCcusage";

/** Request: webview-owned clock/timezone plus the selected cost mode. */
export type CcusageRequest = {
  nowMs: number;
  tzOffsetMs: number;
  costMode: CostMode;
};

/** Response: discriminated so the main thread can route ok vs. error. */
export type CcusageResponse =
  | { ok: true; data: CcusageReport }
  | { ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<CcusageRequest>) => {
  const { nowMs, tzOffsetMs, costMode } = e.data;
  try {
    const data = await invoke<CcusageReport>("ccusage_collect", {
      nowMs,
      tzOffsetMs,
      costMode,
    });
    const msg: CcusageResponse = { ok: true, data };
    ctx.postMessage(msg);
  } catch (err) {
    const msg: CcusageResponse = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(msg);
  }
};
