import { useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getQueueJobs, type JobRecord } from "../../lib/api";
import { SectionTitle, EmptyHint } from "../parts";

const JOB_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
] as const;
type JobState = (typeof JOB_STATES)[number];

const PER_QUEUE_LIMIT = 25;

type Row = JobRecord & { _queue: string };

/**
 * Recent jobs across all queues for a chosen state. Fans out one jobs/list
 * call per queue and merges, newest first. Polls every 2.5s.
 */
export function JobsSection({ queues }: { queues: string[] }) {
  const [state, setState] = useState<JobState>("waiting");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (queues.length === 0) {
      setRows([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const results = await Promise.allSettled(
          queues.map((q) =>
            getQueueJobs(q, { state, limit: PER_QUEUE_LIMIT }).then((r) =>
              (r.jobs ?? []).map((j) => ({ ...j, _queue: q })),
            ),
          ),
        );
        if (!alive) return;
        const merged: Row[] = results.flatMap((r) =>
          r.status === "fulfilled" ? r.value : [],
        );
        merged.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setRows(merged);
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
  }, [queues, state]);

  if (queues.length === 0) {
    return <EmptyHint>No queues yet. Enqueue a job to create one.</EmptyHint>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SectionTitle
        trailing={
          <span className="text-xs text-muted-foreground">{rows.length}</span>
        }
      >
        Jobs
      </SectionTitle>

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

      {error ? <div className="text-xs text-destructive">{error}</div> : null}

      <ScrollArea className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <EmptyHint>No {state} jobs across queues.</EmptyHint>
        ) : (
          <div className="flex flex-col gap-1 pr-2">
            {rows.map((job) => (
              <JobRow key={`${job._queue}:${job.id}`} job={job} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function JobRow({ job }: { job: Row }) {
  const data =
    typeof job.data === "object"
      ? JSON.stringify(job.data)
      : String(job.data ?? "");
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {job._queue}
          </Badge>
          <span className="truncate font-mono text-[11px]">{job.id}</span>
        </div>
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
