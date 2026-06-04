import { useCallback, useEffect, useRef, useState } from "react";
import { kvNative, type KvKeyInfo, type KvValue } from "../lib/native";

const SCAN_COUNT = 100;

export type UseKvData = {
  keys: KvKeyInfo[];
  /** True while a SCAN page is in flight. */
  loading: boolean;
  /** False once the cursor returns to 0 (iteration complete). */
  hasMore: boolean;
  pattern: string;
  dbsize: number | null;
  selectedKey: string | null;
  selectedValue: KvValue | null;
  valueLoading: boolean;
  error: string | null;
  setPattern: (p: string) => void;
  /** Re-run SCAN from cursor 0 with the current pattern, and refresh DBSIZE. */
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  select: (key: string | null) => Promise<void>;
  save: (key: string, value: string, ttlMs?: number) => Promise<void>;
  setTtl: (key: string, ttlMs?: number) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
  flushAll: () => Promise<void>;
};

/**
 * Owns the KV key list (paginated SCAN cursor), the selected key's value, and
 * the data CRUD actions. The dashboard is the imperative shell; mutations here
 * keep the list and selection consistent after each write.
 */
export function useKvData(running: boolean): UseKvData {
  const [keys, setKeys] = useState<KvKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [pattern, setPatternState] = useState("");
  const [dbsize, setDbsize] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<KvValue | null>(null);
  const [valueLoading, setValueLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SCAN cursor; -1 marks "not started", 0 (after a page) marks "complete".
  const cursorRef = useRef<number>(-1);
  const patternRef = useRef("");
  const [hasMore, setHasMore] = useState(true);

  const scanPage = useCallback(async (fromStart: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const cursor = fromStart ? 0 : cursorRef.current === -1 ? 0 : cursorRef.current;
      const pat = patternRef.current.trim() || undefined;
      const page = await kvNative.data.scan(cursor, pat, SCAN_COUNT);
      cursorRef.current = page.cursor;
      setHasMore(page.cursor !== 0);
      setKeys((prev) => (fromStart ? page.keys : [...prev, ...page.keys]));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    cursorRef.current = 0;
    setKeys([]);
    setHasMore(true);
    await scanPage(true);
    try {
      setDbsize(await kvNative.data.dbsize());
    } catch {
      // Non-fatal; count is informational.
    }
  }, [scanPage]);

  // Reload whenever the server comes up or the pattern changes.
  useEffect(() => {
    if (!running) {
      setKeys([]);
      setDbsize(null);
      cursorRef.current = -1;
      setHasMore(true);
      return;
    }
    void reload();
  }, [running, pattern, reload]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await scanPage(false);
  }, [hasMore, loading, scanPage]);

  const setPattern = useCallback((p: string) => {
    patternRef.current = p;
    setPatternState(p);
  }, []);

  const select = useCallback(async (key: string | null) => {
    setSelectedKey(key);
    if (key === null) {
      setSelectedValue(null);
      return;
    }
    setValueLoading(true);
    setError(null);
    try {
      const v = await kvNative.data.get(key);
      setSelectedValue(v);
    } catch (e) {
      setError(String(e));
      setSelectedValue(null);
    } finally {
      setValueLoading(false);
    }
  }, []);

  const save = useCallback(
    async (key: string, value: string, ttlMs?: number) => {
      setError(null);
      try {
        await kvNative.data.set(key, value, ttlMs);
        await reload();
        await select(key);
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [reload, select],
  );

  const setTtl = useCallback(
    async (key: string, ttlMs?: number) => {
      setError(null);
      try {
        await kvNative.data.expire(key, ttlMs);
        if (key === selectedKey) await select(key);
        else await reload();
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [reload, select, selectedKey],
  );

  const remove = useCallback(
    async (toDelete: string[]) => {
      setError(null);
      try {
        await kvNative.data.del(toDelete);
        if (selectedKey && toDelete.includes(selectedKey)) {
          await select(null);
        }
        await reload();
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [reload, select, selectedKey],
  );

  const flushAll = useCallback(async () => {
    setError(null);
    try {
      await kvNative.data.flushdb();
      await select(null);
      await reload();
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, [reload, select]);

  return {
    keys,
    loading,
    hasMore,
    pattern,
    dbsize,
    selectedKey,
    selectedValue,
    valueLoading,
    error,
    setPattern,
    reload,
    loadMore,
    select,
    save,
    setTtl,
    remove,
    flushAll,
  };
}
