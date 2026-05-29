import { cn } from "@/lib/utils";
import type { PreviewTab, Tab } from "@/modules/tabs";
import { EyeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  tabs: Tab[];
  activeId: number;
  onActivate: (id: number) => void;
};

/**
 * Right-sidebar preview view. Lists the open preview tabs and activates one on
 * click. Intentionally does NOT render `PreviewStack` — the stack already lives
 * in the workspace surface, and mounting it twice would double-load the iframes.
 */
export function PreviewPanel({ tabs, activeId, onActivate }: Props) {
  const previews = tabs.filter((t): t is PreviewTab => t.kind === "preview");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Preview
      </div>
      {previews.length === 0 ? (
        <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
          No previews open.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {previews.map((t) => {
            const isActive = t.id === activeId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onActivate(t.id)}
                aria-pressed={isActive}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                  isActive
                    ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={EyeIcon}
                  size={15}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {t.title}
                </span>
                <span className="shrink-0 truncate text-[10px] text-muted-foreground/80">
                  {t.url}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
