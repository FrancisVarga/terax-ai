import { cn } from "@/lib/utils";
import { FilterIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import {
  fmtClock,
  otel,
  severityLevel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type LogRow,
} from "../lib/useOtel";
import { SegmentedControl } from "./TracesView";
import { LogDetail } from "./detail/LogDetail";
import { TraceDetail } from "./detail/TraceDetail";
import { AttrFilterInput } from "./detail/AttrFilterInput";

type LogsNav =
  | { kind: "list" }
  | { kind: "log"; log: LogRow }
  | { kind: "trace"; traceId: string };

/** Severity threshold options for the level filter. */
const LEVELS: Array<{ label: string; min: number }> = [
  { label: "All", min: 0 },
  { label: "Debug+", min: 5 },
  { label: "Info+", min: 9 },
  { label: "Warn+", min: 13 },
  { label: "Error+", min: 17 },
];

/**
 * Logs view: a realtime, filterable log stream. Standard log-explorer controls —
 * service scope, minimum severity, and a body substring search — map directly to
 * the backend `LogQuery`. Newest first.
 */
export function LogsView({ tick }: { tick: number }) {
  const [service, setService] = useState("");
  const [minSeverity, setMinSeverity] = useState(0);
  const [search, setSearch] = useState("");
  const [attrSearch, setAttrSearch] = useState("");
  const [windowMs, setWindowMs] = useState(0);
  const [nav, setNav] = useState<LogsNav>({ kind: "list" });

  const { data: services } = useOtelResource<string[]>(
    () => otel.services(),
    [],
    [tick],
  );

  const { data: attrKeys } = useOtelResource<string[]>(
    () => otel.attributeKeys(),
    [],
    [tick],
  );

  const { data: logs, loading } = useOtelResource<LogRow[]>(
    () =>
      otel.logs({
        service: service || undefined,
        minSeverity: minSeverity || undefined,
        search: search.trim() || undefined,
        attrSearch: attrSearch.trim() || undefined,
        sinceMs: sinceFromWindow(windowMs),
        limit: 1000,
      }),
    [],
    [tick, service, minSeverity, search, attrSearch, windowMs],
  );

  // Detail navigation (full-page replace). Placed after all hooks so hook call
  // order stays stable across list/detail renders (Rules of Hooks).
  if (nav.kind === "log") {
    return (
      <LogDetail
        log={nav.log}
        onBack={() => setNav({ kind: "list" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
      />
    );
  }
  if (nav.kind === "trace") {
    return (
      <TraceDetail
        traceId={nav.traceId}
        tick={tick}
        onBack={() => setNav({ kind: "list" })}
      />
    );
  }

  const anyFilter = !!service || !!minSeverity || !!search || !!attrSearch || windowMs > 0;
  if (!loading && logs.length === 0 && !anyFilter) {
    return (
      <OtelEmpty
        loading={loading}
        what="logs"
        hint="Point your app's OTLP/HTTP log exporter at the ingest endpoint above. Log records stream here, newest first, with severity and trace correlation."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 p-2.5">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search log bodies…"
              className="w-full bg-transparent py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            className="rounded-md border border-border/60 bg-background/50 px-2 py-1 text-[11.5px] outline-none"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <div className="flex items-center overflow-hidden rounded-md border border-border/60">
            {LEVELS.map((l) => (
              <button
                key={l.min}
                type="button"
                onClick={() => setMinSeverity(l.min)}
                className={cn(
                  "px-2 py-1 text-[11px] font-medium transition-colors",
                  minSeverity === l.min
                    ? "bg-accent text-foreground"
                    : "bg-background/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
            <HugeiconsIcon
              icon={FilterIcon}
              size={12}
              strokeWidth={1.75}
              className="text-muted-foreground"
            />
            <AttrFilterInput
              value={attrSearch}
              onChange={setAttrSearch}
              attributeKeys={attrKeys}
              placeholder="Attribute match (e.g. tenant.id, a request id)…"
            />
          </div>
          <SegmentedControl
            label="Window"
            options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
            value={windowMs}
            onChange={setWindowMs}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {logs.length === 0 ? (
          <p className="p-4 text-center text-[11.5px] text-muted-foreground">
            No logs match the current filters.
          </p>
        ) : (
          <ul className="flex flex-col">
            {logs.map((l, i) => (
              <LogLine
                key={`${l.timeNano}:${i}`}
                log={l}
                onOpen={() => setNav({ kind: "log", log: l })}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LogLine({ log, onOpen }: { log: LogRow; onOpen: () => void }) {
  const sev = severityLevel(log.severityNumber);
  return (
    <li className="border-b border-border/30">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-accent/40"
      >
        <span className="shrink-0 text-muted-foreground/60">{fmtClock(log.timeNano)}</span>
        <span className={cn("w-12 shrink-0 font-semibold", sev.cls)}>
          {sev.label || log.severityText}
        </span>
        <span className="shrink-0 truncate text-foreground/60" style={{ maxWidth: 120 }}>
          {log.service}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90">{log.body}</span>
        {log.traceId && (
          <span
            className="shrink-0 rounded bg-primary/10 px-1 text-[9.5px] text-primary/80"
            title={`trace ${log.traceId}`}
          >
            trace
          </span>
        )}
      </button>
    </li>
  );
}

