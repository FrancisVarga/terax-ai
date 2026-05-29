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
 */

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

/**
 * Aggregate on-disk agent sessions via the Rust `ccusage_collect` command. The
 * webview owns the clock and timezone, so we pass `nowMs` and the local UTC
 * offset for day/week/hour bucketing; `costMode` selects how per-message cost
 * is derived. The returned shape already matches `CcusageReport` (serde renames
 * to camelCase), so no client-side transform is needed.
 */
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

export type UseCcusage = {
  data: CcusageReport;
  loading: boolean;
  error: string | null;
  costMode: CostMode;
  setCostMode: (mode: CostMode) => void;
  refresh: () => void;
};

/**
 * Loads ccusage reports. Recomputes on mount, when the cost mode changes, and
 * on demand via `refresh`. Cheap enough to run on tab open without caching.
 */
export function useCcusage(): UseCcusage {
  const [costMode, setCostMode] = useState<CostMode>("auto");
  const [data, setData] = useState<CcusageReport>(() => emptyReport("auto"));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    computeReport(costMode)
      .then((result) => {
        if (!cancelled) setData(result);
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

  return { data, loading, error, costMode, setCostMode, refresh };
}
