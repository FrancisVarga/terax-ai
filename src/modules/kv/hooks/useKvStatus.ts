import { useCallback, useEffect, useRef, useState } from "react";
import { kvNative, type KvStatus, type KvLogResponse } from "../lib/native";

const STATUS_POLL_MS = 2000;
const LOG_POLL_MS = 1000;
/** Cap retained log text so a long-lived dashboard can't grow unbounded. */
const MAX_LOG_CHARS = 256 * 1024;

export type UseKvStatus = {
  status: KvStatus | null;
  logs: string;
  /** Bytes dropped from the server-side ring buffer since we started tailing. */
  dropped: number;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  restart: () => Promise<void>;
  refresh: () => Promise<void>;
  clearLogs: () => void;
};

/**
 * Polls the embedded KV server's process status and tails its log ring buffer.
 * Status and logs poll on independent intervals; log reads are incremental via
 * the server's monotonic `next_offset`.
 */
export function useKvStatus(): UseKvStatus {
  const [status, setStatus] = useState<KvStatus | null>(null);
  const [logs, setLogs] = useState("");
  const [dropped, setDropped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s = await kvNative.status();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await kvNative.status();
        if (alive) setStatus(s);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void tick();
    const id = setInterval(tick, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res: KvLogResponse = await kvNative.logs(offsetRef.current);
        if (!alive) return;
        offsetRef.current = res.next_offset;
        if (res.dropped) setDropped((d) => d + res.dropped);
        if (res.bytes) {
          setLogs((prev) => {
            const next = prev + res.bytes;
            return next.length > MAX_LOG_CHARS
              ? next.slice(next.length - MAX_LOG_CHARS)
              : next;
          });
        }
      } catch {
        // Transient; next tick retries.
      }
    };
    void tick();
    const id = setInterval(tick, LOG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await kvNative.setEnabled(true);
      const s = await kvNative.ensure();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await kvNative.setEnabled(false);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const restart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await kvNative.restart();
      offsetRef.current = 0;
      setLogs("");
      setDropped(0);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogs("");
    setDropped(0);
  }, []);

  return {
    status,
    logs,
    dropped,
    busy,
    error,
    enable,
    disable,
    restart,
    refresh,
    clearLogs,
  };
}
