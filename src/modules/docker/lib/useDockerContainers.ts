import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/**
 * One container row from the backend `docker_list_containers` command. Mirrors
 * the Rust `DockerContainer` struct field-for-field (serde snake_case → these
 * names).
 */
export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  /** Raw status string, e.g. "Up 3 hours" or "Exited (0) 2 days ago". */
  status: string;
  /** "running" | "exited" | "paused" | "created" | … */
  state: string;
  /** Published ports as Docker prints them, e.g. "0.0.0.0:8080->80/tcp". */
  ports: string;
  created: string;
};

type State = {
  containers: DockerContainer[];
  loading: boolean;
  error: string | null;
};

/**
 * Loads Docker containers on mount and exposes a `reload` for the panel's
 * refresh button. Errors (docker missing, daemon down) are surfaced — not
 * thrown — so the panel renders an inline message. Includes stopped containers,
 * matching `docker ps -a`.
 *
 * When `host` is a `~/.ssh/config` alias (the user is connected to a remote
 * server), the backend targets that host's daemon via `docker -H ssh://<alias>`
 * instead of the local one. Passing a different `host` reloads automatically.
 */
export function useDockerContainers(host?: string | null) {
  const [state, setState] = useState<State>({
    containers: [],
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const containers = await invoke<DockerContainer[]>(
        "docker_list_containers",
        { host: host ?? null },
      );
      setState({ containers, loading: false, error: null });
    } catch (e) {
      setState({ containers: [], loading: false, error: String(e) });
    }
  }, [host]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * Inspect a single container, returning the raw `docker inspect` JSON object.
 * `host` targets a remote daemon over SSH when set (see `useDockerContainers`).
 */
export function inspectContainer(
  id: string,
  host?: string | null,
): Promise<unknown> {
  return invoke<unknown>("docker_inspect_container", { id, host: host ?? null });
}

/**
 * Fetch the last `tail` log lines (with timestamps) of a container. Merges the
 * container's stdout+stderr. `host` targets a remote daemon over SSH when set.
 */
export function dockerLogs(
  id: string,
  host?: string | null,
  tail = 1000,
): Promise<string> {
  return invoke<string>("docker_logs", { id, host: host ?? null, tail });
}

/**
 * One resource-usage snapshot. Mirrors the Rust `DockerStats` struct — all
 * fields are numbers (percent or bytes) ready to plot.
 */
export type DockerStats = {
  cpu_percent: number;
  mem_percent: number;
  mem_used: number;
  mem_limit: number;
  net_rx: number;
  net_tx: number;
  block_read: number;
  block_write: number;
  pids: number;
};

/** Fetch a single `docker stats` snapshot. `host` targets a remote daemon. */
export function dockerStats(
  id: string,
  host?: string | null,
): Promise<DockerStats> {
  return invoke<DockerStats>("docker_stats", { id, host: host ?? null });
}

/** One stored sample: a stats snapshot stamped with a monotonic time (ms). */
export type StatsSample = DockerStats & { t: number };

type StatsState = {
  samples: StatsSample[];
  /** True until the first sample lands. */
  loading: boolean;
  /** Last poll error (kept non-fatal so the graph keeps its history). */
  error: string | null;
};

/**
 * Poll `docker stats` on an interval and keep a sliding window of samples for
 * the live graphs. Polling pauses while the document is hidden (no point
 * hammering the daemon for an off-screen tab) and resumes on focus.
 *
 * @param id       container id/name
 * @param host     SSH alias for a remote daemon, or null for local
 * @param opts.intervalMs  poll period (default 2000)
 * @param opts.window      max samples retained (default 60 → ~2min at 2s)
 */
export function useDockerStats(
  id: string,
  host: string | null,
  opts?: { intervalMs?: number; window?: number },
) {
  const intervalMs = opts?.intervalMs ?? 2000;
  const windowSize = opts?.window ?? 60;
  const [state, setState] = useState<StatsState>({
    samples: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // performance.now() is monotonic — safe for plotting deltas/spacing even
    // if the wall clock jumps.
    const t0 = performance.now();

    const tick = async () => {
      try {
        const s = await dockerStats(id, host);
        if (cancelled) return;
        setState((prev) => {
          const sample: StatsSample = { ...s, t: performance.now() - t0 };
          const samples = [...prev.samples, sample].slice(-windowSize);
          return { samples, loading: false, error: null };
        });
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false, error: String(e) }));
      }
    };

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (document.visibilityState === "visible") await tick();
        if (!cancelled) schedule();
      }, intervalMs);
    };

    // Prime immediately, then poll.
    void tick();
    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [id, host, intervalMs, windowSize]);

  return state;
}

/** True when the container is currently running (drives the status dot color). */
export function isRunning(c: DockerContainer): boolean {
  return c.state.toLowerCase() === "running";
}

/** Strip the leading slash Docker prepends to container names. */
export function displayName(c: DockerContainer): string {
  return c.name.replace(/^\//, "");
}
