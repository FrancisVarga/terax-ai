import { cn } from "@/lib/utils";
import { useEffect, useId, useRef, useState } from "react";

type Props = {
  /** Raw mermaid source from a ```mermaid fenced block. */
  code: string;
};

type Render =
  | { kind: "loading" }
  | { kind: "ok"; svg: string }
  | { kind: "error"; message: string };

let mermaidInit: Promise<typeof import("mermaid").default> | null = null;

/** Lazily import + init mermaid once, picking the theme from the document's
 *  `light`/`dark` class so diagrams match the app. */
function getMermaid(): Promise<typeof import("mermaid").default> {
  if (mermaidInit) return mermaidInit;
  mermaidInit = import("mermaid").then(({ default: mermaid }) => {
    const dark = document.documentElement.classList.contains("dark");
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? "dark" : "default",
      securityLevel: "strict",
    });
    return mermaid;
  });
  return mermaidInit;
}

/**
 * Renders a mermaid diagram from fenced ```mermaid source. Mermaid is imported
 * lazily (it's heavy) the first time a diagram appears, and rendered to an SVG
 * string that we inject. `securityLevel: "strict"` keeps mermaid from emitting
 * scripts/click-handlers, which matters since the source can come from any
 * opened markdown file.
 */
export function MermaidDiagram({ code }: Props) {
  const [state, setState] = useState<Render>({ kind: "loading" });
  // Mermaid needs a DOM-id-safe, unique render id per diagram.
  const rawId = useId();
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getMermaid()
      .then((mermaid) => mermaid.render(renderId, code))
      .then(({ svg }) => {
        if (!cancelled) setState({ kind: "ok", svg });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  if (state.kind === "error") {
    // Fall back to the raw source so the content isn't lost on a syntax error.
    return (
      <div className="my-2 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="mb-1 text-[11px] font-medium text-destructive">
          Mermaid error: {state.message}
        </p>
        <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "my-2 flex justify-center overflow-auto rounded-md border border-border/50 bg-background/60 p-3",
        "[&_svg]:max-w-full [&_svg]:h-auto",
        state.kind === "loading" && "min-h-12 items-center",
      )}
      // SVG comes from mermaid with securityLevel:strict (no scripts/handlers).
      dangerouslySetInnerHTML={
        state.kind === "ok" ? { __html: state.svg } : undefined
      }
    >
      {state.kind === "loading" ? (
        <span className="text-[11px] text-muted-foreground">
          Rendering diagram…
        </span>
      ) : undefined}
    </div>
  );
}
