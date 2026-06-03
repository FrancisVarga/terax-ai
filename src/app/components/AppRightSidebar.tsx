import {
  AgentsPanel,
  AiPanel,
  RightSidebarRail,
  type RightSidebarViewId,
} from "@/modules/right-sidebar";
import { TaskRunnerPanel } from "@/modules/task-runner";
import { GitHubActionsPanel } from "@/modules/github-actions";
import { GitHubIssuesPanel } from "@/modules/github-issues";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";

type AppRightSidebarProps = {
  view: RightSidebarViewId;
  onSelectView: (view: RightSidebarViewId) => void;
  hasComposer: boolean;
  onActivateAgent: (tabId: number, leafId: number) => void;
  onActivateLocalAgent: () => void;
};

/**
 * Inner content of the right sidebar: the per-view panel switch plus the rail.
 * The surrounding resizable panel chrome lives in AppLayout — this is purely the
 * view-routing + presentation, extracted from App.tsx.
 */
export function AppRightSidebar({
  view,
  onSelectView,
  hasComposer,
  onActivateAgent,
  onActivateLocalAgent,
}: AppRightSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card">
      <div className="min-h-0 flex-1">
        {view === "agents" ? (
          <AgentsPanel
            onActivate={onActivateAgent}
            onActivateLocal={onActivateLocalAgent}
          />
        ) : view === "tasks" ? (
          <TaskRunnerPanel />
        ) : view === "actions" ? (
          <GitHubActionsPanel />
        ) : view === "issues" ? (
          <GitHubIssuesPanel />
        ) : (
          <AiPanel
            hasComposer={hasComposer}
            onConnect={() => void openSettingsWindow("models")}
          />
        )}
      </div>
      <RightSidebarRail activeView={view} onSelectView={onSelectView} />
    </div>
  );
}
