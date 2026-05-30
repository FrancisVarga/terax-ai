import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { OtelEmpty } from "../OtelDashboardPane";
import { SegmentedControl } from "./TracesView";
import {
  fmtDuration,
  otel,
  sinceFromWindow,
  TIME_WINDOWS,
  useOtelResource,
  type ServiceEdge,
  type ServiceMap,
} from "../lib/useOtel";
import { ServiceDetail } from "./detail/ServiceDetail";
import { EdgeDetail } from "./detail/EdgeDetail";
import { TraceDetail } from "./detail/TraceDetail";

/** What the mesh view is currently showing: the graph, or a drill-down page. */
type MeshNav =
  | { kind: "graph" }
  | { kind: "service"; service: string }
  | { kind: "edge"; from: string; to: string }
  | { kind: "trace"; traceId: string };

/**
 * Service mesh: the dependency graph derived from cross-service span links. Each
 * service is a node; each directed edge is a parent->child call across service
 * boundaries, sized by call volume and colored by error rate. Nodes and edges
 * are clickable, opening a full-page service / dependency detail. A `focus
 * Services` set (passed when arriving from a trace's "Service mesh" button)
 * dims everything else so the relevant subgraph stands out.
 */
export function ServiceMeshView({
  tick,
  focusServices,
  onClearFocus,
}: {
  tick: number;
  focusServices?: string[] | null;
  onClearFocus?: () => void;
}) {
  const [windowMs, setWindowMs] = useState(0);
  const [nav, setNav] = useState<MeshNav>({ kind: "graph" });

  const { data: map, loading } = useOtelResource<ServiceMap>(
    () => otel.serviceMap(sinceFromWindow(windowMs)),
    { nodes: [], edges: [] },
    [tick, windowMs],
  );

  const sinceMs = sinceFromWindow(windowMs);
  const focusSet = useMemo(
    () => (focusServices && focusServices.length > 0 ? new Set(focusServices) : null),
    [focusServices],
  );

  // Detail pages (full-page replace).
  if (nav.kind === "service") {
    return (
      <ServiceDetail
        service={nav.service}
        map={map}
        tick={tick}
        sinceMs={sinceMs}
        onBack={() => setNav({ kind: "graph" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
        onOpenEdge={(from, to) => setNav({ kind: "edge", from, to })}
      />
    );
  }
  if (nav.kind === "edge") {
    return (
      <EdgeDetail
        from={nav.from}
        to={nav.to}
        map={map}
        tick={tick}
        sinceMs={sinceMs}
        onBack={() => setNav({ kind: "graph" })}
        onOpenTrace={(traceId) => setNav({ kind: "trace", traceId })}
        onOpenService={(service) => setNav({ kind: "service", service })}
      />
    );
  }
  if (nav.kind === "trace") {
    return (
      <TraceDetail
        traceId={nav.traceId}
        tick={tick}
        onBack={() => setNav({ kind: "graph" })}
      />
    );
  }

  if (!loading && map.nodes.length === 0) {
    return (
      <OtelEmpty
        loading={loading}
        what="service map"
        hint="Once traces span more than one service (a parent span in one service calling a child in another), the dependency graph appears here."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {map.nodes.length} services · {map.edges.length} dependencies
          </span>
          {focusSet && (
            <button
              type="button"
              onClick={onClearFocus}
              className="rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              focused: {focusSet.size} · clear
            </button>
          )}
        </div>
        <SegmentedControl
          label="Window"
          options={TIME_WINDOWS.map((w) => ({ value: w.ms, label: w.label }))}
          value={windowMs}
          onChange={setWindowMs}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <MeshGraph
          map={map}
          focusSet={focusSet}
          onOpenService={(service) => setNav({ kind: "service", service })}
          onOpenEdge={(from, to) => setNav({ kind: "edge", from, to })}
        />
      </div>
    </div>
  );
}

type Pos = { x: number; y: number };

/** Assign each service a dependency layer via longest-path from entry nodes. */
function layerize(map: ServiceMap): Map<string, number> {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of map.nodes) {
    out.set(n.service, []);
    indeg.set(n.service, 0);
  }
  for (const e of map.edges) {
    if (e.from === e.to) continue;
    out.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // Entry nodes (no inbound) start at layer 0; others get max(parent)+1.
  const layer = new Map<string, number>();
  const queue = map.nodes.filter((n) => (indeg.get(n.service) ?? 0) === 0).map((n) => n.service);
  for (const s of queue) layer.set(s, 0);
  // Iterate to a fixpoint (graph is tiny; cycles are bounded by node count).
  let changed = true;
  let guard = map.nodes.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const e of map.edges) {
      if (e.from === e.to) continue;
      const lf = layer.get(e.from) ?? 0;
      const lt = layer.get(e.to);
      if (lt === undefined || lt < lf + 1) {
        layer.set(e.to, lf + 1);
        changed = true;
      }
    }
  }
  // Any node never reached (isolated) lands in layer 0.
  for (const n of map.nodes) if (!layer.has(n.service)) layer.set(n.service, 0);
  return layer;
}

function MeshGraph({
  map,
  focusSet,
  onOpenService,
  onOpenEdge,
}: {
  map: ServiceMap;
  focusSet: Set<string> | null;
  onOpenService: (service: string) => void;
  onOpenEdge: (from: string, to: string) => void;
}) {
  const { positions, width, height } = useMemo(() => {
    const layer = layerize(map);
    const cols = new Map<number, string[]>();
    for (const [svc, l] of layer) {
      const arr = cols.get(l) ?? [];
      arr.push(svc);
      cols.set(l, arr);
    }
    const COL_W = 220;
    const ROW_H = 84;
    const PAD = 20;
    const maxRows = Math.max(1, ...Array.from(cols.values()).map((c) => c.length));
    const positions = new Map<string, Pos>();
    const sortedLayers = Array.from(cols.keys()).sort((a, b) => a - b);
    sortedLayers.forEach((l, ci) => {
      const svcs = cols.get(l)!.slice().sort();
      svcs.forEach((svc, ri) => {
        positions.set(svc, { x: PAD + ci * COL_W, y: PAD + ri * ROW_H });
      });
    });
    const width = PAD * 2 + (sortedLayers.length - 1) * COL_W + 160;
    const height = PAD * 2 + (maxRows - 1) * ROW_H + 56;
    return { positions, width, height };
  }, [map]);

  const maxCalls = Math.max(1, ...map.edges.map((e) => e.calls));
  const NODE_W = 150;
  const NODE_H = 44;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="min-w-full"
      style={{ height, minWidth: width }}
    >
      {/* Edges first (under nodes) */}
      {map.edges.map((e) => {
        if (e.from === e.to) return null;
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const errRate = e.calls > 0 ? e.errors / e.calls : 0;
        const stroke =
          errRate > 0.01 ? "var(--destructive, #ef4444)" : "var(--primary, #6366f1)";
        const w = 1 + (e.calls / maxCalls) * 3;
        const dim = focusSet ? !(focusSet.has(e.from) && focusSet.has(e.to)) : false;
        return (
          <g
            key={`${e.from}->${e.to}`}
            onClick={() => onOpenEdge(e.from, e.to)}
            style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }}
          >
            {/* Invisible fat hit-target so the thin edge is easy to click. */}
            <path
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke="transparent"
              strokeWidth={Math.max(12, w + 10)}
            />
            <path
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={stroke}
              strokeWidth={w}
              strokeOpacity={0.45}
            />
            <EdgeLabel x={mx} y={(y1 + y2) / 2} edge={e} />
          </g>
        );
      })}
      {/* Nodes */}
      {map.nodes.map((n) => {
        const p = positions.get(n.service);
        if (!p) return null;
        const errRate = n.spans > 0 ? n.errors / n.spans : 0;
        const dim = focusSet ? !focusSet.has(n.service) : false;
        return (
          <g
            key={n.service}
            onClick={() => onOpenService(n.service)}
            className="group/node"
            style={{ cursor: "pointer", opacity: dim ? 0.3 : 1 }}
          >
            <rect
              x={p.x}
              y={p.y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
              className="fill-card transition-colors group-hover/node:fill-accent"
              stroke={errRate > 0.01 ? "var(--destructive, #ef4444)" : "var(--border, #333)"}
              strokeWidth={1.5}
            />
            <text
              x={p.x + 12}
              y={p.y + 18}
              className="fill-foreground"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              {n.service}
            </text>
            <text
              x={p.x + 12}
              y={p.y + 33}
              className="fill-muted-foreground"
              style={{ fontSize: 9.5, fontFamily: "monospace" }}
            >
              {n.spans} spans{n.errors > 0 ? ` · ${n.errors} err` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function EdgeLabel({ x, y, edge }: { x: number; y: number; edge: ServiceEdge }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect x={-30} y={-9} width={60} height={18} rx={4} className="fill-background" opacity={0.85} />
      <text
        textAnchor="middle"
        y={3}
        className={cn(edge.errors > 0 ? "fill-red-400" : "fill-muted-foreground")}
        style={{ fontSize: 9, fontFamily: "monospace" }}
      >
        {edge.calls}× · {fmtDuration(edge.p95Nano)}
      </text>
    </g>
  );
}
