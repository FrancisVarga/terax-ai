import { useCallback, useEffect, useRef, useState } from "react";
import {
  bunqueueNative,
  type BunqueueStatus,
  type BunqueueLogResponse,
} from "../lib/native";
import { invalidateBaseUrl } from "../lib/client";

const STATUS_POLL_MS = 2000;
const LOG_POLL_MS = 1000;
/** Cap retained log text so a long-lived dashboard can't grow unbounded. */
const MAX_LOG_CHARS = 256 * 1024;

export type UseBunqueue = {
  status: BunqueueStatus | null;
  logs: string;
  /** Bytes dropped from the server-side ring buffer since we started tailing. */
  dropped: number;
  restarting: boolean;
  error: string | null;
  restart: () => Promise<void>;
  clearLogs: () => void;
};

/**
 * Polls the embedded bunqueue server's process status and tails its log ring
 * buffer. Status and logs poll on independent intervals; log reads are
 * incremental via the server's monotonic `next_offset`.
 */
export function useBunqueue(): UseBunqueue {
  const [status, setStatus] = useState<BunqueueStatus | null>(null);
  const [logs, setLogs] = useState("");
  const [dropped, setDropped] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Offset cursor for incremental log tailing — a ref so the interval closure
  // always reads the latest value without re-subscribing.
  const offsetRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await bunqueueNative.status();
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
        const res: BunqueueLogResponse = await bunqueueNative.logs(
          offsetRef.current,
        );
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
        // Transient — next tick retries.
      }
    };
    void tick();
    const id = setInterval(tick, LOG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const restart = useCallback(async () => {
    setRestarting(true);
    setError(null);
    try {
      const s = await bunqueueNative.restart();
      // Reset log cursor: restart spawns a fresh child with a fresh buffer.
      offsetRef.current = 0;
      setLogs("");
      setDropped(0);
      invalidateBaseUrl();
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setRestarting(false);
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogs("");
    setDropped(0);
  }, []);

  return { status, logs, dropped, restarting, error, restart, clearLogs };
}
