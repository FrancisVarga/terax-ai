import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * Status of the embedded KV (Redis-compatible) server process. Mirrors the Rust
 * `KvStatus` struct (serde camelCase via field names).
 */
export type KvStatus = {
  /** True when the server is reachable and has not exited. */
  running: boolean;
  /** Launch command line, for diagnostics. */
  command: string | null;
  port: number;
  /** Connection URL, e.g. redis://127.0.0.1:6379. */
  url: string;
  /** Persistent data dir, or null when running in-memory. */
  data_path: string | null;
  /** True when backed by a spawned sidecar child, false for the in-process fallback. */
  sidecar: boolean;
  /** True when a password (requirepass) is configured. */
  auth: boolean;
  started_at_ms: number | null;
  exited: boolean;
  exit_code: number | null;
};

export type KvLogResponse = {
  bytes: string;
  next_offset: number;
  dropped: number;
  exited: boolean;
};

/** One key's metadata from a SCAN page. `ttl_ms`: -1 = no expiry, -2 = missing. */
export type KvKeyInfo = {
  key: string;
  type: string;
  ttl_ms: number;
};

export type KvScanPage = {
  /** Next SCAN cursor; 0 means iteration is complete. */
  cursor: number;
  keys: KvKeyInfo[];
};

export type KvValue = {
  value: string;
  type: string;
  ttl_ms: number;
};

/** A pub/sub message streamed from the backend subscriber connection. */
export type KvPubSubEvent = {
  channel: string;
  payload: string;
  at_ms: number;
};

/**
 * Thin wrappers over the Tauri commands that manage the embedded KV server
 * lifecycle and data (spawn/kill and the Redis connection live in Rust).
 */
export const kvNative = {
  status: () => invoke<KvStatus>("kv_status"),
  logs: (sinceOffset?: number) =>
    invoke<KvLogResponse>("kv_logs", { sinceOffset: sinceOffset ?? null }),
  /** Idempotently start the server if not already running. No-op while disabled. */
  ensure: () => invoke<KvStatus>("kv_ensure"),
  /** Enable/disable the server at runtime. Persisting the pref is the caller's job. */
  setEnabled: (enabled: boolean) =>
    invoke<KvStatus>("kv_set_enabled", { enabled }),
  restart: () => invoke<KvStatus>("kv_restart"),
  /** Change the listen port (errors if port < 1024). Persisting is the caller's job. */
  setPort: (port: number) => invoke<KvStatus>("kv_set_port", { port }),

  data: {
    scan: (cursor: number, pattern?: string, count?: number) =>
      invoke<KvScanPage>("kv_data_scan", {
        cursor,
        pattern: pattern ?? null,
        count: count ?? null,
      }),
    get: (key: string) => invoke<KvValue | null>("kv_data_get", { key }),
    /** Create/update a string key, with an optional TTL in ms. */
    set: (key: string, value: string, ttlMs?: number) =>
      invoke<null>("kv_data_set", { key, value, ttlMs: ttlMs ?? null }),
    /** Set (ttlMs) or clear (omit/null = PERSIST) a key's TTL. Returns false if missing. */
    expire: (key: string, ttlMs?: number) =>
      invoke<boolean>("kv_data_expire", { key, ttlMs: ttlMs ?? null }),
    /** Delete keys; returns how many were removed. */
    del: (keys: string[]) => invoke<number>("kv_data_del", { keys }),
    flushdb: () => invoke<null>("kv_data_flushdb"),
    dbsize: () => invoke<number>("kv_data_dbsize"),
    /** Publish a message; returns the number of receivers. */
    publish: (channel: string, message: string) =>
      invoke<number>("kv_data_publish", { channel, message }),
    /** Subscribe to channels; messages stream to `onEvent` until the channel is dropped. */
    subscribe: (channels: string[], onEvent: Channel<KvPubSubEvent>) =>
      invoke<null>("kv_data_subscribe", { channels, onEvent }),
  },
};
