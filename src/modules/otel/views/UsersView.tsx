import { cn } from "@/lib/utils";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import { SegmentedControl } from "./TracesView";
import {
  fmtAgo,
  fmtDuration,
  otel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type AttrGroup,
} from "../lib/useOtel";
import { UsersDetail } from "./detail/UsersDetail";
import { TraceDetail } from "./detail/TraceDetail";

type UsersNav =
  | { kind: "grid" }
  | { kind: "group"; value: string }
  | { kind: "trace"; traceId: string };

/**
 * Per-dimension deep analytics ("Users"): groups span activity by the value of
 * an attribute (default `tenant.id`, but any captured attribute key works) and
 * shows per-group request volume, error rate, latency, top operations, and
 * recency. The dimension picker turns this into a generic "group by anything"
 * analytics surface.
 */
const PREFERRED_KEYS = ["tenant.id", "user.id", "enduser.id", "session.id"];

export function UsersView({ tick }: { tick: number }) {
  const [key, setKey] = useState<string>("");
  const [windowMs, setWindowMs] = useState(0);
  const [nav, setNav] = useState<UsersNav>({ kind: "grid" });

  const { data: keys } = useOtelResource<string[]>(() => otel.attributeKeys(), [], [tick]);

  // Default the dimension to the first preferred key that exists, else the
  // first available attribute key.
  useEffect(() => {
    if (key || keys.length === 0) return;
    const preferred = PREFERRED_KEYS.find((k) => keys.includes(k));
    setKey(preferred ?? keys[0]);
  }, [keys, key]);

  const { data: groups, loading } = useOtelResource<AttrGroup[]>(
    () => (key ? otel.attrBreakdown(key, sinceFromWindow(windowMs), 200) : Promise.resolve([])),
    [],
    [tick, key, windowMs],
  );

  // Full-page-replace detail navigation.
  if (nav.kind === "group") {
    return (
      <UsersDetail
        attrKey={key}
        value={nav.value}
        tick={tick}
        sinceMs={sinceFromWindow(windowMs)}
        onBack={() => setNav({ kind: "grid" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
      />
    );
  }
  if (nav.kind === "trace") {
    return (
      <TraceDetail
        traceId={nav.traceId}
        tick={tick}
        onBack={() => setNav({ kind: "grid" })}
      />
    );
  }

  if (!loading && keys.length === 0) {
    return (
      <OtelEmpty
        loading={loading}
        what="attributes"
        hint="Add attributes to your spans (e.g. tenant.id, user.id) and this view breaks activity down by any of them: volume, error rate, latency, and top operations per group."
      />
    );
  }

  const totals = groups.reduce(
    (acc, g) => ({
      spans: acc.spans + g.spans,
      errors: acc.errors + g.errors,
      traces: acc.traces + g.traces,
    }),
    { spans: 0, errors: 0, traces: 0 },
  );
  const maxSpans = Math.max(1, ...groups.map((g) => g.spans));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={UserGroupIcon} size={14} strokeWidth={1.75} className="text-primary" />
          <span className="text-[11px] text-muted-foreground">Group by</span>
          <select
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="rounded-md border border-border/60 bg-background/50 px-2 py-1 font-mono text-[11px] outline-none"
          >
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground">
            {groups.length} groups · {totals.spans} spans
            {totals.errors > 0 && <span className="text-red-400"> · {totals.errors} err</span>}
          </span>
        </div>
        <SegmentedControl
          label="Window"
          options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
          value={windowMs}
          onChange={setWindowMs}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {groups.length === 0 ? (
          <p className="p-4 text-center text-[11.5px] text-muted-foreground">
            No activity for this dimension in the selected window.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <GroupCard
                key={g.value}
                group={g}
                maxSpans={maxSpans}
                onOpen={() => setNav({ kind: "group", value: g.value })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupCard({
  group,
  maxSpans,
  onOpen,
}: {
  group: AttrGroup;
  maxSpans: number;
  onOpen: () => void;
}) {
  const errRate = group.spans > 0 ? group.errors / group.spans : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-lg border border-border/50 bg-background/40 p-3 text-left transition-colors hover:border-border hover:bg-accent/30"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[12px] font-medium text-foreground" title={group.value}>
          {group.value || "(none)"}
        </span>
        {group.errors > 0 && (
          <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-destructive">
            {(errRate * 100).toFixed(0)}% err
          </span>
        )}
      </div>
      {/* volume bar */}
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
        <div
          className={cn("h-full rounded-full", errRate > 0.01 ? "bg-red-400/70" : "bg-primary/60")}
          style={{ width: `${(group.spans / maxSpans) * 100}%` }}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 font-mono text-[10.5px]">
        <Stat label="spans" value={String(group.spans)} />
        <Stat label="traces" value={String(group.traces)} />
        <Stat label="errors" value={String(group.errors)} danger={group.errors > 0} />
        <Stat label="avg" value={fmtDuration(group.avgNano)} />
        <Stat label="p95" value={fmtDuration(group.p95Nano)} />
        <Stat label="seen" value={fmtAgo(group.lastSeenMs)} />
      </div>
      {group.topOps.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-border/40 pt-1.5">
          {group.topOps.map((op) => (
            <span
              key={op}
              className="truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
              title={op}
            >
              {op}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <span className={cn("text-foreground/90", danger && "text-red-400")}>{value}</span>
    </div>
  );
}
