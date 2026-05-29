import { memo } from "react";
import { cn } from "@/lib/utils";
import type { MarkdownTab } from "@/modules/tabs";
import { MarkdownSplitPane } from "./MarkdownSplitPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  markdowns: MarkdownTab[];
  activeId: number;
  onDirtyChange?: (id: number, dirty: boolean) => void;
};

export const MarkdownStack = memo(function MarkdownStack({
  markdowns,
  activeId,
  onDirtyChange,
}: Props) {
  if (markdowns.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <MarkdownSplitPane
              path={t.path}
              visible={visible}
              onDirtyChange={(dirty) => onDirtyChange?.(t.id, dirty)}
            />
          </div>
        );
      })}
    </div>
  );
});
