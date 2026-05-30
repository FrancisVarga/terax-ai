import { cn } from "@/lib/utils";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fmtClock, otel, useOtelResource, type LogRow } from "../../lib/useOtel";
import { useDrilldown } from "../../lib/useDrilldown";
import { attrMatch } from "../../lib/drilldown";
import {
  DetailSection,
  DetailShell,
  LatencyChart,
  OpsTable,
  StatStrip,
} from "./DetailShell";
import { CapNote } from "./ServiceDetail";
import { HttpPanelForSpans } from "./HttpPanel";
import { TracesTable } from "./TracesTable";

/**
 * Users / attribute-group detail: every signal for one dimension value (e.g.
 * tenant.id = "acme"). Drills down by the exact `key:value` attribute match —
 * spans, latency distribution, error breakdown, top operations, the HTTP
 * request (user-agent + headers), recent traces, and the matching log lines.
 * This is the deep page behind a card in the Users grid.
 */
export function UsersDetail({
  attrKey,
  value,
  tick,
  sinceMs,
  onBack,
  onOpenTrace,
}: {
  attrKey: string;
  value: string;
  tick: number;
  sinceMs?: number;
  onBack: () => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const match = attrMatch(attrKey, value);
  const dd = useDrilldown(
    {
      attrSearch: match,
      sinceMs,
      maxTraces: 100,
      // Keep only spans that actually carry this key=value (the trace match is
      // whole-trace, so sibling spans without the attribute are excluded here).
      spanFilter: (s) =>
        attrValue(s.attributes, attrKey) === value ||
        attrValue(s.resource, attrKey) === value,
    },
    [attrKey, value, tick, sinceMs],
  );

  // Logs carrying the same attribute value, correlated by the substring match.
  const { data: logs } = useOtelResource<LogRow[]>(
    () =>
      otel.logs({
        attrSearch: match,
        sinceMs,
        limit: 200,
      }),
    [],
    [attrKey, value, tick, sinceMs],
  );

  return (
    <DetailShell
      title={value || "(none)"}
      subtitle={attrKey}
      icon={
        <HugeiconsIcon icon={UserGroupIcon} size={16} strokeWidth={1.75} className="text-primary" />
      }
      onBack={onBack}
    >
      {dd.capped && <CapNote />}
      <StatStrip stats={dd.stats} />

      <LatencyChart buckets={dd.histogram} />

      <HttpPanelForSpans spans={dd.spans} />

      <DetailSection title="Top operations" count={dd.ops.length}>
        <OpsTable ops={dd.ops} />
      </DetailSection>

      {dd.errors.length > 0 && (
        <DetailSection title="Errors" count={dd.errors.length}>
          <div className="flex flex-col gap-1">
            {dd.errors.map((e) => (
              <button
                key={e.message}
                type="button"
                onClick={() => onOpenTrace(e.sampleTraceId)}
                className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/[0.06] px-2.5 py-1.5 text-left transition-colors hover:bg-destructive/10"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-destructive" title={e.message}>
                  {e.message}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-destructive/70">{e.service}</span>
                <span className="shrink-0 font-mono text-[10px] text-destructive/80">{e.count}×</span>
              </button>
            ))}
          </div>
        </DetailSection>
      )}

      <DetailSection title="Recent traces" count={dd.traces.length}>
        <TracesTable traces={dd.traces} onOpenTrace={onOpenTrace} />
      </DetailSection>

      {logs.length > 0 && (
        <DetailSection title="Logs" count={logs.length}>
          <div className="flex flex-col overflow-hidden rounded-lg border border-border/50">
            {logs.slice(0, 100).map((l, i) => (
              <LogMini key={`${l.timeNano}:${i}`} log={l} />
            ))}
          </div>
        </DetailSection>
      )}
    </DetailShell>
  );
}

function LogMini({ log }: { log: LogRow }) {
  const isErr = log.severityNumber >= 17;
  return (
    <div className="flex items-start gap-2.5 border-b border-border/30 px-3 py-1 font-mono text-[10.5px] last:border-0">
      <span className="shrink-0 text-muted-foreground/60">{fmtClock(log.timeNano)}</span>
      <span className={cn("w-12 shrink-0 font-semibold", isErr ? "text-red-400" : "text-muted-foreground")}>
        {log.severityText || (isErr ? "ERROR" : "")}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90" title={log.body}>
        {log.body}
      </span>
    </div>
  );
}

/** Read an attribute value from a span's attribute/resource bag as a string. */
function attrValue(bag: Record<string, unknown>, key: string): string | null {
  const v = bag?.[key];
  if (v == null) return null;
  return String(v);
}
