/** Render a pttl value (ms): -1 = no expiry, -2 = missing, else humanized. */
export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return "no expiry";
  if (ttlMs === -2) return "expired";
  if (ttlMs < 0) return "unknown";
  const s = Math.floor(ttlMs / 1000);
  if (s < 1) return `${ttlMs}ms`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Wall-clock ms to a HH:MM:SS.mmm timestamp for the pub/sub log. */
export function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}
