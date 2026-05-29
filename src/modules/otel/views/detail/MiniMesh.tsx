import { cn } from "@/lib/utils";
import { serviceEdgesFromSpans, type ServiceEdgeLite } from "../../lib/drilldown";
import type { SpanRow } from "../../lib/useOtel";

/**
 * Compact service-dependency graph derived from one span set (typically all
 * spans of a single trace). Reuses the same left-to-right layered layout idea
 * as the global ServiceMeshView but in a smaller, dependency-free SVG. Shown on
 * the Traces detail page next to the waterfall so a single trace's cross-service
 * call shape is visible at a glance.
 */
export function MiniMesh({ spans }: { spans: SpanRow[] }) {
  const { nodes, edges } = serviceEdgesFromSpans(spans);
  if (nodes.length <= 1 || edges.length === 0) {
    return (
      <p className="rounded-lg border border-border/50 bg-background/40 p-3 text-[11px] text-muted-foreground">
        Single-service trace — no cross-service calls to graph.
      </p>
    );
  }

  // Layer nodes by longest path from entry (no-inbound) nodes.
  const layer = layerize(nodes, edges);
  const cols = new Map<number, string[]>();
  for (const [svc, l] of layer) {
    const arr = cols.get(l) ?? [];
    arr.push(svc);
    cols.set(l, arr);
  }
  const COL_W = 170;
  const ROW_H = 56;
  const PAD = 14;
  const NODE_W = 132;
  const NODE_H = 34;
  const sortedLayers = Array.from(cols.keys()).sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  sortedLayers.forEach((l, ci) => {
    const svcs = cols.get(l)!.slice().sort();
    svcs.forEach((svc, ri) => {
      positions.set(svc, { x: PAD + ci * COL_W, y: PAD + ri * ROW_H });
    });
  });
  const maxRows = Math.max(1, ...Array.from(cols.values()).map((c) => c.length));
  const width = PAD * 2 + (sortedLayers.length - 1) * COL_W + NODE_W;
  const height = PAD * 2 + (maxRows - 1) * ROW_H + NODE_H;
  const maxCalls = Math.max(1, ...edges.map((e) => e.calls));

  return (
    <div className="overflow-auto rounded-lg border border-border/50 bg-background/40 p-2">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ height, minWidth: width }}>
        {edges.map((e) => {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const stroke =
            e.errors > 0 ? "var(--destructive, #ef4444)" : "var(--primary, #6366f1)";
          return (
            <g key={`${e.from}->${e.to}`}>
              <path
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none"
                stroke={stroke}
                strokeWidth={1 + (e.calls / maxCalls) * 2.5}
                strokeOpacity={0.5}
              />
              <text
                x={mx}
                y={(y1 + y2) / 2 - 3}
                textAnchor="middle"
                className={cn(e.errors > 0 ? "fill-red-400" : "fill-muted-foreground")}
                style={{ fontSize: 8.5, fontFamily: "monospace" }}
              >
                {e.calls}×
              </text>
            </g>
          );
        })}
        {nodes.map((svc) => {
          const p = positions.get(svc);
          if (!p) return null;
          return (
            <g key={svc}>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className="fill-card"
                stroke="var(--border, #333)"
                strokeWidth={1.25}
              />
              <text
                x={p.x + 10}
                y={p.y + 21}
                className="fill-foreground"
                style={{ fontSize: 11, fontWeight: 600 }}
              >
                {svc.length > 16 ? `${svc.slice(0, 15)}…` : svc}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function layerize(nodes: string[], edges: ServiceEdgeLite[]): Map<string, number> {
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n, 0);
  for (const e of edges) {
    if (e.from === e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  for (const n of nodes) if ((indeg.get(n) ?? 0) === 0) layer.set(n, 0);
  let changed = true;
  let guard = nodes.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const e of edges) {
      if (e.from === e.to) continue;
      const lf = layer.get(e.from) ?? 0;
      const lt = layer.get(e.to);
      if (lt === undefined || lt < lf + 1) {
        layer.set(e.to, lf + 1);
        changed = true;
      }
    }
  }
  for (const n of nodes) if (!layer.has(n)) layer.set(n, 0);
  return layer;
}
