import { readCache, writeCache } from "@/lib/localCache";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalyticsRequest,
  AnalyticsResponse,
} from "./analytics.worker";

/**
 * Local-first AI usage analytics — the in-app analog of agentlytics
 * (github.com/f/agentlytics). agentlytics scans many editors' session files
 * into a cache and surfaces tokens / cost / sessions / tools. Here the Rust
 * `agentscan_collect` command walks the on-disk session stores that external
 * coding agents leave behind — Claude Code (`~/.claude/projects`), Gemini CLI
 * (`~/.gemini/tmp`), and Cursor (`state.vscdb`) — and aggregates them. Token
 * counts are real where the source persists them and estimated from text
 * length (≈4 chars/token) otherwise; everything stays on the machine.
 *
 * Loading runs in a Web Worker (`analytics.worker.ts`) so the scan's IPC and
 * deserialization stay off the render thread, and the last result is cached in
 * localStorage: on mount we paint the cached snapshot instantly (no spinner)
 * and the worker re-syncs in the background (stale-while-revalidate).
 */

/** localStorage cache identity. Bump VERSION when `Analytics` shape changes. */
const CACHE_KEY = "agentlytics";
const CACHE_VERSION = 1;

export type ModelUsage = {
  model: string;
  messages: number;
  estTokens: number;
};

export type ToolUsage = {
  tool: string;
  calls: number;
};

export type DayActivity = {
  /** Local date key `YYYY-MM-DD`. */
  day: string;
  sessions: number;
  messages: number;
  estTokens: number;
};

/** What one on-disk agent source contributed (and why it's empty, if so). */
export type SourceBreakdown = {
  source: "claude" | "gemini" | "cursor";
  sessions: number;
  messages: number;
  estTokens: number;
  /** Non-fatal note when the source couldn't be read or had no data. */
  error?: string;
};

export type Analytics = {
  totalSessions: number;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  estTokens: number;
  estInputTokens: number;
  estOutputTokens: number;
  /** Estimated cost in USD from est. tokens × a blended rate. */
  estCostUsd: number;
  toolCalls: number;
  /** Longest run of consecutive active days ending today. */
  streakDays: number;
  topModels: ModelUsage[];
  topTools: ToolUsage[];
  /** Per-day buckets, oldest → newest, covering the last 90 days. */
  daily: DayActivity[];
  /** Most active hour-of-day (0–23), or null when no data. */
  peakHour: number | null;
  /** Per-hour message counts, index 0–23. */
  hourly: number[];
  /** Per-source rollup (Claude / Gemini / Cursor). */
  sources: SourceBreakdown[];
};

function emptyAnalytics(): Analytics {
  return {
    totalSessions: 0,
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    estTokens: 0,
    estInputTokens: 0,
    estOutputTokens: 0,
    estCostUsd: 0,
    toolCalls: 0,
    streakDays: 0,
    topModels: [],
    topTools: [],
    daily: [],
    peakHour: null,
    hourly: Array.from({ length: 24 }, () => 0),
    sources: [],
  };
}

export type UseAnalytics = {
  data: Analytics;
  loading: boolean;
  error: string | null;
  /** Epoch ms of the data currently shown, or null when nothing cached yet. */
  syncedAt: number | null;
  refresh: () => void;
};

/**
 * Loads and aggregates local AI session analytics.
 *
 * Strategy: a single long-lived Web Worker performs the scan off the render
 * thread; the last good result is cached in localStorage. On mount we seed
 * state from the cache (instant paint, no spinner when present) and kick off a
 * background sync. `refresh` re-syncs on demand. Worker results are written
 * back to the cache for the next launch.
 */
export function useAnalytics(): UseAnalytics {
  const seed = readCache<Analytics>(CACHE_KEY, CACHE_VERSION);
  const [data, setData] = useState<Analytics>(seed?.value ?? emptyAnalytics());
  // Only show the blocking spinner when we have nothing cached to paint.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(
    seed?.savedAt ?? null,
  );

  const workerRef = useRef<Worker | null>(null);

  // One worker for the hook's lifetime; recreated only if it ever errors out.
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("./analytics.worker.ts", import.meta.url),
        { type: "module" },
      );
    }
    return workerRef.current;
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const worker = getWorker();
    const now = new Date();
    worker.onmessage = (e: MessageEvent<AnalyticsResponse>) => {
      const res = e.data;
      if (res.ok) {
        setData(res.data);
        const at = Date.now();
        setSyncedAt(at);
        writeCache(CACHE_KEY, CACHE_VERSION, res.data, at);
      } else {
        setError(res.error);
      }
      setLoading(false);
    };
    worker.onerror = (e) => {
      setError(e.message || "analytics worker failed");
      setLoading(false);
      // Drop the failed worker so the next refresh spins up a fresh one.
      worker.terminate();
      workerRef.current = null;
    };
    const req: AnalyticsRequest = {
      nowMs: now.getTime(),
      // getTimezoneOffset() is minutes *behind* UTC (positive west of UTC), so
      // negate to get the offset to add to a UTC instant to reach local time.
      tzOffsetMs: -now.getTimezoneOffset() * 60_000,
    };
    worker.postMessage(req);
  }, [getWorker]);

  useEffect(() => {
    refresh();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [refresh]);

  return { data, loading, error, syncedAt, refresh };
}
