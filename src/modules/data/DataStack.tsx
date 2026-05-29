import { memo } from "react";
import { cn } from "@/lib/utils";
import type { DataTab } from "@/modules/tabs";
import { DataPane } from "./DataPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  data: DataTab[];
  activeId: number;
};

/**
 * Keeps every open data tab mounted and toggles visibility, mirroring the
 * other `*Stack` components. AG Grid holds virtualized DOM and scroll/sort
 * state, so unmounting on tab switch would discard the user's place in a large
 * table — visibility-only switching preserves it.
 */
export const DataStack = memo(function DataStack({ data, activeId }: Props) {
  if (data.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {data.map((t) => {
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
            <DataPane path={t.path} format={t.format} visible={visible} />
          </div>
        );
      })}
    </div>
  );
});
