import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  ChartLineData01Icon,
  Coins01Icon,
  Message02Icon,
  RefreshIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  useCcusage,
  type BlockBucket,
  type CostMode,
  type PeriodBucket,
  type SessionBucket,
  type Totals,
  type UseCcusage,
} from "./lib/useCcusage";

/** The report views, mirroring ccusage's subcommands. */
type View = "daily" | "weekly" | "monthly" | "session" | "blocks";

const VIEWS: { id: View; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "session", label: "Session" },
  { id: "blocks", label: "Blocks" },
];

const COST_MODES: { id: CostMode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Real costUSD when present, else calculated" },
  { id: "calculate", label: "Calc", hint: "Always derived from tokens × pricing" },
  { id: "display", label: "Display", hint: "Only the costUSD baked into the transcript" },
];

/** Compact number, e.g. 12_500 → "12.5k", 3_200_000 → "3.2M". */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** `YYYY-MM-DDTHH:MM` in local time from epoch ms. */
function fmtDateTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
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
 * ccusage dashboard — an in-app port of the `ccusage` CLI
 * (github.com/ryoppippi/ccusage). Reuses the same on-disk parsers as
 * agentlytics but re-aggregates ccusage-style: deduped daily / weekly / monthly
 * / session tables and Claude's rolling 5-hour billing blocks, with a
 * selectable cost mode. All figures are derived locally.
 */
export function CcusageDashboardPane() {
  const usage = useCcusage();
  const { data, loading, error } = usage;
  const [view, setView] = useState<View>("daily");

  if (loading && data.totals.messages === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Spinner className="size-4" />
        <span>Aggregating local agent usage…</span>
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
        <Header usage={usage} />
        <TotalsRow totals={data.totals} />
        <ViewSwitcher view={view} onChange={setView} />
        {data.totals.messages === 0 ? (
          <EmptyState />
        ) : view === "session" ? (
          <SessionTable sessions={data.sessions} />
        ) : view === "blocks" ? (
          <BlocksView blocks={data.blocks} />
        ) : (
          <PeriodTable
            buckets={
              view === "daily"
                ? data.daily
                : view === "weekly"
                  ? data.weekly
                  : data.monthly
            }
            keyLabel={
              view === "daily" ? "Day" : view === "weekly" ? "Week" : "Month"
            }
          />
        )}
        <p className="pt-1 text-[10.5px] leading-relaxed text-muted-foreground/70">
          100% local — a port of <span className="font-medium">ccusage</span>{" "}
          over on-disk coding-agent sessions (Claude Code, Gemini CLI, Cursor).
          Duplicate transcript lines are collapsed by message + request id. Cost
          mode <span className="font-mono">{data.costMode}</span>: token counts
          are real where the agent records them and estimated from text (≈4
          chars/token) otherwise.
        </p>
      </div>
    </div>
  );
}

function Header({ usage }: { usage: UseCcusage }) {
  const { refresh, loading, costMode, setCostMode, syncedAt } = usage;
  const ago = fmtAgo(syncedAt);
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={Coins01Icon}
          size={18}
          strokeWidth={1.75}
          className="text-primary"
        />
        <div>
          <h1 className="text-[15px] font-semibold leading-tight">ccusage</h1>
          <p className="text-[11px] text-muted-foreground">
            Token &amp; cost reports
            {ago ? <span className="text-muted-foreground/60"> · {ago}</span> : null}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-border/60 bg-background/50 p-0.5">
          {COST_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setCostMode(m.id)}
              title={m.hint}
              className={cn(
                "rounded px-2 py-1 text-[10.5px] font-medium transition-colors",
                costMode === m.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
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
    </div>
  );
}

function TotalsRow({ totals }: { totals: Totals }) {
  const kpis = [
    {
      label: "Sessions",
      value: fmtNum(totals.sessions),
      sub: `${fmtNum(totals.messages)} messages`,
      icon: Message02Icon,
    },
    {
      label: "Tokens",
      value: fmtNum(totals.totalTokens),
      sub: `↑${fmtNum(totals.inputTokens)} ↓${fmtNum(totals.outputTokens)}`,
      icon: Tag01Icon,
    },
    {
      label: "Cache",
      value: fmtNum(totals.cacheReadTokens + totals.cacheCreationTokens),
      sub: `${fmtNum(totals.cacheReadTokens)} read · ${fmtNum(totals.cacheCreationTokens)} write`,
      icon: Tag01Icon,
    },
    {
      label: "Cost",
      value: fmtUsd(totals.costUsd),
      sub: "total",
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

function ViewSwitcher({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background/50 p-0.5">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onChange(v.id)}
          className={cn(
            "flex-1 rounded px-2.5 py-1.5 text-[11.5px] font-medium transition-colors",
            view === v.id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border/40 bg-background/20 p-10 text-center text-muted-foreground">
      <HugeiconsIcon
        icon={Coins01Icon}
        size={26}
        strokeWidth={1.5}
        className="opacity-60"
      />
      <p className="text-[13px] font-medium text-foreground">
        No agent usage found
      </p>
      <p className="max-w-sm text-[11.5px]">
        Scanned Claude Code (<code>~/.claude/projects</code>), Gemini CLI, and
        Cursor on this machine but found no sessions yet. Use any of those coding
        agents and your token usage and cost will show up here.
      </p>
    </div>
  );
}

/** A sortable-looking bar-row table for period buckets (most recent first). */
function PeriodTable({
  buckets,
  keyLabel,
}: {
  buckets: PeriodBucket[];
  keyLabel: string;
}) {
  // Most recent period first.
  const rows = [...buckets].reverse();
  const maxCost = Math.max(1e-9, ...rows.map((b) => b.costUsd));
  if (rows.length === 0) {
    return (
      <p className="px-1 text-[11.5px] text-muted-foreground">No data yet.</p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="border-b border-border/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <th className="px-3 py-2 text-left">{keyLabel}</th>
            <th className="px-3 py-2 text-right">Input</th>
            <th className="px-3 py-2 text-right">Output</th>
            <th className="px-3 py-2 text-right">Cache</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.key}
              className="border-b border-border/30 last:border-0 hover:bg-accent/40"
            >
              <td className="px-3 py-1.5">
                <span className="font-mono text-foreground">{b.key}</span>
                {b.models.length > 0 ? (
                  <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                    {b.models.length === 1
                      ? shortModel(b.models[0])
                      : `${b.models.length} models`}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                {fmtNum(b.inputTokens)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                {fmtNum(b.outputTokens)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                {fmtNum(b.cacheReadTokens + b.cacheCreationTokens)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-foreground">
                {fmtNum(b.totalTokens)}
              </td>
              <td className="px-3 py-1.5 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-12 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(b.costUsd / maxCost) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 font-mono text-foreground">
                    {fmtUsd(b.costUsd)}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SOURCE_LABELS: Record<SessionBucket["source"], string> = {
  claude: "Claude",
  gemini: "Gemini",
  cursor: "Cursor",
};

function SessionTable({ sessions }: { sessions: SessionBucket[] }) {
  if (sessions.length === 0) {
    return (
      <p className="px-1 text-[11.5px] text-muted-foreground">
        No sessions yet.
      </p>
    );
  }
  const maxCost = Math.max(1e-9, ...sessions.map((s) => s.costUsd));
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="border-b border-border/50 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <th className="px-3 py-2 text-left">Session</th>
            <th className="px-3 py-2 text-left">Last active</th>
            <th className="px-3 py-2 text-right">Msgs</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={`${s.source}:${s.key}`}
              className="border-b border-border/30 last:border-0 hover:bg-accent/40"
            >
              <td className="max-w-[220px] px-3 py-1.5">
                <span className="rounded bg-foreground/[0.06] px-1 py-0.5 text-[9.5px] font-medium uppercase text-muted-foreground">
                  {SOURCE_LABELS[s.source]}
                </span>{" "}
                <span className="font-mono text-muted-foreground" title={s.key}>
                  {shortId(s.key)}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">
                {fmtDateTime(s.endMs)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                {fmtNum(s.messages)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono text-foreground">
                {fmtNum(s.totalTokens)}
              </td>
              <td className="px-3 py-1.5 text-right">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1.5 w-12 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(s.costUsd / maxCost) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 font-mono text-foreground">
                    {fmtUsd(s.costUsd)}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlocksView({ blocks }: { blocks: BlockBucket[] }) {
  if (blocks.length === 0) {
    return (
      <p className="px-1 text-[11.5px] text-muted-foreground">
        No billing blocks yet.
      </p>
    );
  }
  // Most recent block first; the active block (if any) floats to the top.
  const rows = [...blocks].reverse();
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((b) => (
        <div
          key={b.startMs}
          className={cn(
            "flex flex-col gap-2 rounded-lg border p-3.5",
            b.isActive
              ? "border-primary/60 bg-primary/[0.06]"
              : "border-border/50 bg-background/40",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={ChartLineData01Icon}
                size={13}
                strokeWidth={1.75}
                className={b.isActive ? "text-primary" : "text-muted-foreground"}
              />
              <span className="font-mono text-[11.5px] text-foreground">
                {fmtTime(b.startMs)}–{fmtTime(b.endMs)}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {fmtDateTime(b.startMs).slice(0, 10)}
              </span>
              {b.isActive ? (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-primary">
                  Active
                </span>
              ) : null}
            </div>
            <span className="font-mono text-[13px] font-semibold text-foreground">
              {fmtUsd(b.costUsd)}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
            <span>{fmtNum(b.messages)} msg</span>
            <span>{fmtNum(b.totalTokens)} tok</span>
            <span>
              ↑{fmtNum(b.inputTokens)} ↓{fmtNum(b.outputTokens)}
            </span>
            {b.burnRateTpm !== undefined ? (
              <span>{fmtNum(b.burnRateTpm)} tok/min</span>
            ) : null}
            {b.isActive && b.projectedCostUsd !== undefined ? (
              <span className="text-primary">
                proj. {fmtUsd(b.projectedCostUsd)}
              </span>
            ) : null}
            {b.models.length > 0 ? (
              <span className="text-muted-foreground/70">
                {b.models.map(shortModel).join(", ")}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Trim a long model id to its recognizable family/version tail. */
function shortModel(model: string): string {
  return model.length > 28 ? `…${model.slice(-26)}` : model;
}

/** Trim a long session id (often a UUID) for display. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
