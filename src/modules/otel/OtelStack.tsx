import type { OtelTab, Tab } from "@/modules/tabs";
import { OtelDashboardPane } from "./OtelDashboardPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Renders the observability dashboard when an `otel` tab is focused. Mirrors the
 * other singleton `*Stack` selectors (AnalyticsStack, BunqueueStack): it owns the
 * id->pane decision so App.tsx just toggles visibility. Singleton tab, so no
 * per-id keying is needed.
 */
export function OtelStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is OtelTab => t.kind === "otel" && t.id === activeId,
  );
  if (!active) return null;
  return <OtelDashboardPane />;
}
