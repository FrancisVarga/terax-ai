import type { DataGridMasterTab, Tab } from "@/modules/tabs";
import { DataGridMasterPane } from "./DataGridMasterPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Renders the data-grid-master showcase when its singleton tab is focused.
 * Mirrors the other singleton `*Stack` selectors (OtelStack, AnalyticsStack):
 * App.tsx just toggles visibility, this owns the id->pane decision. Kept mounted
 * so the grid's virtualized DOM + scroll/sort state survive a tab switch.
 */
export function DataGridMasterStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is DataGridMasterTab =>
      t.kind === "data-grid-master" && t.id === activeId,
  );
  return <DataGridMasterPane visible={active != null} />;
}
