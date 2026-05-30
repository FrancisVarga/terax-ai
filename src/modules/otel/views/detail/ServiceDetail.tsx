import { cn } from "@/lib/utils";
import { ConnectIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fmtDuration, type ServiceMap } from "../../lib/useOtel";
import { useDrilldown } from "../../lib/useDrilldown";
import { attrMatch } from "../../lib/drilldown";
import {
  DetailSection,
  DetailShell,
  LatencyChart,
  OpsTable,
  StatStrip,
} from "./DetailShell";
import { HttpPanelForSpans } from "./HttpPanel";
import { TracesTable } from "./TracesTable";

/**
 * Service node detail: all activity for one service — stats, latency
 * distribution, top operations, inbound/outbound dependencies (from the global
 * service map), the representative HTTP request, and recent traces. Drills down
 * by matching the `service.name` resource attribute so spans where this service
 * appears at any depth are included (not only traces it roots).
 */
export function ServiceDetail({
  service,
  map,
  tick,
  sinceMs,
  onBack,
  onOpenTrace,
  onOpenEdge,
}: {
  service: string;
  map: ServiceMap;
  tick: number;
  sinceMs?: number;
  onBack: () => void;
  onOpenTrace: (traceId: string) => void;
  onOpenEdge: (from: string, to: string) => void;
}) {
  // `service.name` is the resource attribute the SDK sets; matching it pulls
  // every span belonging to this service regardless of trace root.
  const dd = useDrilldown(
    {
      attrSearch: attrMatch("service.name", service),
      sinceMs,
      maxTraces: 80,
      spanFilter: (s) => s.service === service,
    },
    [service, tick, sinceMs],
  );

  const inbound = map.edges.filter((e) => e.to === service);
  const outbound = map.edges.filter((e) => e.from === service);

  return (
    <DetailShell
      title={service}
      subtitle="service"
      icon={
        <HugeiconsIcon icon={ConnectIcon} size={16} strokeWidth={1.75} className="text-primary" />
      }
      onBack={onBack}
    >
      {dd.capped && <CapNote />}
      <StatStrip stats={dd.stats} />

      <LatencyChart buckets={dd.histogram} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DetailSection title="Inbound dependencies" count={inbound.length}>
          <DepList
            edges={inbound.map((e) => ({ peer: e.from, ...e }))}
            onOpen={(peer) => onOpenEdge(peer, service)}
            emptyLabel="No inbound calls."
          />
        </DetailSection>
        <DetailSection title="Outbound dependencies" count={outbound.length}>
          <DepList
            edges={outbound.map((e) => ({ peer: e.to, ...e }))}
            onOpen={(peer) => onOpenEdge(service, peer)}
            emptyLabel="No outbound calls."
          />
        </DetailSection>
      </div>

      <HttpPanelForSpans spans={dd.spans} />

      <DetailSection title="Top operations" count={dd.ops.length}>
        <OpsTable ops={dd.ops} />
      </DetailSection>

      <DetailSection title="Recent traces" count={dd.traces.length}>
        <TracesTable traces={dd.traces} onOpenTrace={onOpenTrace} />
      </DetailSection>
    </DetailShell>
  );
}

type DepRow = {
  peer: string;
  calls: number;
  errors: number;
  p50Nano: number;
  p95Nano: number;
};

function DepList({
  edges,
  onOpen,
  emptyLabel,
}: {
  edges: DepRow[];
  onOpen: (peer: string) => void;
  emptyLabel: string;
}) {
  if (edges.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {edges
        .slice()
        .sort((a, b) => b.calls - a.calls)
        .map((e) => (
          <button
            key={e.peer}
            type="button"
            onClick={() => onOpen(e.peer)}
            className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/90">
              {e.peer}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {e.calls}× · p95 {fmtDuration(e.p95Nano)}
            </span>
            {e.errors > 0 && (
              <span className="shrink-0 rounded bg-destructive/10 px-1 font-mono text-[9.5px] text-destructive">
                {e.errors} err
              </span>
            )}
          </button>
        ))}
    </div>
  );
}

export function CapNote() {
  return (
    <p className={cn(
      "rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[10.5px] text-amber-500/90",
    )}>
      Showing a recent sample — the matched trace set was capped, so counts and
      percentiles reflect the most recent traces only.
    </p>
  );
}
