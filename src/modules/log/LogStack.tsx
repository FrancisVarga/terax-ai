import { memo } from "react";
import { cn } from "@/lib/utils";
import type { LogTab } from "@/modules/tabs";
import { LogViewerPane } from "./LogViewerPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  logs: LogTab[];
  activeId: number;
};

export const LogStack = memo(function LogStack({ logs, activeId }: Props) {
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
});
