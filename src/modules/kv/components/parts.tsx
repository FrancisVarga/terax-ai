import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  LockIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { KvStatus } from "../lib/native";

/** Small labeled stat tile. */
export function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-muted/40 px-3 py-2", className)}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Process status pill (running / exited / stopped) with port + auth badges. */
export function StatusBadge({ status }: { status: KvStatus | null }) {
  if (!status) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Spinner className="size-3" />
        loading
      </Badge>
    );
  }
  if (status.running) {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={2} />
        running
      </Badge>
    );
  }
  if (status.exited) {
    return (
      <Badge variant="destructive" className="gap-1">
        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={2} />
        exited
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <HugeiconsIcon icon={CircleIcon} size={12} strokeWidth={2} />
      stopped
    </Badge>
  );
}

export function AuthBadge({ auth }: { auth: boolean }) {
  if (!auth) return null;
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <HugeiconsIcon icon={LockIcon} size={11} strokeWidth={2} />
      auth
    </Badge>
  );
}

/** Redis TYPE badge with a per-type color hint. */
export function TypeBadge({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
        color,
      )}
    >
      {type}
    </span>
  );
}

const TYPE_COLORS: Record<string, string> = {
  string: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  list: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  set: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  zset: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  hash: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  stream: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};
