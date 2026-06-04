import { useEffect, useState } from "react";
import { CloudServerIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { S3ConnectionsDialog } from "./S3ConnectionsDialog";
import { S3ObjectPreview } from "./S3ObjectPreview";
import { S3Tree } from "./S3Tree";
import { useS3Connections } from "./lib/useS3Connections";

type Props = {
  visible: boolean;
  /** This window's project root — threaded to the tree so its (local-only)
   * mutations target this project's localfs server. `null` when no project. */
  projectDir: string | null;
  /** This project's local connection id — auto-selected so the picker always
   * lands on the current project's store, not the alphabetical first. `null`
   * until seeded. */
  preferredConnId: string | null;
};

/** The object the user has selected in the tree, with the connection context
 * needed to fetch it. */
type Selection = {
  connId: string;
  bucket: string;
  key: string;
};

/**
 * Full S3 tab body: a fixed-width tree on the left (connection → buckets →
 * prefixes → objects) and the selected object's preview on the right. A header
 * shows the active connection plus a "Manage connections" button that toggles
 * `S3ConnectionsDialog`. When several connections exist, the first is the
 * default active one; a small picker lets the user switch.
 */
export function S3Browser({ visible, projectDir, preferredConnId }: Props) {
  const { connections, loading, error } = useS3Connections();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Tracks whether the user has manually picked a connection this session, so an
  // explicit choice isn't overridden when the project's connection (re)seeds.
  const [userPicked, setUserPicked] = useState(false);

  // Default the active connection to THIS PROJECT's local connection
  // (`preferredConnId`) so the S3 tab always opens on the current project's
  // store. Fall back to the first connection only when the project's connection
  // isn't available (e.g. the local server is off, or a no-project window). A
  // manual pick (`userPicked`) is respected; the preferred connection still
  // wins on a project switch because `preferredConnId` changing re-runs this.
  useEffect(() => {
    if (connections.length === 0) {
      setActiveId(null);
      return;
    }
    const preferred =
      preferredConnId &&
      connections.some((c) => c.id === preferredConnId)
        ? preferredConnId
        : null;
    setActiveId((prev) => {
      // Project's connection exists and the user hasn't overridden -> select it.
      if (preferred && !userPicked) return preferred;
      // Keep a still-valid current selection.
      if (prev && connections.some((c) => c.id === prev)) return prev;
      // Otherwise prefer the project's connection, else the first.
      return preferred ?? connections[0].id;
    });
  }, [connections, preferredConnId, userPicked]);

  // When the project (and thus its preferred connection) changes, drop any prior
  // manual override so the new project's store is auto-selected.
  useEffect(() => {
    setUserPicked(false);
  }, [preferredConnId]);

  const selectConnection = (id: string) => {
    setUserPicked(true);
    setActiveId(id);
  };

  // A selection only makes sense for the active connection.
  useEffect(() => {
    setSelection((prev) =>
      prev && prev.connId === activeId ? prev : null,
    );
  }, [activeId]);

  const active = connections.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Header: active connection name + manage button. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[12px]">
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        {connections.length > 1 ? (
          <Select value={activeId ?? ""} onValueChange={selectConnection}>
            <SelectTrigger
              size="sm"
              className="h-6 w-auto gap-1.5 px-1.5 text-[12px] font-medium text-foreground"
            >
              <SelectValue placeholder="Select connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-[12px]">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate font-medium text-foreground/80">
            {active ? active.name : "S3"}
          </span>
        )}

        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => setDialogOpen(true)}
        >
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.75} />
          Manage connections
        </Button>
      </div>

      {/* Body: tree + preview. */}
      <div className="flex min-h-0 flex-1">
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Loading connections…</span>
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
            {error}
          </div>
        ) : !active ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-[12px] text-muted-foreground">
              No S3 connections configured.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              Add a connection
            </Button>
          </div>
        ) : (
          <>
            <div className="w-[260px] shrink-0 border-r border-border/60">
              <S3Tree
                connection={active}
                projectDir={projectDir}
                selectedKey={selection?.key ?? null}
                onOpenObject={(connId, bucket, key) =>
                  setSelection({ connId, bucket, key })
                }
              />
            </div>
            <div className="min-w-0 flex-1">
              {selection ? (
                <S3ObjectPreview
                  // Remount the preview when the selection changes so each
                  // viewer starts from a clean fetch rather than stale state.
                  key={`${selection.connId}:${selection.bucket}:${selection.key}`}
                  connId={selection.connId}
                  bucket={selection.bucket}
                  objectKey={selection.key}
                  visible={visible}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
                  Select an object to preview it.
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <S3ConnectionsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
