/**
 * http-request worker — runs in the Bun runtime (NOT the webview).
 *
 * Terax's Rust backend spawns this with `bun` on app start. It connects to the
 * embedded bunqueue server over TCP (127.0.0.1:7889) and processes
 * `http-request` jobs by performing an HTTP request with `fetch`.
 *
 * Job payload (see HttpRequestPayload). The processor's return value
 * (HttpRequestResult) is stored as the job result; throwing routes the job to
 * retry/DLQ per server policy.
 *
 * Run standalone for debugging:
 *   bun src/modules/bunqueue/workers/httpRequest.ts
 *
 * Env overrides: BUNQUEUE_HOST, BUNQUEUE_TCP_PORT.
 */

import { Worker, type Job } from "bunqueue/client";

const QUEUE = "http-request";
const HOST = process.env.BUNQUEUE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BUNQUEUE_TCP_PORT ?? 7889);

/** Default request timeout if the payload doesn't set one. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard ceiling on captured response bytes to avoid OOM on huge responses. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
type HttpMethod = (typeof METHODS)[number];

export type HttpRequestPayload = {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Appended to the URL's query string. */
  query?: Record<string, string | number | boolean>;
  /**
   * Request body. A string is sent as-is; any other JSON value is
   * JSON-stringified and a default `content-type: application/json` is added
   * unless one is already present. Ignored for GET/HEAD.
   */
  body?: unknown;
  timeoutMs?: number;
  /** "follow" (default), "manual", or "error". */
  redirect?: "follow" | "manual" | "error";
  /** Cap on captured response bytes. Defaults to 5 MiB. */
  maxBytes?: number;
  /** When true (default), parse JSON responses into `json`. */
  parseJson?: boolean;
};

export type HttpRequestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  /** Final URL after redirects. */
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  /** Response body as text (truncated to maxBytes). */
  body: string;
  /** True when the body was truncated at maxBytes. */
  truncated: boolean;
  /** Parsed JSON when the response is JSON and parseJson is on. */
  json?: unknown;
  durationMs: number;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + normalize a raw job payload. Throws on bad input. */
function validate(data: unknown): HttpRequestPayload {
  if (!isPlainObject(data)) throw new Error("payload must be an object");
  const url = data.url;
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("url is required");
  }
  // Reject obviously non-http schemes early (file:, data:, etc.).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const method = (
    typeof data.method === "string" ? data.method.toUpperCase() : "GET"
  ) as HttpMethod;
  if (!METHODS.includes(method)) {
    throw new Error(`unsupported method: ${method}`);
  }

  const headers = isPlainObject(data.headers)
    ? Object.fromEntries(
        Object.entries(data.headers).map(([k, v]) => [k, String(v)]),
      )
    : undefined;

  const query = isPlainObject(data.query)
    ? (data.query as Record<string, string | number | boolean>)
    : undefined;

  const redirect =
    data.redirect === "manual" || data.redirect === "error"
      ? data.redirect
      : "follow";

  return {
    url,
    method,
    headers,
    query,
    body: data.body,
    timeoutMs:
      typeof data.timeoutMs === "number" && data.timeoutMs > 0
        ? data.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    redirect,
    maxBytes:
      typeof data.maxBytes === "number" && data.maxBytes > 0
        ? data.maxBytes
        : DEFAULT_MAX_BYTES,
    parseJson: data.parseJson !== false,
  };
}

/** Apply query params onto the URL. */
function withQuery(
  url: string,
  query: HttpRequestPayload["query"],
): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Build fetch init: method, headers, serialized body. */
function buildInit(
  p: HttpRequestPayload,
  signal: AbortSignal,
): RequestInit {
  const headers = new Headers(p.headers);
  const init: RequestInit = {
    method: p.method,
    headers,
    redirect: p.redirect,
    signal,
  };

  const bodyless = p.method === "GET" || p.method === "HEAD";
  if (!bodyless && p.body !== undefined && p.body !== null) {
    if (typeof p.body === "string") {
      init.body = p.body;
    } else {
      init.body = JSON.stringify(p.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }
  return init;
}

/** Read the response body up to `maxBytes`, reporting truncation. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

export async function performRequest(
  payload: HttpRequestPayload,
): Promise<HttpRequestResult> {
  const url = withQuery(payload.url, payload.query);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    payload.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const startedAt = performance.now();
  try {
    const res = await fetch(url, buildInit(payload, controller.signal));
    const { text, truncated } = await readCapped(
      res,
      payload.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    const durationMs = Math.round(performance.now() - startedAt);

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let json: unknown;
    const ct = res.headers.get("content-type") ?? "";
    if (payload.parseJson !== false && ct.includes("json") && text && !truncated) {
      try {
        json = JSON.parse(text);
      } catch {
        // Leave json undefined on parse failure; body still carries the text.
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url || url,
      redirected: res.redirected,
      headers,
      body: text,
      truncated,
      json,
      durationMs,
    };
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      throw new Error(`request timed out after ${payload.timeoutMs}ms: ${url}`);
    }
    throw new Error(`request failed: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

const processor = async (job: Job): Promise<HttpRequestResult> => {
  const payload = validate(job.data);
  return performRequest(payload);
};

if (import.meta.main) {
  const worker = new Worker(QUEUE, processor, {
    connection: { host: HOST, port: PORT },
  });

  worker.on("ready", () =>
    console.log(`[${QUEUE}] worker ready → ${HOST}:${PORT}`),
  );
  worker.on("completed", (job: Job, result: HttpRequestResult) =>
    console.log(
      `[${QUEUE}] #${job.id} ${result.status} ${result.statusText} (${result.durationMs}ms)`,
    ),
  );
  worker.on("failed", (job: Job | undefined, err: Error) =>
    console.error(`[${QUEUE}] #${job?.id ?? "?"} failed: ${err.message}`),
  );
  worker.on("error", (err: Error) =>
    console.error(`[${QUEUE}] worker error: ${err.message}`),
  );

  const shutdown = async () => {
    console.log(`[${QUEUE}] shutting down`);
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
