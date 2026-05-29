import type { UIMessage } from "@ai-sdk/react";
import { useCallback, useEffect, useState } from "react";
import {
  loadAll,
  loadMessages,
  type SessionMeta,
} from "@/modules/ai/lib/sessions";

/**
 * Local-first AI usage analytics — the in-app analog of agentlytics
 * (github.com/f/agentlytics). agentlytics scans 17 editors' session files into
 * a SQLite cache and surfaces tokens / cost / sessions / tools. Here the data
 * source is this app's own AI session store (Tauri `LazyStore`), so nothing
 * leaves the machine. Tokens are not persisted by the SDK, so we estimate them
 * from message text length (≈4 chars/token) and label every derived figure as
 * an estimate.
 */

/** Rough chars→tokens proxy used across the dashboard (clearly an estimate). */
const CHARS_PER_TOKEN = 4;

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
};

/**
 * Blended USD/token estimate. Agentlytics drives cost from a per-model
 * `pricing.json`; we don't track real model pricing here, so use one
 * conservative blended rate and present the result as an estimate only.
 */
const BLENDED_USD_PER_1K_TOKENS = 0.005;

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function textLength(message: UIMessage): number {
  let len = 0;
  for (const part of message.parts) {
    if (part.type === "text") {
      len += (part as { text: string }).text.length;
    } else if (part.type === "reasoning") {
      len += (part as { text?: string }).text?.length ?? 0;
    }
  }
  return len;
}

function modelOf(message: UIMessage): string {
  // The AI SDK stores arbitrary metadata per message; model id, when present,
  // lives under `metadata.model`. Fall back to a generic bucket otherwise.
  const meta = (message as { metadata?: { model?: unknown } }).metadata;
  const model = meta?.model;
  return typeof model === "string" && model ? model : "unknown";
}

function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function computeStreak(activeDays: Set<string>): number {
  let streak = 0;
  const cursor = new Date();
  // Count back from today while each day is present.
  for (;;) {
    if (!activeDays.has(dayKey(cursor.getTime()))) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

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
  };
}

const DAILY_WINDOW = 90;

async function computeAnalytics(): Promise<Analytics> {
  const { sessions } = await loadAll();
  if (sessions.length === 0) return emptyAnalytics();

  const out = emptyAnalytics();
  out.totalSessions = sessions.length;

  const modelMap = new Map<string, ModelUsage>();
  const toolMap = new Map<string, number>();
  const dayMap = new Map<string, DayActivity>();
  const activeDays = new Set<string>();
  const hourly = Array.from({ length: 24 }, () => 0);

  // Pull each session's messages. These are independent reads, so fetch them
  // concurrently rather than serially to keep the dashboard snappy.
  const messageLists = await Promise.all(
    sessions.map((s) => loadMessages(s.id).catch(() => null)),
  );

  for (let i = 0; i < sessions.length; i++) {
    const meta: SessionMeta = sessions[i];
    const messages = messageLists[i] ?? [];

    const sessionDay = dayKey(meta.createdAt);
    activeDays.add(sessionDay);
    const dayBucket =
      dayMap.get(sessionDay) ??
      ({ day: sessionDay, sessions: 0, messages: 0, estTokens: 0 } as DayActivity);
    dayBucket.sessions += 1;

    for (const message of messages) {
      out.totalMessages += 1;
      const chars = textLength(message);
      const tokens = estTokens(chars);
      out.estTokens += tokens;
      dayBucket.messages += 1;
      dayBucket.estTokens += tokens;

      if (message.role === "user") {
        out.userMessages += 1;
        out.estInputTokens += tokens;
      } else if (message.role === "assistant") {
        out.assistantMessages += 1;
        out.estOutputTokens += tokens;
        const model = modelOf(message);
        const mu =
          modelMap.get(model) ??
          ({ model, messages: 0, estTokens: 0 } as ModelUsage);
        mu.messages += 1;
        mu.estTokens += tokens;
        modelMap.set(model, mu);
      }

      // Tool calls: AI SDK v5 encodes them as parts with a `tool-<name>` type.
      for (const part of message.parts) {
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          out.toolCalls += 1;
          const tool = part.type.slice("tool-".length) || "tool";
          toolMap.set(tool, (toolMap.get(tool) ?? 0) + 1);
        }
      }

      // Hour-of-day histogram keyed on the session timestamp (per-message
      // timestamps aren't persisted, so attribute messages to session start).
      const hour = new Date(meta.createdAt).getHours();
      hourly[hour] += 1;
    }

    dayMap.set(sessionDay, dayBucket);
  }

  out.estCostUsd = (out.estTokens / 1000) * BLENDED_USD_PER_1K_TOKENS;
  out.streakDays = computeStreak(activeDays);
  out.hourly = hourly;

  let peakHour: number | null = null;
  let peakCount = -1;
  for (let h = 0; h < 24; h++) {
    if (hourly[h] > peakCount) {
      peakCount = hourly[h];
      peakHour = h;
    }
  }
  out.peakHour = peakCount > 0 ? peakHour : null;

  out.topModels = [...modelMap.values()]
    .sort((a, b) => b.estTokens - a.estTokens)
    .slice(0, 6);
  out.topTools = [...toolMap.entries()]
    .map(([tool, calls]) => ({ tool, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);

  // Fill a contiguous trailing window so the activity chart has no gaps.
  const daily: DayActivity[] = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - (DAILY_WINDOW - 1));
  for (let i = 0; i < DAILY_WINDOW; i++) {
    const key = dayKey(cursor.getTime());
    daily.push(
      dayMap.get(key) ?? {
        day: key,
        sessions: 0,
        messages: 0,
        estTokens: 0,
      },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  out.daily = daily;

  return out;
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

export { CHARS_PER_TOKEN, BLENDED_USD_PER_1K_TOKENS };
