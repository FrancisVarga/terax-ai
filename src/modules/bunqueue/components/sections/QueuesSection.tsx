import { useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getQueueCounts,
  getQueueJobs,
  type QueueCounts,
  type JobRecord,
} from "../../lib/api";
import { SectionTitle, EmptyHint, Stat } from "../parts";

const JOB_STATES = ["waiting", "active", "completed", "failed", "delayed"] as const;

/**
 * Queues list with per-queue counts, plus a job viewer for the selected queue.
 * Counts and jobs are fetched on demand when a queue is selected.
 */
export function QueuesSection({ queues }: { queues: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);

  // Auto-select the first queue once available.
  useEffect(() => {
    if (selected == null && queues.length > 0) setSelected(queues[0]);
  }, [queues, selected]);

  if (queues.length === 0) {
    return <EmptyHint>No queues yet. Enqueue a job to create one.</EmptyHint>;
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="w-44 shrink-0">
        <SectionTitle>Queues</SectionTitle>
        <ScrollArea className="mt-2 h-[calc(100%-1.5rem)]">
          <div className="flex flex-col gap-1 pr-2">
            {queues.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setSelected(q)}
                className={cn(
                  "truncate rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                  selected === q
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                {q}
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>
      <div className="min-w-0 flex-1">
        {selected ? <QueueDetail queue={selected} /> : null}
      </div>
    </div>
  );
}

function QueueDetail({ queue }: { queue: string }) {
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [state, setState] = useState<(typeof JOB_STATES)[number]>("waiting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [c, j] = await Promise.all([
          getQueueCounts(queue),
          getQueueJobs(queue, { state, limit: 50 }),
        ]);
        if (!alive) return;
        setCounts(c.counts);
        setJobs(j.jobs ?? []);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    const id = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queue, state]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {counts && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          <Stat label="Waiting" value={counts.waiting} />
          <Stat label="Active" value={counts.active} />
          <Stat label="Delayed" value={counts.delayed} />
          <Stat label="Completed" value={counts.completed} />
          <Stat label="Failed" value={counts.failed} />
          <Stat label="Paused" value={counts.paused} />
        </div>
      )}

      <div className="flex items-center gap-1">
        {JOB_STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
              state === s
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {error ? (
        <div className="text-xs text-destructive">{error}</div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {jobs.length === 0 ? (
          <EmptyHint>No {state} jobs.</EmptyHint>
        ) : (
          <div className="flex flex-col gap-1 pr-2">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function JobRow({ job }: { job: JobRecord }) {
  const data =
    typeof job.data === "object" ? JSON.stringify(job.data) : String(job.data ?? "");
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px]">{job.id}</span>
        <div className="flex items-center gap-1.5">
          {typeof job.attempts === "number" && (
            <span className="text-[10px] text-muted-foreground">
              {job.attempts}/{job.maxAttempts ?? "?"}
            </span>
          )}
          <Badge variant="outline" className="text-[10px]">
            {job.state ?? "?"}
          </Badge>
        </div>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
        {data}
      </div>
    </div>
  );
}
