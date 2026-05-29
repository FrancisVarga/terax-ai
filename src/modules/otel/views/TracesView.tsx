import { cn } from "@/lib/utils";
import {
  Bug01Icon,
  CheckmarkCircle02Icon,
  FilterIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import {
  fmtAgo,
  fmtDuration,
  otel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type TraceSort,
  type TraceSummary,
} from "../lib/useOtel";
import { TraceDetail } from "./detail/TraceDetail";
import { AttrFilterInput } from "./detail/AttrFilterInput";

/**
 * Traces view: a filterable list of captured traces. Selecting a trace opens a
 * full-page detail (waterfall + per-trace service graph + HTTP request panel),
 * the canonical distributed-tracing drill-down built from the local store.
 */
export function TracesView({
  tick,
  onOpenMesh,
}: {
  tick: number;
  /** Open the global Service Mesh, optionally focused on a set of services. */
  onOpenMesh?: (services: string[]) => void;
}) {
  const [service, setService] = useState<string>("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [attrSearch, setAttrSearch] = useState("");
  const [minDurMs, setMinDurMs] = useState(0);
  const [sort, setSort] = useState<TraceSort>("recent");
  const [windowMs, setWindowMs] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const { data: services } = useOtelResource<string[]>(
    () => otel.services(),
    [],
    [tick],
  );

  const { data: traces, loading } = useOtelResource<TraceSummary[]>(
    () =>
      otel.traces({
        service: service || undefined,
        errorsOnly: errorsOnly || undefined,
        search: search.trim() || undefined,
        attrSearch: attrSearch.trim() || undefined,
        minDurationNano: minDurMs > 0 ? minDurMs * 1e6 : undefined,
        sinceMs: sinceFromWindow(windowMs),
        sort,
        limit: 300,
      }),
    [],
    [tick, service, errorsOnly, search, attrSearch, minDurMs, sort, windowMs],
  );

  const { data: attrKeys } = useOtelResource<string[]>(
    () => otel.attributeKeys(),
    [],
    [tick],
  );

  // Full-page-replace: when a trace is selected, the list is replaced entirely
  // by the trace detail page (back button returns to the filtered list).
  // Placed after all hooks so hook order stays stable (Rules of Hooks).
  if (selected) {
    return (
      <TraceDetail
        traceId={selected}
        tick={tick}
        onBack={() => setSelected(null)}
        onOpenGlobalMesh={onOpenMesh}
      />
    );
  }

  const anyFilter =
    !!service || errorsOnly || !!search || !!attrSearch || minDurMs > 0 || windowMs > 0;
  if (!loading && traces.length === 0 && !anyFilter) {
    return (
      <OtelEmpty
        loading={loading}
        what="traces"
        hint="Point your app's OTLP/HTTP trace exporter at the ingest endpoint above. Spans appear here grouped into traces, in realtime."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TraceFilters
        services={services}
        service={service}
        errorsOnly={errorsOnly}
        search={search}
        attrSearch={attrSearch}
        attrKeys={attrKeys}
        minDurMs={minDurMs}
        sort={sort}
        windowMs={windowMs}
        onService={setService}
        onErrorsOnly={setErrorsOnly}
        onSearch={setSearch}
        onAttrSearch={setAttrSearch}
        onMinDur={setMinDurMs}
        onSort={setSort}
        onWindow={setWindowMs}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {traces.length === 0 ? (
          <p className="p-4 text-center text-[11.5px] text-muted-foreground">
            No traces match the current filters.
          </p>
        ) : (
          <ul className="flex flex-col">
            {traces.map((t) => (
              <TraceRow
                key={t.traceId}
                trace={t}
                selected={t.traceId === selected}
                onSelect={() => setSelected(t.traceId)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const MIN_DUR_PRESETS = [0, 100, 500, 1000, 2000];

function TraceFilters(props: {
  services: string[];
  service: string;
  errorsOnly: boolean;
  search: string;
  attrSearch: string;
  attrKeys: string[];
  minDurMs: number;
  sort: TraceSort;
  windowMs: number;
  onService: (s: string) => void;
  onErrorsOnly: (b: boolean) => void;
  onSearch: (s: string) => void;
  onAttrSearch: (s: string) => void;
  onMinDur: (n: number) => void;
  onSort: (s: TraceSort) => void;
  onWindow: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 p-2.5">
      <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        <input
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
          placeholder="Filter by root span name…"
          className="w-full bg-transparent py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2">
        <HugeiconsIcon
          icon={FilterIcon}
          size={12}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        <AttrFilterInput
          value={props.attrSearch}
          onChange={props.onAttrSearch}
          attributeKeys={props.attrKeys}
          placeholder='Attribute match (e.g. http.response.status_code":500)'
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={props.service}
          onChange={(e) => props.onService(e.target.value)}
          className="flex-1 rounded-md border border-border/60 bg-background/50 px-2 py-1 text-[11.5px] outline-none"
        >
          <option value="">All services</option>
          {props.services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => props.onErrorsOnly(!props.errorsOnly)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
            props.errorsOnly
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border/60 bg-background/50 text-muted-foreground hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={Bug01Icon} size={12} strokeWidth={1.75} />
          Errors
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          label="Min"
          options={MIN_DUR_PRESETS.map((ms) => ({
            value: ms,
            label: ms === 0 ? "any" : ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`,
          }))}
          value={props.minDurMs}
          onChange={props.onMinDur}
        />
        <SegmentedControl
          label=""
          options={[
            { value: "recent", label: "Recent" },
            { value: "slowest", label: "Slowest" },
          ]}
          value={props.sort}
          onChange={props.onSort}
        />
      </div>
      <SegmentedControl
        label="Window"
        options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
        value={props.windowMs}
        onChange={props.onWindow}
      />
    </div>
  );
}

/** Small inline segmented toggle used across the filter bars. */
export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {label && (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
      )}
      <div className="flex items-center overflow-hidden rounded-md border border-border/60">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "px-2 py-0.5 text-[11px] font-medium transition-colors",
              value === o.value
                ? "bg-accent text-foreground"
                : "bg-background/50 text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TraceRow({
  trace,
  selected,
  onSelect,
}: {
  trace: TraceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col gap-1 border-b border-border/40 px-3 py-2 text-left transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/40",
        )}
      >
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={trace.hasError ? Bug01Icon : CheckmarkCircle02Icon}
            size={13}
            strokeWidth={1.75}
            className={cn(
              "shrink-0",
              trace.hasError ? "text-red-400" : "text-emerald-400/80",
            )}
          />
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {trace.rootName || "(unnamed)"}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {fmtDuration(trace.durationNano)}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="truncate text-foreground/70">{trace.rootService}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{trace.spanCount} spans</span>
          <span className="ml-auto text-muted-foreground/60">
            {fmtAgo(trace.receivedMs)}
          </span>
        </div>
      </button>
    </li>
  );
}
