import { readCache, writeCache } from "@/lib/localCache";
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
 *
 * The last result is cached in localStorage (stale-while-revalidate): on mount
 * we paint the cached snapshot instantly (no spinner when present) and re-sync
 * in the background. The `invoke` itself must run on the main thread — Tauri's
 * IPC lives on `window.__TAURI_INTERNALS__`, which Web Workers (no `window`)
 * can't reach — so the heavy lifting stays in Rust, off the JS thread anyway.
 */

/** localStorage cache identity. Bump VERSION when `Analytics` shape changes. */
const CACHE_KEY = "agentlytics";
const CACHE_VERSION = 2;

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

/**
 * One workspace's rolled-up usage. A "workspace" is a distinct account or
 * environment — Claude's project cwd (a second `$CLAUDE_CONFIG_DIR` account on
 * the same path counts separately), a Gemini project hash, or Cursor's single
 * `default` bucket. Usage from different accounts is never summed together; the
 * dashboard renders one card per entry.
 */
export type WorkspaceUsage = {
  source: "claude" | "gemini" | "cursor";
  /** Project path / hash / config-root label identifying this workspace. */
  workspace: string;
  sessions: number;
  messages: number;
  estTokens: number;
  estCostUsd: number;
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
  /** Per-workspace rollup, busiest first. One card per distinct account/env. */
  workspaces: WorkspaceUsage[];
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
    workspaces: [],
  };
}

export type UseAnalytics = {
  data: Analytics;
  loading: boolean;
  error: string | null;
  /** Epoch ms of the data currently shown, or null when nothing cached yet. */
  syncedAt: number | null;
  /** Re-sync. `force` (default true) bypasses the Rust scan cache. */
  refresh: (force?: boolean) => void;
};

/**
 * Aggregate on-disk agent sessions via the Rust `agentscan_collect` command.
 *
 * The command is async on the Rust side (the disk walk runs on a blocking
 * thread pool, off the IPC worker, so the UI never freezes) and keeps a short
 * TTL cache of the last scan. Pass `force` to bypass that cache and re-read
 * disk — used by the explicit `refresh()`, not the background re-sync.
 */
async function computeAnalytics(force: boolean): Promise<Analytics> {
  const now = new Date();
  return invoke<Analytics>("agentscan_collect", {
    nowMs: now.getTime(),
    // getTimezoneOffset() is minutes *behind* UTC (positive west of UTC), so
    // negate to get the offset to add to a UTC instant to reach local time.
    tzOffsetMs: -now.getTimezoneOffset() * 60_000,
    force,
  });
}

/**
 * Loads and aggregates local AI session analytics.
 *
 * Strategy: the last good result is cached in localStorage. On mount we seed
 * state from the cache (instant paint, no spinner when present) and kick off a
 * background sync; `refresh` re-syncs on demand. Results are written back to
 * the cache for the next launch.
 */
export function useAnalytics(): UseAnalytics {
  const seed = readCache<Analytics>(CACHE_KEY, CACHE_VERSION);
  const [data, setData] = useState<Analytics>(seed?.value ?? emptyAnalytics());
  // Only show the blocking spinner when we have nothing cached to paint.
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(
    seed?.savedAt ?? null,
  );

  // `force` bypasses the Rust-side scan cache (re-reads disk). The mount-time
  // sync passes `false` so a re-mount within the TTL reuses the last scan; a
  // user-triggered refresh defaults to `true` to pull genuinely fresh data.
  const refresh = useCallback((force = true) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    computeAnalytics(force)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        const at = Date.now();
        setSyncedAt(at);
        writeCache(CACHE_KEY, CACHE_VERSION, result, at);
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

  // Mount-time sync reuses a fresh cached scan when available (force = false).
  useEffect(() => refresh(false), [refresh]);

  return { data, loading, error, syncedAt, refresh };
}
