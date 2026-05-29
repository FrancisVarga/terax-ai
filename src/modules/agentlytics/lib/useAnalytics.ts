import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * Local-first AI usage analytics — the in-app analog of agentlytics
 * (github.com/f/agentlytics). agentlytics scans many editors' session files
 * into a cache and surfaces tokens / cost / sessions / tools. Here the Rust
 * `agentscan_collect` command walks the on-disk session stores that external
 * coding agents leave behind — Claude Code (`~/.claude/projects`), Gemini CLI
 * (`~/.gemini/tmp`), and Cursor (`state.vscdb`) — and aggregates them. Token
 * counts are real where the source persists them and estimated from text
 * length (≈4 chars/token) otherwise; everything stays on the machine.
 */

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

/**
 * Aggregate on-disk agent sessions via the Rust `agentscan_collect` command.
 * The webview owns the clock and timezone, so we pass `nowMs` and the local
 * UTC offset; the backend uses them for day/hour bucketing without needing a
 * date crate. The returned shape already matches `Analytics` (serde renames to
 * camelCase), so no client-side transform is needed.
 */
async function computeAnalytics(): Promise<Analytics> {
  const now = new Date();
  return invoke<Analytics>("agentscan_collect", {
    nowMs: now.getTime(),
    // getTimezoneOffset() is minutes *behind* UTC (positive west of UTC), so
    // negate to get the offset to add to a UTC instant to reach local time.
    tzOffsetMs: -now.getTimezoneOffset() * 60_000,
  });
}

export type UseAnalytics = {
  data: Analytics;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Loads and aggregates local AI session analytics. Recomputes on mount and on
 * demand via `refresh`; cheap enough to run on tab open without caching.
 */
export function useAnalytics(): UseAnalytics {
  const [data, setData] = useState<Analytics>(emptyAnalytics);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    computeAnalytics()
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
  }, []);

  useEffect(() => refresh(), [refresh]);

  return { data, loading, error, refresh };
}
