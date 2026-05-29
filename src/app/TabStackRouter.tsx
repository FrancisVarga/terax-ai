import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Tab } from "@/modules/tabs";
import { TerminalStack, type TerminalPaneHandle } from "@/modules/terminal";
import {
  AiDiffStack,
  EditorStack,
  GitDiffStack,
  type EditorPaneHandle,
} from "@/modules/editor";
import { PreviewStack, type PreviewPaneHandle } from "@/modules/preview";
import { MarkdownStack } from "@/modules/markdown";
import { ImageStack } from "@/modules/image";
import { LogStack } from "@/modules/log";
import { DataStack } from "@/modules/data";
import { S3Stack } from "@/modules/s3";
import {
  GitHistoryStack,
  type GitHistorySearchHandle,
} from "@/modules/git-history";
import { BunqueueStack } from "@/modules/bunqueue";
import { DockerDetailStack } from "@/modules/docker";
import { AnalyticsStack } from "@/modules/agentlytics";
import { CcusageStack } from "@/modules/ccusage";
import { ProjectsDashboard, ProjectDetailStack } from "@/modules/projects";
import type { SearchAddon } from "@xterm/addon-search";

/**
 * Every tab stack is kept mounted and toggled by visibility (never unmounted on
 * switch) so terminal/editor/grid scroll + session state survives tab changes.
 * `padded` mirrors the original per-stack padding; full-bleed stacks (git
 * history, projects, docker, analytics) omit it.
 */
function TabLayer({
  visible,
  padded,
  children,
}: {
  visible: boolean;
  padded: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute inset-0",
        padded && "px-3 pt-2 pb-2",
        !visible && "invisible pointer-events-none",
      )}
      aria-hidden={!visible}
    >
      {children}
    </div>
  );
}

export type TabStackRouterProps = {
  tabs: Tab[];
  activeId: number;
  activeKind: Tab["kind"] | undefined;
  registerTerminalHandle: (id: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onTerminalCwd: (leafId: number, cwd: string) => void;
  onLeafExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
  onClosePane: (leafId: number) => void;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onEditorDirty: (id: number, dirty: boolean) => void;
  onCloseEditorTab: (id: number) => void;
  registerPreviewHandle: (id: number, handle: PreviewPaneHandle | null) => void;
  onPreviewUrl: (id: number, url: string) => void;
  onApprovalRespond: (approvalId: string, approved: boolean) => void;
  onOpenCommitFile: (
    ...args: Parameters<
      NonNullable<React.ComponentProps<typeof GitHistoryStack>["onOpenCommitFile"]>
    >
  ) => void;
  onGitHistorySearchHandle: (handle: GitHistorySearchHandle | null) => void;
  onOpenProject: (
    ...args: Parameters<React.ComponentProps<typeof ProjectsDashboard>["onOpenProject"]>
  ) => void;
  onOpenProjectDetail: (
    ...args: Parameters<React.ComponentProps<typeof ProjectsDashboard>["onOpenDetail"]>
  ) => void;
};

/**
 * Renders the kept-alive stack for every tab kind, visibility-gated by the
 * active tab. Lifted out of App.tsx: App owns the state and callbacks, this
 * component owns the layout and the stack-component wiring.
 */
export function TabStackRouter({
  tabs,
  activeId,
  activeKind,
  registerTerminalHandle,
  onSearchReady,
  onTerminalCwd,
  onLeafExit,
  onFocusLeaf,
  onClosePane,
  registerEditorHandle,
  onEditorDirty,
  onCloseEditorTab,
  registerPreviewHandle,
  onPreviewUrl,
  onApprovalRespond,
  onOpenCommitFile,
  onGitHistorySearchHandle,
  onOpenProject,
  onOpenProjectDetail,
}: TabStackRouterProps) {
  const isGitDiff = activeKind === "git-diff" || activeKind === "git-commit-file";
  return (
    <div className="relative h-full min-h-0">
      <TabLayer visible={activeKind === "terminal"} padded>
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerTerminalHandle}
          onSearchReady={onSearchReady}
          onCwd={onTerminalCwd}
          onExit={onLeafExit}
          onFocusLeaf={onFocusLeaf}
          onClosePane={onClosePane}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "editor"} padded>
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirty}
          onCloseTab={onCloseEditorTab}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "preview"} padded>
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrl}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "markdown"} padded>
        <MarkdownStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "image"} padded>
        <ImageStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "log"} padded>
        <LogStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "data"} padded>
        <DataStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "s3"} padded>
        <S3Stack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "ai-diff"} padded>
        <AiDiffStack
          tabs={tabs}
          activeId={activeId}
          onAccept={(id) => onApprovalRespond(id, true)}
          onReject={(id) => onApprovalRespond(id, false)}
        />
      </TabLayer>
      <TabLayer visible={isGitDiff} padded>
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "git-history"} padded={false}>
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={onOpenCommitFile}
          onSearchHandle={onGitHistorySearchHandle}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "bunqueue"} padded={false}>
        <BunqueueStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "docker-detail"} padded>
        <DockerDetailStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "agentlytics"} padded={false}>
        <AnalyticsStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "ccusage"} padded={false}>
        <CcusageStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "projects"} padded={false}>
        <ProjectsDashboard
          onOpenProject={onOpenProject}
          onOpenDetail={onOpenProjectDetail}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "project-detail"} padded={false}>
        <ProjectDetailStack
          tabs={tabs}
          activeId={activeId}
          onOpenProject={onOpenProject}
        />
      </TabLayer>
    </div>
  );
}
