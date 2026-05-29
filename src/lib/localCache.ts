/**
 * Tiny versioned localStorage cache for expensive, recomputable data (e.g. the
 * agentlytics / ccusage on-disk scans). Values are JSON-serialized under a
 * versioned key so a shape change invalidates stale entries automatically,
 * and a `savedAt` timestamp lets callers show "last synced" / age.
 *
 * Reads never throw: a corrupt entry, a quota error, or a missing `window`
 * (e.g. a worker without DOM storage) all degrade to `null` / no-op so the
 * cache is purely an optimization layer over the real source of truth (Rust).
 */

/** A cache entry plus when it was written (epoch ms). */
export type Cached<T> = {
  value: T;
  /** Epoch ms when this entry was persisted. */
  savedAt: number;
};

/** Namespace every key so a schema bump silently discards old payloads. */
function fullKey(key: string, version: number): string {
  return `terax-cache:v${version}:${key}`;
}

/** Read a cached value, or `null` when absent/corrupt/unavailable. */
export function readCache<T>(key: string, version: number): Cached<T> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(fullKey(key, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      typeof parsed.savedAt !== "number" ||
      !("value" in parsed)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a value with the current time; failures are swallowed. */
export function writeCache<T>(
  key: string,
  version: number,
  value: T,
  nowMs: number,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    const entry: Cached<T> = { value, savedAt: nowMs };
    localStorage.setItem(fullKey(key, version), JSON.stringify(entry));
  } catch {
    /* quota / serialization — cache is best-effort */
  }
}
