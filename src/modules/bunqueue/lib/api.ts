/**
 * Typed wrappers over the bunqueue HTTP API (server on 127.0.0.1:7890).
 *
 * Shapes mirror the server's JSON responses (verified against bunqueue
 * v2.7.15). Endpoints are read-only here except `enqueue`, which pushes jobs.
 */

import { get, post } from "./client";

// ── Dashboard overview (`GET /dashboard`) ──────────────────────────────────

export type DashboardStats = {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  dlq: number;
  totalPushed: number;
  totalPulled: number;
  totalCompleted: number;
  totalFailed: number;
  uptime: number;
};

export type Throughput = {
  pushPerSec: number;
  pullPerSec: number;
  completePerSec: number;
  failPerSec: number;
};

export type Percentiles = { p50: number; p95: number; p99: number };

export type Latency = {
  averages: { pushMs: number; pullMs: number; ackMs: number };
  percentiles: { push: Percentiles; pull: Percentiles; ack: Percentiles };
};

export type MemoryStats = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external?: number;
  arrayBuffers?: number;
};

export type Collections = Record<string, number>;

export type DashboardWorker = {
  id?: string;
  queue?: string;
  status?: string;
  [k: string]: unknown;
};

export type DashboardCron = {
  name?: string;
  pattern?: string;
  [k: string]: unknown;
};

export type DashboardOverview = {
  ok: boolean;
  stats: DashboardStats;
  throughput: Throughput;
  latency: Latency;
  memory: MemoryStats;
  collections: Collections;
  workers: { total: number; active: number; list: DashboardWorker[]; truncated: boolean };
  crons: { total: number; list: DashboardCron[]; truncated: boolean };
  storage: { diskFull: boolean; error: string | null; since: number | null };
  timestamp: number;
};

export const getDashboard = () => get<DashboardOverview>("/dashboard");

// ── Workers (`GET /workers`) ────────────────────────────────────────────────

export type ServerWorker = {
  id?: string;
  queue?: string;
  status?: string;
  processed?: number;
  failed?: number;
  [k: string]: unknown;
};

export type WorkersResponse = {
  ok: boolean;
  data: {
    workers: ServerWorker[];
    stats: {
      total: number;
      active: number;
      totalProcessed: number;
      totalFailed: number;
      activeJobs: number;
    };
  };
};

export const getWorkers = () => get<WorkersResponse>("/workers");

// ── Queues (`GET /queues`, detail, counts) ──────────────────────────────────

export type QueuesResponse = { ok: boolean; queues: string[] };
export const getQueues = () => get<QueuesResponse>("/queues");

export type QueueCounts = {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  "waiting-children": number;
  paused: number;
};
export type QueueCountsResponse = { ok: boolean; counts: QueueCounts };
export const getQueueCounts = (queue: string) =>
  get<QueueCountsResponse>(`/queues/${encodeURIComponent(queue)}/counts`);

export type QueueDetail = {
  ok: boolean;
  queue: string;
  [k: string]: unknown;
};
export const getQueueDetail = (queue: string, includeJobs = false) =>
  get<QueueDetail>(
    `/dashboard/queues/${encodeURIComponent(queue)}${includeJobs ? "?jobs=1" : ""}`,
  );

// ── Jobs (`GET /queues/:q/jobs/list`) ───────────────────────────────────────

export type JobRecord = {
  id: string;
  queue?: string;
  data?: unknown;
  state?: string;
  progress?: number;
  attempts?: number;
  maxAttempts?: number;
  priority?: number;
  createdAt?: number;
  runAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  [k: string]: unknown;
};

export type JobsListResponse = { ok: boolean; jobs: JobRecord[] };

export const getQueueJobs = (
  queue: string,
  opts?: { state?: string; limit?: number; offset?: number },
) => {
  const params = new URLSearchParams();
  if (opts?.state) params.set("state", opts.state);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return get<JobsListResponse>(
    `/queues/${encodeURIComponent(queue)}/jobs/list${qs ? `?${qs}` : ""}`,
  );
};

// ── DLQ (`GET /queues/:q/dlq/stats`) ────────────────────────────────────────

export type DlqStats = {
  ok?: boolean;
  total?: number;
  byReason?: Record<string, number>;
  [k: string]: unknown;
};
export const getDlqStats = (queue: string) =>
  get<DlqStats>(`/queues/${encodeURIComponent(queue)}/dlq/stats`);

// ── Enqueue (`POST /queues/:q/jobs`) ────────────────────────────────────────

export type EnqueueResult = { ok?: boolean; id?: string; [k: string]: unknown };

/** Push a job onto a queue. */
export const enqueue = (
  queue: string,
  name: string,
  data: unknown,
  opts?: Record<string, unknown>,
) =>
  post<EnqueueResult>(`/queues/${encodeURIComponent(queue)}/jobs`, {
    name,
    data,
    ...(opts ? { opts } : {}),
  });

// ── Convenience: github-create-issue ────────────────────────────────────────

export type CreateIssueJob = {
  /** "owner/name". Omit to derive from the git remote of `cwd`. */
  repo?: string;
  /** Repo working dir (active workspace). Required when `repo` is omitted. */
  cwd?: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
};

/**
 * Enqueue a GitHub issue-creation job for the github-create-issue worker.
 *
 * When `repo` is omitted, the worker resolves it from `cwd`'s git remote
 * (`origin`). If `cwd` is also omitted here, it defaults to the current
 * workspace directory so issues target the folder the user is working in.
 */
export const enqueueCreateIssue = async (job: CreateIssueJob) => {
  let cwd = job.cwd;
  if (!job.repo && !cwd) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      cwd = (await invoke<string>("workspace_current_dir")) || undefined;
    } catch {
      // Fall through; worker will error if neither repo nor cwd resolves.
    }
  }
  return enqueue("github-create-issue", "create-issue", { ...job, cwd });
};

// ── Convenience: http-request ───────────────────────────────────────────────

export type HttpRequestJob = {
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  timeoutMs?: number;
  redirect?: "follow" | "manual" | "error";
  maxBytes?: number;
  parseJson?: boolean;
};

/** Enqueue an HTTP request job for the http-request worker. */
export const enqueueHttpRequest = (job: HttpRequestJob) =>
  enqueue("http-request", "request", job);

/**
 * Enqueue a job that fetches this machine's public IP (via the http-request
 * worker hitting ipify). Result lands in the job's result as
 * `{ ..., json: { ip } }`.
 */
export const enqueueFetchOwnIp = () =>
  enqueueHttpRequest({
    url: "https://api.ipify.org",
    query: { format: "json" },
    timeoutMs: 10_000,
  });
