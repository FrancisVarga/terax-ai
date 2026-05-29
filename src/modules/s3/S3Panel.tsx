import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  CloudIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { S3ConnectionsDialog } from "./S3ConnectionsDialog";
import { useS3Connections } from "./lib/useS3Connections";
import type { S3Connection } from "./lib/types";

type Props = {
  /** Open (or focus) the S3 browser tab in the main content area. */
  onOpenBrowser: () => void;
};

/**
 * Sidebar panel for the S3 browser. Mirrors `SshRemotePanel`: it lists the
 * configured connections and lets the user manage credentials, but the actual
 * tree + preview lives in a main-content tab (opened via `onOpenBrowser`) — the
 * panel is just the launcher and connection manager.
 */
export function S3Panel({ onOpenBrowser }: Props) {
  const { connections, loading, error } = useS3Connections();
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          S3 Connections
        </span>
        <button
          type="button"
          aria-label="Manage S3 connections"
          onClick={() => setManageOpen(true)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <HugeiconsIcon icon={Settings02Icon} size={14} strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Loading connections…</span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-2 py-3 text-[12px] text-destructive">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={14}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
            />
            <span className="break-words">{error}</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="px-2 py-3 text-[12px] leading-relaxed text-muted-foreground">
            No S3 connections yet. Click the{" "}
            <span className="inline-flex translate-y-0.5">
              <HugeiconsIcon icon={Settings02Icon} size={12} strokeWidth={1.75} />
            </span>{" "}
            gear to add one.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {connections.map((conn) => (
              <S3ConnectionRow
                key={conn.id}
                conn={conn}
                onOpen={onOpenBrowser}
              />
            ))}
          </ul>
        )}
      </div>

      <S3ConnectionsDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}

function S3ConnectionRow({
  conn,
  onOpen,
}: {
  conn: S3Connection;
  onOpen: () => void;
}) {
  const subtitle = conn.endpoint ?? conn.region;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`Open S3 browser: ${conn.name}`}
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
          "hover:bg-foreground/[0.055] focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        <HugeiconsIcon
          icon={CloudIcon}
          size={15}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground group-hover:text-foreground"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {conn.name}
          </span>
          {subtitle ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
