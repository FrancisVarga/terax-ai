import type { AnalyticsTab, Tab } from "@/modules/tabs";
import { AnalyticsDashboardPane } from "./AnalyticsDashboardPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Renders the analytics dashboard when an `agentlytics` tab is focused. Mirrors
 * the other `*Stack` selectors (e.g. DockerDetailStack): it owns the id→pane
 * decision so App.tsx just toggles visibility. The dashboard is a singleton
 * tab, so no per-id keying is needed.
 */
export function AnalyticsStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is AnalyticsTab => t.kind === "agentlytics" && t.id === activeId,
  );
  if (!active) return null;
  return <AnalyticsDashboardPane />;
}
