import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseLog, type LogLevel, type LogLine } from "./lib/parseLog";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; lines: LogLine[] }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
};

const ROW_HEIGHT = 18;

// Left accent + text tint per level. Kept subtle so INFO/none stay readable and
// ERROR/WARN pop without shouting.
const LEVEL_STYLE: Record<LogLevel, { text: string; accent: string }> = {
  error: { text: "text-rose-400", accent: "bg-rose-500/80" },
  warn: { text: "text-amber-400", accent: "bg-amber-500/80" },
  info: { text: "text-sky-400/90", accent: "bg-sky-500/70" },
  debug: { text: "text-emerald-400/85", accent: "bg-emerald-500/60" },
  trace: { text: "text-muted-foreground", accent: "bg-muted-foreground/40" },
  none: { text: "text-foreground/80", accent: "bg-transparent" },
};

export function LogViewerPane({ path, visible }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", lines: parseLog(res.content) });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const lines = status.kind === "ready" ? status.lines : EMPTY;
  const gutterWidth = useMemo(() => {
    const digits = String(lines.length).length;
    return Math.max(2, digits) + 1;
  }, [lines.length]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      {status.kind === "loading" && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading…</p>
      )}
      {status.kind === "error" && (
        <p className="px-4 py-3 text-[12px] text-destructive">
          Failed to read file: {status.message}
        </p>
      )}
      {status.kind === "binary" && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          Binary file — cannot render as a log.
        </p>
      )}
      {status.kind === "toolarge" && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          File is {status.size} bytes; limit {status.limit}.
        </p>
      )}
      {status.kind === "ready" && (
        <div
          ref={scrollRef}
          className="h-full select-text overflow-auto font-mono text-[12px] leading-[18px]"
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vr) => {
              const line = lines[vr.index];
              if (!line) return null;
              const style = LEVEL_STYLE[line.level];
              return (
                <div
                  key={vr.key}
                  className="absolute left-0 top-0 flex w-full items-start hover:bg-foreground/[0.03]"
                  style={{
                    height: vr.size,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <span
                    aria-hidden
                    className={cn("h-full w-[2px] shrink-0", style.accent)}
                  />
                  <span
                    className="shrink-0 select-none px-2 text-right tabular-nums text-muted-foreground/45"
                    style={{ width: `${gutterWidth}ch` }}
                  >
                    {line.n}
                  </span>
                  <pre
                    className={cn(
                      "m-0 min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 font-mono",
                      style.text,
                    )}
                  >
                    {line.text || " "}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: LogLine[] = [];
