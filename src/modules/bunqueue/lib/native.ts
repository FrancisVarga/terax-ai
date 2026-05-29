import { invoke } from "@tauri-apps/api/core";

/**
 * Status of the embedded bunqueue server process. Mirrors the Rust
 * `BunqueueStatus` struct (serde camelCase via field names).
 */
export type BunqueueStatus = {
  /** True when the child is spawned and has not exited. */
  running: boolean;
  /** Launch command line, for diagnostics. */
  command: string | null;
  tcp_port: number | null;
  http_port: number | null;
  /** HTTP base URL of the running server, e.g. http://127.0.0.1:6790. */
  http_url: string | null;
  /** Persistent SQLite path, or null when running in-memory. */
  data_path: string | null;
  started_at_ms: number | null;
  exited: boolean;
  exit_code: number | null;
};

export type BunqueueLogResponse = {
  bytes: string;
  next_offset: number;
  dropped: number;
  exited: boolean;
  exit_code: number | null;
};

/**
 * A worker process Terax spawns (the Bun child that consumes a queue), as
 * reported by the Rust backend. Distinct from the worker registry the bunqueue
 * server exposes over HTTP (`GET /workers`).
 */
export type BunqueueWorkerInfo = {
  name: string;
  queue: string;
  /** Worker script path, relative to project root. */
  script: string;
  command: string | null;
  running: boolean;
  started_at_ms: number | null;
  exited: boolean;
  exit_code: number | null;
};

/**
 * Thin wrappers over the Tauri commands that manage the bunqueue server
 * lifecycle (spawn/kill happens in Rust — the browser cannot fork processes).
 */
export const bunqueueNative = {
  status: () => invoke<BunqueueStatus>("bunqueue_status"),
  logs: (sinceOffset?: number) =>
    invoke<BunqueueLogResponse>("bunqueue_logs", {
      sinceOffset: sinceOffset ?? null,
    }),
  restart: () => invoke<BunqueueStatus>("bunqueue_restart"),
  /** Idempotently start the server + workers if not already running. */
  ensure: () => invoke<BunqueueStatus>("bunqueue_ensure"),
  /** Status of the Bun worker processes Terax spawned. */
  workers: () => invoke<BunqueueWorkerInfo[]>("bunqueue_workers"),
};
