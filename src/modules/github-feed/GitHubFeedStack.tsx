import type { GithubFeedTab, Tab } from "@/modules/tabs";
import { GitHubFeedPane } from "./panels/GitHubFeedPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/**
 * Renders the GitHub feed dashboard when a `github-feed` tab is focused.
 * Mirrors the other `*Stack` selectors (e.g. CcusageStack): it owns the
 * id→pane decision so App.tsx just toggles visibility. The dashboard is a
 * singleton tab, so no per-id keying is needed.
 */
export function GitHubFeedStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is GithubFeedTab => t.kind === "github-feed" && t.id === activeId,
  );
  if (!active) return null;
  return <GitHubFeedPane />;
}
