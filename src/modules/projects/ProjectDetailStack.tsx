import type { ProjectDetailTab, Tab } from "@/modules/tabs";
import { type Project } from "./lib/projects";
import { ProjectDetailPane } from "./ProjectDetailPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenProject: (project: Project) => void;
};

/**
 * Renders the detail page for the focused `project-detail` tab. Mirrors the
 * other `*Stack` selectors: App.tsx toggles container visibility while this
 * owns the id→pane decision. Keyed by `projectId` so each project's page keeps
 * its own state.
 */
export function ProjectDetailStack({ tabs, activeId, onOpenProject }: Props) {
  const active = tabs.find(
    (t): t is ProjectDetailTab =>
      t.kind === "project-detail" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <ProjectDetailPane
      key={active.projectId}
      projectId={active.projectId}
      onOpenProject={onOpenProject}
    />
  );
}
