import { readCache, writeCache } from "@/lib/localCache";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * ccusage-faithful token/cost reports — the in-app analog of the `ccusage` CLI
 * (github.com/ryoppippi/ccusage). The Rust `ccusage_collect` command reuses the
 * same on-disk parsers that power agentlytics (Claude Code `~/.claude/projects`,
 * Gemini CLI, Cursor) but re-aggregates them ccusage-style: message-level dedup
 * by `message.id`+`requestId`, selectable cost modes, daily/weekly/monthly/
 * session tables, and Claude's rolling 5-hour billing blocks with a burn rate.
 * Everything stays on the machine.
 *
 * The last report per cost mode is cached in localStorage
 * (stale-while-revalidate): switching modes paints the cached snapshot
 * instantly while a fresh report syncs in the background. The `invoke` runs on
 * the main thread — Tauri's IPC lives on `window.__TAURI_INTERNALS__`, which
 * Web Workers (no `window`) can't reach — and the heavy work is in Rust anyway.
 */

/** localStorage cache identity. Bump VERSION when `CcusageReport` shape changes. */
const CACHE_VERSION = 1;
/** Cache key is per cost mode — each mode produces a distinct report. */
function cacheKey(mode: CostMode): string {
  return `ccusage:${mode}`;
}

/** How cost is derived per message. Mirrors ccusage's `--mode` flag. */
export type CostMode = "auto" | "calculate" | "display";

/** Token + cost rollup for one period (day, ISO week, month, or session). */
export type PeriodBucket = {
  /** `YYYY-MM-DD`, ISO-week `YYYY-Www`, `YYYY-MM`, or a session id. */
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Fresh input + output (cache excluded so repeated reads don't balloon it). */
  totalTokens: number;
  costUsd: number;
  /** Distinct models seen in this period. */
  models: string[];
};

/** A session rollup — a PeriodBucket (flattened) plus a time span + source. */
export type SessionBucket = PeriodBucket & {
  source: "claude" | "gemini" | "cursor";
  messages: number;
  startMs: number;
  endMs: number;
};

/** One Claude 5-hour billing block. */
export type BlockBucket = {
  startMs: number;
  endMs: number;
  isActive: boolean;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  models: string[];
  /** Tokens/minute over the elapsed span; absent when the span is zero. */
  burnRateTpm?: number;
  /** Projected end-of-window cost for the active block; absent otherwise. */
  projectedCostUsd?: number;
};

export type Totals = {
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
};

/** What one on-disk agent source contributed. */
export type SourceBreakdown = {
  source: "claude" | "gemini" | "cursor";
  sessions: number;
  messages: number;
  estTokens: number;
  error?: string;
};

export type CcusageReport = {
  costMode: CostMode;
  totals: Totals;
  daily: PeriodBucket[];
  weekly: PeriodBucket[];
  monthly: PeriodBucket[];
  sessions: SessionBucket[];
  blocks: BlockBucket[];
  sources: SourceBreakdown[];
};

function emptyReport(mode: CostMode): CcusageReport {
  return {
    costMode: mode,
    totals: {
      sessions: 0,
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    daily: [],
    weekly: [],
    monthly: [],
    sessions: [],
    blocks: [],
    sources: [],
  };
}

export type UseCcusage = {
  data: CcusageReport;
  loading: boolean;
  error: string | null;
  costMode: CostMode;
  /** Epoch ms of the data currently shown, or null when nothing cached yet. */
  syncedAt: number | null;
  setCostMode: (mode: CostMode) => void;
  refresh: () => void;
};

/** Aggregate on-disk agent sessions via the Rust `ccusage_collect` command. */
async function computeReport(mode: CostMode): Promise<CcusageReport> {
  const now = new Date();
  return invoke<CcusageReport>("ccusage_collect", {
    nowMs: now.getTime(),
    // getTimezoneOffset() is minutes behind UTC (positive west of UTC); negate
    // to get the offset to add to a UTC instant to reach local time.
    tzOffsetMs: -now.getTimezoneOffset() * 60_000,
    costMode: mode,
  });
}

/**
 * Loads ccusage reports.
 *
 * Strategy: the last report per cost mode is cached in localStorage. On mount
 * and whenever the cost mode changes we seed state from that mode's cache
 * (instant paint when present) and kick off a background sync. `refresh`
 * re-syncs on demand; results are written back to the cache for the next launch.
 */
export function useCcusage(): UseCcusage {
  const [costMode, setCostMode] = useState<CostMode>("auto");
  const seed = readCache<CcusageReport>(cacheKey("auto"), CACHE_VERSION);
  const [data, setData] = useState<CcusageReport>(
    () => seed?.value ?? emptyReport("auto"),
  );
  // Only block with a spinner when there's no cached report to paint.
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(
    seed?.savedAt ?? null,
  );

  const refresh = useCallback(() => {
    let cancelled = false;
    setError(null);
    // Seed instantly from this mode's cache so a mode switch isn't a blank wait.
    const cached = readCache<CcusageReport>(cacheKey(costMode), CACHE_VERSION);
    if (cached) {
      setData(cached.value);
      setSyncedAt(cached.savedAt);
      setLoading(false);
    } else {
      setLoading(true);
    }

    computeReport(costMode)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        const at = Date.now();
        setSyncedAt(at);
        writeCache(cacheKey(result.costMode), CACHE_VERSION, result, at);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [costMode]);

  useEffect(() => refresh(), [refresh]);

  return { data, loading, error, costMode, syncedAt, setCostMode, refresh };
}
