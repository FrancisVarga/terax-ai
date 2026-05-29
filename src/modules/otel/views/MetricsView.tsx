import { HugeiconsIcon } from "@hugeicons/react";
import { ChartLineData01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import {
  otel,
  useOtelResource,
  type MetricName,
} from "../lib/useOtel";
import { MetricDetail } from "./detail/MetricDetail";

/**
 * Metrics view: a list of captured metric series on the left, and a time-series
 * chart of the selected metric on the right. Gauge / sum / histogram points are
 * reduced to one chart-worthy scalar per point (`metricScalar`) and drawn as an
 * inline SVG line+area — no chart dependency, matching the app's lightweight
 * rendering convention.
 */
export function MetricsView({ tick }: { tick: number }) {
  const [selected, setSelected] = useState<string | null>(null);

  const { data: names, loading } = useOtelResource<MetricName[]>(
    () => otel.metricNames(),
    [],
    [tick],
  );

  // Full-page-replace: selecting a metric opens its full detail page.
  if (selected) {
    return (
      <MetricDetail name={selected} tick={tick} onBack={() => setSelected(null)} />
    );
  }

  if (!loading && names.length === 0) {
    return (
      <OtelEmpty
        loading={loading}
        what="metrics"
        hint="Point your app's OTLP/HTTP metric exporter at the ingest endpoint above. Gauges, counters, and histograms appear here as live time series."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <ul className="flex flex-col">
        {names.map((m) => (
          <li key={`${m.name}:${m.kind}`}>
            <button
              type="button"
              onClick={() => setSelected(m.name)}
              className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-accent/40"
            >
              <HugeiconsIcon
                icon={ChartLineData01Icon}
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                {m.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <span className="rounded bg-muted/60 px-1 uppercase tracking-wide">{m.kind}</span>
                {m.unit && <span>{m.unit}</span>}
                <span>{m.points} pts</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
