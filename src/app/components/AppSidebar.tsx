import type { RefObject } from "react";
import {
  FileExplorer,
  type FileExplorerHandle,
} from "@/modules/explorer";
import { ProjectsPanel, type Project } from "@/modules/projects";
import {
  SourceControlPanel,
  useSourceControl,
} from "@/modules/source-control";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";

type SourceControl = ReturnType<typeof useSourceControl>;

type AppSidebarProps = {
  view: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  explorerRef: RefObject<FileExplorerHandle | null>;
  /** True when this window is pinned to a project; highlights the Files rail. */
  isProject: boolean;
  /** Explorer root — remote SFTP root when browsing remotely, else local. */
  rootPath: string | null;
  /** Truthy while a remote browse is active (enables the exit-remote affordance). */
  remoteActive: boolean;
  sourceControl: SourceControl;

  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed: (from: string, to: string) => void;
  onPathDeleted: (path: string) => void;
  onRevealInTerminal: (path: string) => void;
  onAttachToAgent: (path: string) => void;
  onOpenMarkdownPreview: (path: string) => void;
  onOpenDataPreview: (path: string) => void;
  onAddToProjects: (path: string) => void;
  onExitRemote: () => void;

  onOpenProject: (project: Project) => void;
  onOpenDiff: Parameters<typeof SourceControlPanel>[0]["onOpenDiff"];
  onOpenGitGraph: () => void;
};

/**
 * Inner content of the left sidebar: the active-view panel switch (explorer,
 * ssh-remote, docker, projects, s3, source-control) plus the rail. The
 * resizable panel chrome lives in AppLayout. Extracted from App.tsx.
 */
export function AppSidebar({
  view,
  onSelectView,
  explorerRef,
  isProject,
  rootPath,
  remoteActive,
  sourceControl,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  onRevealInTerminal,
  onAttachToAgent,
  onOpenMarkdownPreview,
  onOpenDataPreview,
  onAddToProjects,
  onExitRemote,
  onOpenProject,
  onOpenDiff,
  onOpenGitGraph,
}: AppSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
      <div className="min-h-0 flex-1">
        {view === "explorer" ? (
          <FileExplorer
            ref={explorerRef}
            rootPath={rootPath}
            onOpenFile={onOpenFile}
            onPathRenamed={onPathRenamed}
            onPathDeleted={onPathDeleted}
            onRevealInTerminal={onRevealInTerminal}
            onAttachToAgent={onAttachToAgent}
            onOpenMarkdownPreview={onOpenMarkdownPreview}
            onOpenDataPreview={onOpenDataPreview}
            onAddToProjects={onAddToProjects}
            onExitRemote={remoteActive ? onExitRemote : undefined}
          />
        ) : view === "projects" ? (
          <ProjectsPanel onOpenProject={onOpenProject} />
        ) : (
          <SourceControlPanel
            open
            sourceControl={sourceControl}
            onOpenDiff={onOpenDiff}
            onOpenGitGraph={onOpenGitGraph}
          />
        )}
      </div>
      <SidebarRail
        activeView={view}
        onSelectView={onSelectView}
        changedCount={sourceControl.changedCount}
        isProject={isProject}
      />
    </div>
  );
}
