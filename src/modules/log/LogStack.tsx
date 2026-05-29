import { cn } from "@/lib/utils";
import type { LogTab, Tab } from "@/modules/tabs";
import { LogViewerPane } from "./LogViewerPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

export function LogStack({ tabs, activeId }: Props) {
  const logs = tabs.filter((t): t is LogTab => t.kind === "log");
  if (logs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {logs.map((t) => {
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
            <LogViewerPane path={t.path} visible={visible} />
          </div>
        );
      })}
    </div>
  );
}
