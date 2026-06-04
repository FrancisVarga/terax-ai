import { useState } from "react";
import {
  ArrowReloadHorizontalIcon,
  Copy01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import type { KvStatus } from "../lib/native";
import { AuthBadge, Stat, StatusBadge } from "./parts";

/**
 * Dashboard header: DBSIZE, copyable URL, refresh, destructive flush-all (with
 * a confirm step), and a status pill with port + auth badges.
 */
export function KvToolbar({
  status,
  dbsize,
  busy,
  onRefresh,
  onFlushAll,
  onRestart,
}: {
  status: KvStatus | null;
  dbsize: number | null;
  busy: boolean;
  onRefresh: () => void;
  onFlushAll: () => Promise<void>;
  onRestart: () => void;
}) {
  const [flushing, setFlushing] = useState(false);
  const url = status?.url ?? "";

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Connection URL copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const flush = async () => {
    setFlushing(true);
    try {
      await onFlushAll();
      toast.success("Database flushed");
    } catch (e) {
      toast.error(`Flush failed: ${String(e)}`);
    } finally {
      setFlushing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Key-Value Store</h2>
          <StatusBadge status={status} />
          {status ? <AuthBadge auth={status.auth} /> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={busy}
            title="Rescan keys"
          >
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={14}
              strokeWidth={1.75}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRestart}
            disabled={busy}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            Restart
          </Button>
          <FlushButton
            flushing={flushing}
            disabled={!status?.running}
            onConfirm={() => void flush()}
          />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Keys (DBSIZE)" value={dbsize ?? "-"} />
        <Stat label="Port" value={status?.port ?? "-"} />
        <Stat
          label="Connection"
          value={
            <button
              type="button"
              onClick={() => void copyUrl()}
              disabled={!url}
              className="flex w-full items-center gap-1.5 truncate text-left disabled:opacity-50"
              title={url ? `Copy ${url}` : undefined}
            >
              <span className="truncate">{url || "-"}</span>
              {url ? (
                <HugeiconsIcon
                  icon={Copy01Icon}
                  size={12}
                  strokeWidth={1.75}
                  className="shrink-0 text-muted-foreground"
                />
              ) : null}
            </button>
          }
        />
        <Stat label="Backend" value={status?.sidecar ? "sidecar" : "in-process"} />
      </div>
    </div>
  );
}

function FlushButton({
  flushing,
  disabled,
  onConfirm,
}: {
  flushing: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={disabled || flushing}>
          {flushing ? (
            <Spinner className="size-3.5" />
          ) : (
            <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
          )}
          Flush all
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Flush the entire database?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes every key in the KV store. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Flush all keys
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
