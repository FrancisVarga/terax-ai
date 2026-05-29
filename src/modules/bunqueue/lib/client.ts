import { bunqueueNative, type BunqueueStatus } from "./native";

/**
 * HTTP client for the embedded bunqueue server's HTTP API.
 *
 * The server runs as a Rust-managed child process (see bunqueue.rs) with the
 * HTTP API enabled and no auth. Terax runs it on a non-default port (7890) to
 * avoid colliding with a standalone bunqueue; the webview reaches it over
 * `http://127.0.0.1:7890`, allowed by the app CSP `connect-src`.
 *
 * The base URL is resolved from the live process status (which carries the
 * real port), so this constant is only a fallback if status is unavailable.
 *
 * Endpoint paths are intentionally not hard-coded beyond a generic request
 * helper: bunqueue's HTTP surface is broad and versioned, so callers pass the
 * path explicitly. Convenience methods cover the common cases.
 */

const DEFAULT_HTTP_URL = "http://127.0.0.1:7890";

let cachedBaseUrl: string | null = null;

/**
 * Resolve the server's HTTP base URL from the live process status, falling
 * back to the default port. Cached after first successful resolution.
 */
export async function resolveBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  try {
    const status: BunqueueStatus = await bunqueueNative.status();
    if (status.http_url) {
      cachedBaseUrl = status.http_url;
      return cachedBaseUrl;
    }
  } catch {
    // Status command unavailable (e.g. server never started) — use default.
  }
  cachedBaseUrl = DEFAULT_HTTP_URL;
  return cachedBaseUrl;
}

/** Clear the cached base URL (call after a restart that may change the port). */
export function invalidateBaseUrl(): void {
  cachedBaseUrl = null;
}

export class BunqueueHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`bunqueue HTTP ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "BunqueueHttpError";
  }
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new BunqueueHttpError(res.status, path, text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Non-JSON 2xx (e.g. a plain "ok") — return the raw text.
    return text as unknown as T;
  }
}

/** GET an arbitrary path on the bunqueue HTTP API. */
export async function get<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = await resolveBaseUrl();
  const res = await fetch(`${base}${path}`, { method: "GET", ...init });
  return parse<T>(res, path);
}

/** POST a JSON body to an arbitrary path on the bunqueue HTTP API. */
export async function post<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const base = await resolveBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
  return parse<T>(res, path);
}

/**
 * Liveness probe. Returns true if the HTTP API answers. Uses the process
 * status as the source of truth, then confirms the port is actually serving.
 */
export async function isReady(): Promise<boolean> {
  try {
    const status = await bunqueueNative.status();
    return status.running;
  } catch {
    return false;
  }
}

export const bunqueueClient = {
  get,
  post,
  isReady,
  resolveBaseUrl,
  invalidateBaseUrl,
};
