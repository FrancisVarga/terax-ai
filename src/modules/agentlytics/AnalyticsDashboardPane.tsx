import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  ChartLineData01Icon,
  Coins01Icon,
  Message02Icon,
  RefreshIcon,
  RoboticIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import {
  useAnalytics,
  type Analytics,
  type DayActivity,
  type SourceBreakdown,
  type WorkspaceUsage,
} from "./lib/useAnalytics";

const SOURCE_LABELS: Record<SourceBreakdown["source"], string> = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  cursor: "Cursor",
};

/** Compact number, e.g. 12_500 → "12.5k", 3_200_000 → "3.2M". */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${period}`;
}

/** Coarse "synced Ns/Nm/Nh ago" label from an epoch ms timestamp. */
function fmtAgo(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "synced just now";
  if (s < 60) return `synced ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `synced ${m}m ago`;
  return `synced ${Math.round(m / 60)}h ago`;
}

/**
 * Local AI usage analytics dashboard — an in-app port of agentlytics
 * (github.com/f/agentlytics). Reads this app's own AI session store and renders
 * KPIs, an activity timeline, model/tool breakdowns, and a peak-hours heatmap.
 * All figures are derived locally; token/cost numbers are estimates (the SDK
 * does not persist real token counts).
 */
export function AnalyticsDashboardPane() {
  const { data, loading, error, syncedAt, refresh } = useAnalytics();

  if (loading && data.totalSessions === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Spinner className="size-4" />
        <span>Crunching local AI sessions…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-start gap-2 p-6 text-[12px] text-destructive">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={15}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0"
        />
        <span className="break-words">{error}</span>
      </div>
    );
  }

  if (data.totalSessions === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <HugeiconsIcon
          icon={ChartLineData01Icon}
          size={28}
          strokeWidth={1.5}
          className="opacity-60"
        />
        <p className="text-[13px] font-medium text-foreground">
          No agent sessions found
        </p>
        <p className="max-w-sm text-[11.5px]">
          Scanned Claude Code (<code>~/.claude/projects</code>), Gemini CLI
          (<code>~/.gemini</code>), and Cursor on this machine but found no
          sessions yet. Use any of those coding agents and your local usage —
          sessions, tokens, models, and tools — will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
        <Header onRefresh={refresh} loading={loading} syncedAt={syncedAt} />
        <KpiRow data={data} />
        <SourcesRow sources={data.sources} />
        <WorkspacesRow workspaces={data.workspaces} />
        <ActivityChart daily={data.daily} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ModelsCard data={data} />
          <ToolsCard data={data} />
        </div>
        <PeakHours data={data} />
        <p className="pt-1 text-[10.5px] leading-relaxed text-muted-foreground/70">
          100% local — scanned from on-disk coding-agent sessions (Claude Code,
          Gemini CLI, Cursor) on this machine, inspired by{" "}
          <span className="font-medium">agentlytics</span>. Token counts are real
          where the agent records them and estimated from text (≈4 chars/token)
          otherwise; cost uses per-model pricing where the model is known.
        </p>
      </div>
    </div>
  );
}

function Header({
  onRefresh,
  loading,
  syncedAt,
}: {
  onRefresh: () => void;
  loading: boolean;
  syncedAt: number | null;
}) {
  const ago = fmtAgo(syncedAt);
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={ChartLineData01Icon}
          size={18}
          strokeWidth={1.75}
          className="text-primary"
        />
        <div>
          <h1 className="text-[15px] font-semibold leading-tight">
            Agentlytics
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Local AI coding analytics
            {ago ? <span className="text-muted-foreground/60"> · {ago}</span> : null}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRefresh()}
        title="Refresh"
        className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon
          icon={RefreshIcon}
          size={13}
          strokeWidth={1.75}
          className={cn(loading && "animate-spin")}
        />
        Refresh
      </button>
    </div>
  );
}

function KpiRow({ data }: { data: Analytics }) {
  const kpis = [
    {
      label: "Sessions",
      value: fmtNum(data.totalSessions),
      sub: `${data.streakDays}d streak`,
      icon: Message02Icon,
    },
    {
      label: "Messages",
      value: fmtNum(data.totalMessages),
      sub: `${fmtNum(data.userMessages)} you · ${fmtNum(data.assistantMessages)} AI`,
      icon: Message02Icon,
    },
    {
      label: "Tokens (est.)",
      value: fmtNum(data.estTokens),
      sub: `↑${fmtNum(data.estInputTokens)} ↓${fmtNum(data.estOutputTokens)}`,
      icon: Tag01Icon,
    },
    {
      label: "Cost (est.)",
      value: fmtUsd(data.estCostUsd),
      sub: `${fmtNum(data.toolCalls)} tool calls`,
      icon: Coins01Icon,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-3"
        >
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <HugeiconsIcon icon={k.icon} size={12} strokeWidth={1.75} />
            {k.label}
          </div>
          <div className="font-mono text-[20px] font-semibold leading-none text-foreground">
            {k.value}
          </div>
          <div className="truncate font-mono text-[10.5px] text-muted-foreground">
            {k.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourcesRow({ sources }: { sources: SourceBreakdown[] }) {
  // Always render the three known sources in a stable order, even when a
  // source contributed nothing, so the user can see what was scanned.
  const order: SourceBreakdown["source"][] = ["claude", "gemini", "cursor"];
  const byKey = new Map(sources.map((s) => [s.source, s]));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {order.map((key) => {
        const s = byKey.get(key);
        const messages = s?.messages ?? 0;
        const sessions = s?.sessions ?? 0;
        const note = s?.error;
        const active = messages > 0;
        return (
          <div
            key={key}
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-3",
              active
                ? "border-border/50 bg-background/40"
                : "border-border/30 bg-background/20",
            )}
          >
            <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              <HugeiconsIcon icon={RoboticIcon} size={12} strokeWidth={1.75} />
              {SOURCE_LABELS[key]}
            </div>
            <div className="font-mono text-[16px] font-semibold leading-none text-foreground">
              {fmtNum(messages)}{" "}
              <span className="text-[11px] font-normal text-muted-foreground">
                msg
              </span>
            </div>
            <div className="truncate font-mono text-[10.5px] text-muted-foreground">
              {active
                ? `${fmtNum(sessions)} sessions · ${fmtNum(s?.estTokens ?? 0)} tok`
                : (note ?? "no data")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Short label for a workspace path: trailing 2 path segments, else the raw
 * value (Gemini hash / "default"). Full value lives in the `title` tooltip. */
function workspaceLabel(ws: string): string {
  const parts = ws.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return ws;
  return parts.slice(-2).join("/");
}

/**
 * Per-workspace breakdown — one card per distinct account/environment. Usage is
 * never summed across workspaces (a second `$CLAUDE_CONFIG_DIR` account, a
 * different project cwd, or another agent each get their own card), so two
 * accounts sharing a project path stay separate rows.
 */
function WorkspacesRow({ workspaces }: { workspaces: WorkspaceUsage[] }) {
  if (workspaces.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <HugeiconsIcon icon={Tag01Icon} size={12} strokeWidth={1.75} />
        Workspaces ({workspaces.length})
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces.map((w) => (
          <div
            key={`${w.source}:${w.workspace}`}
            className="flex flex-col gap-1 rounded-lg border border-border/50 bg-background/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="truncate font-mono text-[12px] font-medium text-foreground"
                title={w.workspace}
              >
                {workspaceLabel(w.workspace)}
              </span>
              <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {SOURCE_LABELS[w.source]}
              </span>
            </div>
            <div className="font-mono text-[15px] font-semibold leading-none text-foreground">
              {fmtNum(w.estTokens)}{" "}
              <span className="text-[11px] font-normal text-muted-foreground">
                tok
              </span>
              <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                {fmtUsd(w.estCostUsd)}
              </span>
            </div>
            <div className="truncate font-mono text-[10.5px] text-muted-foreground">
              {fmtNum(w.sessions)} sessions · {fmtNum(w.messages)} msg
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityChart({ daily }: { daily: DayActivity[] }) {
  const W = 720;
  const H = 90;
  const { line, area, peak } = useMemo(() => {
    const series = daily.map((d) => d.estTokens);
    const peak = Math.max(1, ...series);
    const n = series.length;
    if (n === 0) return { line: "", area: "", peak };
    const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
    const y = (v: number) => H - (v / peak) * (H - 4) - 2;
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const line = `M${pts.join(" L")}`;
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { line, area, peak };
  }, [daily]);

  const activeDays = daily.filter((d) => d.messages > 0).length;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-background/40 p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Activity · last 90 days
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {activeDays} active days · peak {fmtNum(peak)} tok/day
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label="Token activity over the last 90 days"
      >
        <line
          x1={0}
          y1={H - 1}
          x2={W}
          y2={H - 1}
          stroke="currentColor"
          className="text-border/50"
          strokeWidth={1}
        />
        {area ? (
          <path d={area} fill="var(--primary, #6366f1)" opacity={0.12} />
        ) : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke="var(--primary, #6366f1)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </div>
  );
}

function ModelsCard({ data }: { data: Analytics }) {
  const max = Math.max(1, ...data.topModels.map((m) => m.estTokens));
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/50 bg-background/40 p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <HugeiconsIcon icon={RoboticIcon} size={13} strokeWidth={1.75} />
        Top models
      </div>
      {data.topModels.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No model data.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.topModels.map((m) => (
            <li key={m.model} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11.5px] text-foreground">
                  {m.model}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  {fmtNum(m.estTokens)} tok · {fmtNum(m.messages)} msg
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${(m.estTokens / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolsCard({ data }: { data: Analytics }) {
  const max = Math.max(1, ...data.topTools.map((t) => t.calls));
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/50 bg-background/40 p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        <HugeiconsIcon icon={ChartLineData01Icon} size={13} strokeWidth={1.75} />
        Top tools
      </div>
      {data.topTools.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No tool calls yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.topTools.map((t) => (
            <li key={t.tool} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[11.5px] text-foreground">
                  {t.tool}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                  {fmtNum(t.calls)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                <div
                  className="h-full rounded-full bg-chart-2/70"
                  style={{
                    width: `${(t.calls / max) * 100}%`,
                    backgroundColor: "var(--chart-2, #22c55e)",
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PeakHours({ data }: { data: Analytics }) {
  const max = Math.max(1, ...data.hourly);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/50 bg-background/40 p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Peak hours
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {data.peakHour === null
            ? "—"
            : `most active ${fmtHour(data.peakHour)}`}
        </span>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height: 56 }}>
        {data.hourly.map((count, h) => (
          <div
            key={h}
            className="group flex flex-1 flex-col items-center justify-end"
            title={`${fmtHour(h)} · ${count} msg`}
          >
            <div
              className={cn(
                "w-full rounded-sm transition-colors",
                h === data.peakHour ? "bg-primary" : "bg-primary/35",
              )}
              style={{
                height: `${Math.max(2, (count / max) * 48)}px`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
        <span>12am</span>
        <span>6am</span>
        <span>12pm</span>
        <span>6pm</span>
        <span>11pm</span>
      </div>
    </div>
  );
}
