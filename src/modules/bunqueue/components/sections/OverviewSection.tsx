import { ScrollArea } from "@/components/ui/scroll-area";
import type { DashboardOverview } from "../../lib/api";
import { Stat, SectionTitle, formatBytesMB, EmptyHint } from "../parts";

/**
 * Deep stats / resources view built from GET /dashboard: job counters,
 * throughput, latency percentiles, memory, and internal collection sizes.
 */
export function OverviewSection({
  overview,
}: {
  overview: DashboardOverview | null;
}) {
  if (!overview) {
    return <EmptyHint>No data yet — is the server running?</EmptyHint>;
  }

  const { stats, throughput, latency, memory, collections, storage } = overview;
  const pct = latency.percentiles;
  const collectionEntries = Object.entries(collections).filter(
    ([, v]) => typeof v === "number",
  );

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 pr-3">
        <section className="flex flex-col gap-2">
          <SectionTitle>Jobs</SectionTitle>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat label="Waiting" value={stats.waiting} />
            <Stat label="Active" value={stats.active} />
            <Stat label="Delayed" value={stats.delayed} />
            <Stat label="Completed" value={stats.completed} />
            <Stat label="DLQ" value={stats.dlq} />
            <Stat
              label="Failed"
              value={stats.totalFailed}
            />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
            <Stat label="Pushed (total)" value={stats.totalPushed} />
            <Stat label="Pulled (total)" value={stats.totalPulled} />
            <Stat label="Completed (total)" value={stats.totalCompleted} />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Throughput / sec</SectionTitle>
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Push" value={throughput.pushPerSec} />
            <Stat label="Pull" value={throughput.pullPerSec} />
            <Stat label="Complete" value={throughput.completePerSec} />
            <Stat label="Fail" value={throughput.failPerSec} />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Latency (ms)</SectionTitle>
          <div className="overflow-hidden rounded-xl border border-border/60">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Op</th>
                  <th className="px-3 py-1.5 text-right font-medium">avg</th>
                  <th className="px-3 py-1.5 text-right font-medium">p50</th>
                  <th className="px-3 py-1.5 text-right font-medium">p95</th>
                  <th className="px-3 py-1.5 text-right font-medium">p99</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                <LatencyRow
                  op="push"
                  avg={latency.averages.pushMs}
                  p={pct.push}
                />
                <LatencyRow
                  op="pull"
                  avg={latency.averages.pullMs}
                  p={pct.pull}
                />
                <LatencyRow op="ack" avg={latency.averages.ackMs} p={pct.ack} />
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>Memory</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Heap used" value={formatBytesMB(memory.heapUsed)} />
            <Stat label="Heap total" value={formatBytesMB(memory.heapTotal)} />
            <Stat label="RSS" value={formatBytesMB(memory.rss)} />
          </div>
        </section>

        {collectionEntries.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionTitle>Collections</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {collectionEntries.map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between rounded-lg bg-muted/30 px-2.5 py-1 text-[11px]"
                >
                  <span className="truncate text-muted-foreground">{k}</span>
                  <span className="font-mono tabular-nums">{v as number}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {storage.diskFull && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Disk full{storage.error ? `: ${storage.error}` : ""}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function LatencyRow({
  op,
  avg,
  p,
}: {
  op: string;
  avg: number;
  p: { p50: number; p95: number; p99: number };
}) {
  return (
    <tr className="border-t border-border/40">
      <td className="px-3 py-1.5 text-left">{op}</td>
      <td className="px-3 py-1.5 text-right">{avg}</td>
      <td className="px-3 py-1.5 text-right">{p.p50}</td>
      <td className="px-3 py-1.5 text-right">{p.p95}</td>
      <td className="px-3 py-1.5 text-right">{p.p99}</td>
    </tr>
  );
}
