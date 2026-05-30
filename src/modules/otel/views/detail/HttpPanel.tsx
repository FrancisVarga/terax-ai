import { cn } from "@/lib/utils";
import {
  ComputerIcon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  extractHttp,
  parseUserAgent,
  primaryHttpSpan,
  type HttpHeader,
  type HttpInfo,
} from "../../lib/http";
import type { SpanRow } from "../../lib/useOtel";
import { CopyButton, DetailSection } from "./DetailShell";

/**
 * Renders the HTTP request/response detail of a span: method + URL + status,
 * the parsed User-Agent, and the full request & response header sets. Headers
 * only appear when the exporter captured them (`http.request.header.*` /
 * `http.response.header.*`); we never fabricate values.
 */
export function HttpPanel({ span }: { span: SpanRow }) {
  const info = extractHttp(span);
  if (!info.isHttp) return null;
  return <HttpInfoView info={info} />;
}

/** Pick the representative HTTP span from a set and render its HTTP panel. */
export function HttpPanelForSpans({ spans }: { spans: SpanRow[] }) {
  const span = primaryHttpSpan(spans);
  if (!span) return null;
  return <HttpPanel span={span} />;
}

function HttpInfoView({ info }: { info: HttpInfo }) {
  const ua = info.userAgent ? parseUserAgent(info.userAgent) : null;
  const uaLabel = ua
    ? [ua.browser, ua.os, ua.device].filter(Boolean).join(" · ")
    : null;
  const isErr = info.statusCode != null && info.statusCode >= 400;
  return (
    <DetailSection title="HTTP request">
      <div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-background/40 p-3">
        {/* Request line */}
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px]">
          {info.method && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">
              {info.method}
            </span>
          )}
          {info.statusCode != null && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-semibold",
                isErr ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-400",
              )}
            >
              {info.statusCode}
            </span>
          )}
          {(info.url || info.route) && (
            <span className="min-w-0 flex-1 break-all text-foreground/90">
              {info.url || info.route}
            </span>
          )}
          {(info.url || info.route) && <CopyButton text={info.url || info.route || ""} />}
        </div>

        {/* User agent */}
        {info.userAgent && (
          <div className="flex flex-col gap-1 border-t border-border/40 pt-2">
            <div className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
              <HugeiconsIcon icon={ComputerIcon} size={11} strokeWidth={1.75} />
              User agent
              {uaLabel && (
                <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] normal-case text-foreground/80">
                  {uaLabel}
                </span>
              )}
            </div>
            <div className="flex items-start gap-2">
              <span className="flex-1 break-all font-mono text-[10.5px] text-foreground/85">
                {info.userAgent}
              </span>
              <CopyButton text={info.userAgent} />
            </div>
          </div>
        )}

        {/* Connection facts */}
        {(info.clientAddress || info.serverAddress || info.scheme) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 pt-2 font-mono text-[10px] text-muted-foreground">
            {info.scheme && <span>scheme {info.scheme}</span>}
            {info.clientAddress && (
              <span className="flex items-center gap-1">
                <HugeiconsIcon icon={Globe02Icon} size={10} strokeWidth={1.75} />
                client {info.clientAddress}
              </span>
            )}
            {info.serverAddress && <span>server {info.serverAddress}</span>}
          </div>
        )}

        {/* Headers */}
        <HeaderTable title="Request headers" headers={info.requestHeaders} />
        <HeaderTable title="Response headers" headers={info.responseHeaders} />
      </div>
    </DetailSection>
  );
}

function HeaderTable({ title, headers }: { title: string; headers: HttpHeader[] }) {
  if (headers.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/40 pt-2">
      <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
        {title}
        <span className="ml-1.5 text-muted-foreground/50">{headers.length}</span>
      </span>
      <div className="flex flex-col gap-0.5">
        {headers.map((h) => (
          <div key={h.name} className="group flex gap-2 font-mono text-[10.5px]">
            <span className="w-48 shrink-0 truncate text-muted-foreground/80" title={h.name}>
              {h.name}
            </span>
            <span className="flex-1 break-all text-foreground/85">{h.value}</span>
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={h.value} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
