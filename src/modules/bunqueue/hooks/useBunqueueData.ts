import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDashboard,
  getWorkers,
  getQueues,
  type DashboardOverview,
  type WorkersResponse,
} from "../lib/api";
import { bunqueueNative, type BunqueueWorkerInfo } from "../lib/native";

const POLL_MS = 2000;

export type BunqueueData = {
  /** Aggregate overview from GET /dashboard (stats, throughput, latency, …). */
  overview: DashboardOverview | null;
  /** Server-reported worker registry (GET /workers). */
  serverWorkers: WorkersResponse["data"] | null;
  /** Queue names (GET /queues). */
  queues: string[];
  /** Terax-spawned worker processes (Rust backend). */
  procWorkers: BunqueueWorkerInfo[];
  /** True once the first poll resolved. */
  loaded: boolean;
  /** Last poll error, if any. */
  error: string | null;
  refresh: () => void;
};

/**
 * Polls the bunqueue HTTP API + the Rust worker-process status every 2s.
 * All four sources update together; a failure in one doesn't blank the others.
 */
export function useBunqueueData(enabled = true): BunqueueData {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [serverWorkers, setServerWorkers] =
    useState<WorkersResponse["data"] | null>(null);
  const [queues, setQueues] = useState<string[]>([]);
  const [procWorkers, setProcWorkers] = useState<BunqueueWorkerInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef(0);

  const poll = useCallback(async () => {
    const [ov, wk, qs, pw] = await Promise.allSettled([
      getDashboard(),
      getWorkers(),
      getQueues(),
      bunqueueNative.workers(),
    ]);
    if (ov.status === "fulfilled") setOverview(ov.value);
    if (wk.status === "fulfilled") setServerWorkers(wk.value.data);
    if (qs.status === "fulfilled") setQueues(qs.value.queues ?? []);
    if (pw.status === "fulfilled") setProcWorkers(pw.value);

    const firstErr = [ov, wk, qs, pw].find((r) => r.status === "rejected");
    setError(
      firstErr && firstErr.status === "rejected"
        ? String(firstErr.reason)
        : null,
    );
    setLoaded(true);
  }, []);

  // Bump tickRef to force an immediate refresh between intervals.
  const refresh = useCallback(() => {
    tickRef.current += 1;
    void poll();
  }, [poll]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = () => {
      if (alive) void poll();
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, poll]);

  return {
    overview,
    serverWorkers,
    queues,
    procWorkers,
    loaded,
    error,
    refresh,
  };
}
