import { cn } from "@/lib/utils";
import type { DataTab, Tab } from "@/modules/tabs";
import { DataPane } from "./DataPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Keeps every open data tab mounted and toggles visibility, mirroring the
 * other `*Stack` components. AG Grid holds virtualized DOM and scroll/sort
 * state, so unmounting on tab switch would discard the user's place in a large
 * table — visibility-only switching preserves it.
 */
export function DataStack({ tabs, activeId }: Props) {
  const data = tabs.filter((t): t is DataTab => t.kind === "data");
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
}
