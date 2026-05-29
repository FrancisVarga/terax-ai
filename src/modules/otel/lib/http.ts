import type { SpanRow } from "./useOtel";

/**
 * Extract HTTP request/response detail from span attributes following OTel
 * semantic conventions. Both the current (`http.request.*`, stable since
 * semconv 1.23) and legacy (`http.method`, `http.user_agent`) attribute names
 * are supported, since exporters in the wild emit either. Headers are captured
 * as `http.request.header.<name>` / `http.response.header.<name>` and may be a
 * string or an array of strings.
 */

export type HttpHeader = { name: string; value: string };

export type HttpInfo = {
  isHttp: boolean;
  method: string | null;
  url: string | null;
  route: string | null;
  statusCode: number | null;
  userAgent: string | null;
  clientAddress: string | null;
  serverAddress: string | null;
  scheme: string | null;
  requestHeaders: HttpHeader[];
  responseHeaders: HttpHeader[];
};

function str(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

/** First non-null attribute value among several candidate keys. */
function pick(attrs: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (attrs[k] != null) return attrs[k];
  }
  return null;
}

/** Collect `prefix.<header>` attributes into a sorted header list. */
function collectHeaders(
  attrs: Record<string, unknown>,
  prefix: string,
): HttpHeader[] {
  const out: HttpHeader[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith(prefix)) continue;
    const name = k.slice(prefix.length);
    if (!name) continue;
    out.push({ name, value: str(v) ?? "" });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function extractHttp(span: SpanRow): HttpInfo {
  const a = (span.attributes ?? {}) as Record<string, unknown>;

  const method = str(pick(a, ["http.request.method", "http.method"]));
  const url = str(
    pick(a, ["url.full", "http.url", "http.target", "url.path"]),
  );
  const route = str(pick(a, ["http.route"]));
  const statusCode = num(
    pick(a, ["http.response.status_code", "http.status_code"]),
  );
  const userAgent = str(
    pick(a, ["user_agent.original", "http.user_agent", "http.request.header.user-agent"]),
  );
  const clientAddress = str(
    pick(a, ["client.address", "http.client_ip", "net.peer.ip"]),
  );
  const serverAddress = str(pick(a, ["server.address", "net.host.name"]));
  const scheme = str(pick(a, ["url.scheme", "http.scheme"]));

  // Current semconv header attrs are `http.request.header.<lowercased-name>`.
  // Some legacy exporters used `http.request.headers.<name>` (plural) — capture
  // both prefixes so nothing is dropped.
  const requestHeaders = [
    ...collectHeaders(a, "http.request.header."),
    ...collectHeaders(a, "http.request.headers."),
  ];
  const responseHeaders = [
    ...collectHeaders(a, "http.response.header."),
    ...collectHeaders(a, "http.response.headers."),
  ];

  const isHttp =
    method != null ||
    url != null ||
    statusCode != null ||
    userAgent != null ||
    requestHeaders.length > 0 ||
    responseHeaders.length > 0;

  return {
    isHttp,
    method,
    url,
    route,
    statusCode,
    userAgent,
    clientAddress,
    serverAddress,
    scheme,
    requestHeaders,
    responseHeaders,
  };
}

/**
 * Find the most relevant HTTP span in a set (e.g. all spans of a trace, or all
 * spans for a tenant) — preferring SERVER-kind spans (the inbound request),
 * then any span carrying HTTP attributes. Returns null when none is HTTP.
 */
export function primaryHttpSpan(spans: SpanRow[]): SpanRow | null {
  let fallback: SpanRow | null = null;
  for (const s of spans) {
    const info = extractHttp(s);
    if (!info.isHttp) continue;
    if (s.kind === 2 /* SERVER */) return s;
    if (!fallback) fallback = s;
  }
  return fallback;
}

/** Best-effort parse of a User-Agent string into a short, readable label. */
export function parseUserAgent(ua: string): {
  browser: string | null;
  os: string | null;
  device: string | null;
} {
  const browser =
    /Edg\/[\d.]+/.test(ua)
      ? "Edge"
      : /OPR\/[\d.]+|Opera/.test(ua)
        ? "Opera"
        : /Firefox\/[\d.]+/.test(ua)
          ? "Firefox"
          : /Chrome\/[\d.]+/.test(ua)
            ? "Chrome"
            : /Safari\/[\d.]+/.test(ua)
              ? "Safari"
              : /curl\//.test(ua)
                ? "curl"
                : /PostmanRuntime/.test(ua)
                  ? "Postman"
                  : /python-requests|axios|node-fetch|Go-http-client|okhttp/.test(ua)
                    ? ua.split("/")[0]
                    : null;
  const os =
    /Windows NT 10/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iOS/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  const device = /Mobile/.test(ua) ? "Mobile" : null;
  return { browser, os, device };
}
