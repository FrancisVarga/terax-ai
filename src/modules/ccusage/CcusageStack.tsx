import type { CcusageTab, Tab } from "@/modules/tabs";
import { CcusageDashboardPane } from "./CcusageDashboardPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Renders the ccusage dashboard when a `ccusage` tab is focused. Mirrors the
 * other `*Stack` selectors (e.g. AnalyticsStack): it owns the id→pane decision
 * so App.tsx just toggles visibility. The dashboard is a singleton tab, so no
 * per-id keying is needed.
 */
export function CcusageStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is CcusageTab => t.kind === "ccusage" && t.id === activeId,
  );
  if (!active) return null;
  return <CcusageDashboardPane />;
}
