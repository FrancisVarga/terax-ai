import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { BunqueueWorkerInfo } from "../../lib/native";
import type { WorkersResponse } from "../../lib/api";
import { SectionTitle, Stat, EmptyHint, formatDuration } from "../parts";

/**
 * Two views of workers:
 *  - process workers: the Bun children Terax spawned (lifecycle owned by Rust)
 *  - server registry: workers the bunqueue server sees connected (GET /workers)
 */
export function WorkersSection({
  procWorkers,
  serverWorkers,
  now,
}: {
  procWorkers: BunqueueWorkerInfo[];
  serverWorkers: WorkersResponse["data"] | null;
  now: number;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 pr-3">
        <section className="flex flex-col gap-2">
          <SectionTitle trailing={<span className="text-xs text-muted-foreground">{procWorkers.length}</span>}>
            Process workers
          </SectionTitle>
          {procWorkers.length === 0 ? (
            <EmptyHint>No worker processes registered.</EmptyHint>
          ) : (
            <div className="flex flex-col gap-1.5">
              {procWorkers.map((w) => (
                <div
                  key={w.name}
                  className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {w.name}
                      </span>
                      <WorkerBadge worker={w} />
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      queue: <span className="font-mono">{w.queue}</span>
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-muted-foreground">
                    {w.running && w.started_at_ms != null
                      ? formatDuration(now - w.started_at_ms)
                      : w.exited
                        ? `exit ${w.exit_code ?? "?"}`
                        : "—"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {serverWorkers && (
          <section className="flex flex-col gap-2">
            <SectionTitle>Server registry</SectionTitle>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              <Stat label="Total" value={serverWorkers.stats.total} />
              <Stat label="Active" value={serverWorkers.stats.active} />
              <Stat label="Active jobs" value={serverWorkers.stats.activeJobs} />
              <Stat label="Processed" value={serverWorkers.stats.totalProcessed} />
              <Stat label="Failed" value={serverWorkers.stats.totalFailed} />
            </div>
            {serverWorkers.workers.length === 0 ? (
              <EmptyHint>No workers connected to the server.</EmptyHint>
            ) : (
              <div className="flex flex-col gap-1">
                {serverWorkers.workers.map((sw, i) => (
                  <div
                    key={String(sw.id ?? i)}
                    className="flex items-center justify-between rounded-lg bg-muted/30 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="truncate font-mono">
                      {String(sw.id ?? "worker")}
                    </span>
                    <span className="text-muted-foreground">
                      {String(sw.queue ?? "")} · {String(sw.status ?? "")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

function WorkerBadge({ worker }: { worker: BunqueueWorkerInfo }) {
  if (worker.running) {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        running
      </Badge>
    );
  }
  if (worker.exited) {
    return <Badge variant="destructive">exited</Badge>;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      idle
    </Badge>
  );
}
