import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  /**
   * When provided, the preview renders this live content instead of reading the
   * file from disk — used by the split editor+preview view so the right pane
   * tracks the left pane's buffer as the user types.
   */
  content?: string;
};

const components = { code: MarkdownCode };

export function MarkdownPreviewPane({ path, visible, content }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const live = content !== undefined;

  useEffect(() => {
    if (live) return; // live mode renders `content` directly; no disk read
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({
            kind: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, live]);

  // In live mode the rendered content is whatever the editor buffer holds.
  const renderContent = live ? (content as string) : null;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <div className="flex-1 overflow-auto px-6 py-4">
        {renderContent !== null ? (
          <Streamdown
            className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={components}
          >
            {renderContent}
          </Streamdown>
        ) : (
          <>
            {status.kind === "loading" && (
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            )}
            {status.kind === "error" && (
              <p className="text-[12px] text-destructive">
                Failed to read file: {status.message}
              </p>
            )}
            {status.kind === "binary" && (
              <p className="text-[12px] text-muted-foreground">
                Binary file — cannot render as markdown.
              </p>
            )}
            {status.kind === "toolarge" && (
              <p className="text-[12px] text-muted-foreground">
                File is {status.size} bytes; limit {status.limit}.
              </p>
            )}
            {status.kind === "ready" && (
              <Streamdown
                className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                components={components}
              >
                {status.content}
              </Streamdown>
            )}
          </>
        )}
      </div>
    </div>
  );
}
