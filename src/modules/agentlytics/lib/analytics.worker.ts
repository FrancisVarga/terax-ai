/// <reference lib="webworker" />
/**
 * Off-main-thread loader for agentlytics. The Rust `agentscan_collect` command
 * walks several on-disk session stores and returns a sizeable JSON blob; doing
 * the `invoke` (and its structured-clone deserialization) here keeps the IPC
 * round-trip and any future client-side reshaping off the render thread, so the
 * dashboard tab stays responsive while a scan is in flight.
 *
 * Tauri injects its IPC internals (`window.__TAURI_INTERNALS__`) into worker
 * globals too, so `invoke` works here exactly as on the main thread. The worker
 * is stateless: the main thread owns the localStorage cache (workers have no
 * DOM storage), so we only fetch and post back.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Analytics } from "./useAnalytics";

/** Request: the webview owns the clock/timezone and passes them in. */
export type AnalyticsRequest = {
  nowMs: number;
  tzOffsetMs: number;
};

/** Response: discriminated so the main thread can route ok vs. error. */
export type AnalyticsResponse =
  | { ok: true; data: Analytics }
  | { ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<AnalyticsRequest>) => {
  const { nowMs, tzOffsetMs } = e.data;
  try {
    const data = await invoke<Analytics>("agentscan_collect", {
      nowMs,
      tzOffsetMs,
    });
    const msg: AnalyticsResponse = { ok: true, data };
    ctx.postMessage(msg);
  } catch (err) {
    const msg: AnalyticsResponse = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(msg);
  }
};
