import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { MarkdownSplitPane } from "./MarkdownSplitPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange?: (id: number, dirty: boolean) => void;
};

export function MarkdownStack({ tabs, activeId, onDirtyChange }: Props) {
  const markdowns = tabs.filter((t): t is MarkdownTab => t.kind === "markdown");
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
}
