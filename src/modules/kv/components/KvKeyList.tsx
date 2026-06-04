import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { KvKeyInfo } from "../lib/native";
import { formatTtl } from "../lib/format";
import { EmptyHint, TypeBadge } from "./parts";

/**
 * Left pane: glob/search input feeding the SCAN `pattern`, plus a paginated key
 * list driven by the scan cursor ("load more"). Each row shows the key, a type
 * badge, and a humanized TTL.
 */
export function KvKeyList({
  keys,
  loading,
  hasMore,
  pattern,
  selectedKey,
  onPatternChange,
  onLoadMore,
  onSelect,
}: {
  keys: KvKeyInfo[];
  loading: boolean;
  hasMore: boolean;
  pattern: string;
  selectedKey: string | null;
  onPatternChange: (p: string) => void;
  onLoadMore: () => void;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="relative shrink-0">
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          strokeWidth={1.75}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={pattern}
          onChange={(e) => onPatternChange(e.target.value)}
          placeholder="Glob pattern, e.g. user:*"
          spellCheck={false}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60">
        {keys.length === 0 && !loading ? (
          <div className="p-3">
            <EmptyHint>
              {pattern ? "No keys match this pattern." : "No keys yet."}
            </EmptyHint>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {keys.map((k) => (
              <li key={k.key}>
                <button
                  type="button"
                  onClick={() => onSelect(k.key)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-foreground/5",
                    selectedKey === k.key && "bg-primary/10",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {k.key}
                  </span>
                  <TypeBadge type={k.type} />
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                    {formatTtl(k.ttl_ms)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore ? (
          <div className="p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={onLoadMore}
              disabled={loading}
            >
              {loading ? <Spinner className="size-3.5" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
