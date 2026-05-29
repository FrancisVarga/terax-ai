import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Activity03Icon,
  CodeIcon,
  ConnectIcon,
  Copy01Icon,
  DashboardSquare01Icon,
  Database02Icon,
  Delete02Icon,
  RefreshIcon,
  SatelliteIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState } from "react";
import {
  fmtBytes,
  otel,
  useOtelLive,
  useOtelResource,
  type OtelCounts,
} from "./lib/useOtel";
import { TracesView } from "./views/TracesView";
import { LogsView } from "./views/LogsView";
import { MetricsView } from "./views/MetricsView";
import { ServiceMeshView } from "./views/ServiceMeshView";
import { DatabaseView } from "./views/DatabaseView";
import { UsersView } from "./views/UsersView";
import { OverviewView } from "./views/OverviewView";
import { QueryView } from "./views/QueryView";

type ViewKey =
  | "overview"
  | "traces"
  | "logs"
  | "metrics"
  | "mesh"
  | "database"
  | "users"
  | "query";

/**
 * The local observability dashboard — a singleton main-content tab. It renders
 * the standard telemetry views (traces / logs / metrics) plus a service mesh,
 * a database-query dashboard, and a per-attribute "users" breakdown, over the
 * data the embedded OTLP/HTTP collector (`src-tauri/.../otel`) captures. It
 * refreshes in realtime as apps export to it. All data is local.
 */
export function OtelDashboardPane() {
  const [view, setView] = useState<ViewKey>("overview");
  // A monotonic token bumped on ingest / manual refresh. Views depend on it so
  // they refetch together when new telemetry lands.
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Cross-view focus: a trace detail page can request the Service Mesh view
  // focused on a subset of services. Cleared when the mesh view consumes it.
  const [meshFocus, setMeshFocus] = useState<string[] | null>(null);

  useOtelLive(bump);

  const { data: counts } = useOtelResource<OtelCounts>(
    () => otel.counts(),
    { traces: 0, spans: 0, logs: 0, metrics: 0, dbBytes: 0 },
    [tick],
  );

  const openMesh = useCallback((services: string[]) => {
    setMeshFocus(services.length > 0 ? services : null);
    setView("mesh");
  }, []);

  return (
    <div className="flex h-full flex-col">
      <DashboardHeader counts={counts} onRefresh={bump} />
      <ViewTabs view={view} counts={counts} onSelect={setView} />
      <div className="min-h-0 flex-1">
        {view === "overview" && <OverviewView tick={tick} />}
        {view === "traces" && <TracesView tick={tick} onOpenMesh={openMesh} />}
        {view === "logs" && <LogsView tick={tick} />}
        {view === "metrics" && <MetricsView tick={tick} />}
        {view === "mesh" && (
          <ServiceMeshView
            tick={tick}
            focusServices={meshFocus}
            onClearFocus={() => setMeshFocus(null)}
          />
        )}
        {view === "database" && <DatabaseView tick={tick} />}
        {view === "users" && <UsersView tick={tick} />}
        {view === "query" && <QueryView />}
      </div>
    </div>
  );
}

function DashboardHeader({
  counts,
  onRefresh,
}: {
  counts: OtelCounts;
  onRefresh: () => void;
}) {
  const { data: port } = useOtelResource<number>(() => otel.ingestPort(), 4318, []);
  const [clearing, setClearing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Copy the base endpoint (no signal path) — that is what an app's
  // OTEL_EXPORTER_OTLP_ENDPOINT takes; the SDK appends /v1/traces itself.
  const endpoint = `http://localhost:${port}`;
  const onCopy = useCallback(async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (rare in the webview); silently no-op.
    }
  }, [endpoint]);

  const onClear = useCallback(async () => {
    setClearing(true);
    try {
      await otel.clear();
      onRefresh();
    } finally {
      setClearing(false);
    }
  }, [onRefresh]);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <HugeiconsIcon
          icon={SatelliteIcon}
          size={18}
          strokeWidth={1.75}
          className="text-primary"
        />
        <div>
          <h1 className="text-[14px] font-semibold leading-tight">
            Observability
          </h1>
          <p className="flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
            OTLP/HTTP ingest on
            <button
              type="button"
              onClick={onCopy}
              title={copied ? "Copied" : `Copy ${endpoint}`}
              className="group inline-flex items-center gap-1 rounded px-1 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              {endpoint}
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={11}
                strokeWidth={2}
                className={cn(
                  "transition-colors",
                  copied
                    ? "text-emerald-400"
                    : "text-muted-foreground/50 group-hover:text-foreground",
                )}
              />
            </button>
            <span className="text-muted-foreground/50"> · /v1/traces · /v1/logs · /v1/metrics</span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground sm:flex">
          <HugeiconsIcon icon={Database02Icon} size={12} strokeWidth={1.75} />
          {fmtBytes(counts.dbBytes)}
          <span className="text-muted-foreground/40">/ 1.0 GB</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          title="Refresh"
          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
          Refresh
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={clearing}
          title="Delete all captured telemetry"
          className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={clearing ? RefreshIcon : Delete02Icon}
            size={13}
            strokeWidth={1.75}
            className={cn(clearing && "animate-spin")}
          />
          Clear
        </button>
      </div>
    </div>
  );
}

function ViewTabs({
  view,
  counts,
  onSelect,
}: {
  view: ViewKey;
  counts: OtelCounts;
  onSelect: (v: ViewKey) => void;
}) {
  const tabs: Array<{
    key: ViewKey;
    label: string;
    icon: typeof Activity03Icon;
    count?: number;
  }> = [
    { key: "overview", label: "Overview", icon: DashboardSquare01Icon },
    { key: "traces", label: "Traces", icon: Activity03Icon, count: counts.traces },
    { key: "logs", label: "Logs", icon: Activity03Icon, count: counts.logs },
    { key: "metrics", label: "Metrics", icon: Activity03Icon, count: counts.metrics },
    { key: "mesh", label: "Service Mesh", icon: ConnectIcon },
    { key: "database", label: "Database", icon: Database02Icon },
    { key: "users", label: "Users", icon: UserGroupIcon },
    { key: "query", label: "Query", icon: CodeIcon },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
            view === t.key
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
          {t.label}
          {t.count !== undefined && (
            <span
              className={cn(
                "rounded px-1 font-mono text-[9.5px]",
                view === t.key
                  ? "bg-primary/15 text-primary"
                  : "bg-muted/60 text-muted-foreground/80",
              )}
            >
              {t.count > 999 ? "999+" : t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Shared empty-state used by the views before any telemetry arrives. */
export function OtelEmpty({
  loading,
  what,
  hint,
}: {
  loading: boolean;
  what: string;
  hint: string;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Spinner className="size-4" />
        <span>Loading {what}…</span>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
      <HugeiconsIcon icon={SatelliteIcon} size={28} strokeWidth={1.5} className="opacity-50" />
      <p className="text-[13px] font-medium text-foreground">No {what} yet</p>
      <p className="max-w-md text-[11.5px] leading-relaxed">{hint}</p>
    </div>
  );
}
