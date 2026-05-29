import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const LIMIT = 50;

/**
 * Live job-data inspector. Pick a queue + state, fetch its recent jobs, then
 * select a single job to render its `data` payload as a collapsible JSON tree.
 * Jobs for the selected queue/state are polled every 2.5s; the selected job's
 * payload updates in place if it's still in the refreshed list.
 */
export function SchemaSection({ queues }: { queues: string[] }) {
  const [queue, setQueue] = useState<string | null>(null);
  const [state, setState] = useState<JobState>("waiting");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default the queue selection to the first available queue.
  useEffect(() => {
    if (queue == null && queues.length > 0) setQueue(queues[0]);
    if (queue != null && !queues.includes(queue)) setQueue(queues[0] ?? null);
  }, [queues, queue]);

  // Poll jobs for the selected queue + state.
  useEffect(() => {
    if (!queue) {
      setJobs([]);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const res = await getQueueJobs(queue, { state, limit: LIMIT });
        if (!alive) return;
        const list = res.jobs ?? [];
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setJobs(list);
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

  // Keep a valid job selected: default to the first, drop if it vanished.
  useEffect(() => {
    if (jobs.length === 0) {
      setJobId(null);
      return;
    }
    if (jobId == null || !jobs.some((j) => j.id === jobId)) {
      setJobId(jobs[0].id);
    }
  }, [jobs, jobId]);

  const selected = useMemo(
    () => jobs.find((j) => j.id === jobId) ?? null,
    [jobs, jobId],
  );

  if (queues.length === 0) {
    return <EmptyHint>No queues yet. Enqueue a job to create one.</EmptyHint>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SectionTitle
        trailing={
          <span className="text-xs text-muted-foreground">
            {jobs.length} {state}
          </span>
        }
      >
        Schema
      </SectionTitle>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={queue ?? undefined} onValueChange={setQueue}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="queue" />
          </SelectTrigger>
          <SelectContent>
            {queues.map((q) => (
              <SelectItem key={q} value={q}>
                {q}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={state} onValueChange={(v) => setState(v as JobState)}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder="state" />
          </SelectTrigger>
          <SelectContent>
            {JOB_STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={jobId ?? undefined}
          onValueChange={setJobId}
          disabled={jobs.length === 0}
        >
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder="job" />
          </SelectTrigger>
          <SelectContent>
            {jobs.map((j) => (
              <SelectItem key={j.id} value={j.id}>
                <span className="font-mono text-[11px]">{j.id}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? <div className="text-xs text-destructive">{error}</div> : null}

      <ScrollArea className="min-h-0 flex-1">
        {selected == null ? (
          <EmptyHint>No {state} jobs in this queue.</EmptyHint>
        ) : (
          <div className="flex flex-col gap-2 pr-2">
            <JobMeta job={selected} />
            <div className="rounded-lg bg-muted/40 p-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                data
              </div>
              <JsonTree value={selected.data} />
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function JobMeta({ job }: { job: JobRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="text-[10px]">
        {job.queue ?? "?"}
      </Badge>
      <span className="truncate font-mono text-[11px]">{job.id}</span>
      <Badge variant="outline" className="text-[10px]">
        {job.state ?? "?"}
      </Badge>
      {typeof job.attempts === "number" && (
        <span className="text-[10px] text-muted-foreground">
          {job.attempts}/{job.maxAttempts ?? "?"}
        </span>
      )}
    </div>
  );
}

// ── JSON tree renderer ──────────────────────────────────────────────────────

/** Recursively render an arbitrary JSON value as a collapsible tree. */
function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-[11px] leading-relaxed">
      <JsonNode value={value} depth={0} />
    </div>
  );
}

function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <Leaf className="text-muted-foreground">null</Leaf>;
  if (value === undefined)
    return <Leaf className="text-muted-foreground">undefined</Leaf>;

  const t = typeof value;
  if (t === "string") return <Leaf className="text-emerald-600 dark:text-emerald-400">{JSON.stringify(value)}</Leaf>;
  if (t === "number" || t === "bigint")
    return <Leaf className="text-sky-600 dark:text-sky-400">{String(value)}</Leaf>;
  if (t === "boolean")
    return <Leaf className="text-amber-600 dark:text-amber-400">{String(value)}</Leaf>;

  if (Array.isArray(value)) {
    return <Collapsible open="[" close="]" entries={value.map((v, i) => [String(i), v])} depth={depth} />;
  }
  if (t === "object") {
    return (
      <Collapsible
        open="{"
        close="}"
        entries={Object.entries(value as Record<string, unknown>)}
        depth={depth}
      />
    );
  }
  return <Leaf className="text-muted-foreground">{String(value)}</Leaf>;
}

function Leaf({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("break-all", className)}>{children}</span>;
}

function Collapsible({
  open,
  close,
  entries,
  depth,
}: {
  open: string;
  close: string;
  entries: [string, unknown][];
  depth: number;
}) {
  // Collapse deep / large containers by default to keep payloads scannable.
  const [collapsed, setCollapsed] = useState(depth > 1 && entries.length > 0);

  if (entries.length === 0) {
    return (
      <span className="text-muted-foreground">
        {open}
        {close}
      </span>
    );
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="text-muted-foreground hover:text-foreground"
      >
        {open}…{close} <span className="text-[10px]">({entries.length})</span>
      </button>
    );
  }

  return (
    <span>
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="text-muted-foreground hover:text-foreground"
      >
        {open}
      </button>
      <div className="border-l border-border/40 pl-3">
        {entries.map(([k, v]) => (
          <div key={k}>
            <span className="text-foreground/80">{k}</span>
            <span className="text-muted-foreground">: </span>
            <JsonNode value={v} depth={depth + 1} />
          </div>
        ))}
      </div>
      <span className="text-muted-foreground">{close}</span>
    </span>
  );
}
