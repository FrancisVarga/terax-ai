import type { ComponentProps, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
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
import { DockerDetailStack, DockerStack } from "@/modules/docker";
import { SshStack } from "@/modules/ssh-remote";
import { AnalyticsStack } from "@/modules/agentlytics";
import { OtelStack } from "@/modules/otel";
import { KvStack } from "@/modules/kv";
import { CcusageStack } from "@/modules/ccusage";
import { ProjectsDashboard, ProjectDetailStack } from "@/modules/projects";
import type { SearchAddon } from "@xterm/addon-search";

/**
 * Every tab stack is kept mounted and toggled by visibility (never unmounted on
 * switch) so terminal/editor/grid scroll + session state survives tab changes.
 * `padded` mirrors the original per-stack padding; full-bleed stacks (git
 * history, projects, docker, analytics) omit it.
 */
// Shared house easing (matches the tab bar + AI input bar).
const TAB_FADE_EASE = [0.16, 1, 0.3, 1] as const;

function TabLayer({
  visible,
  padded,
  children,
}: {
  visible: boolean;
  padded: boolean;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  // Cross-fade on tab switch. The keep-alive stack NEVER unmounts (terminal /
  // editor / scroll state must survive), so we can't use AnimatePresence —
  // instead each layer animates its own opacity. `pointer-events-none` +
  // `aria-hidden` follow `visible` immediately so the outgoing layer is
  // click-through the instant it stops being active, even while it's still
  // fading out. A hidden layer settles at opacity 0 (no `invisible` class, so
  // it can fade) and stays parked there — at opacity 0 the browser skips its
  // paint, so kept-alive content costs nothing while inactive.
  return (
    <motion.div
      className={cn(
        "absolute inset-0",
        padded && "px-3 pt-2 pb-2",
        !visible && "pointer-events-none",
      )}
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: TAB_FADE_EASE }}
      aria-hidden={!visible}
    >
      {children}
    </motion.div>
  );
}

export type TabStackRouterProps = {
  tabs: Tab[];
  // Referentially-stable per-kind slices (see `useStableTabSlice`). The content
  // stacks subscribe to their own slice so a terminal cwd change does not
  // reconcile the editor/preview/data/git subtrees.
  editorTabs: ComponentProps<typeof EditorStack>["editors"];
  previewTabs: ComponentProps<typeof PreviewStack>["previews"];
  markdownTabs: ComponentProps<typeof MarkdownStack>["markdowns"];
  imageTabs: ComponentProps<typeof ImageStack>["images"];
  logTabs: ComponentProps<typeof LogStack>["logs"];
  dataTabs: ComponentProps<typeof DataStack>["data"];
  aiDiffTabs: ComponentProps<typeof AiDiffStack>["aiDiffs"];
  gitDiffTabs: ComponentProps<typeof GitDiffStack>["gitDiffs"];
  gitHistoryTabs: ComponentProps<typeof GitHistoryStack>["gitHistories"];
  dockerDetailTabs: ComponentProps<typeof DockerDetailStack>["dockerDetails"];
  /** SSH alias for a remote Docker daemon; `null` lists the local daemon. */
  dockerHost: string | null;
  /** Open a container's deep-detail tab from the Docker list tab. */
  onOpenContainer: ComponentProps<typeof DockerStack>["onOpenContainer"];
  /** Connect to a host (opens a terminal) from the SSH list tab. */
  onConnectSsh: ComponentProps<typeof SshStack>["onConnect"];
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
  editorTabs,
  previewTabs,
  markdownTabs,
  imageTabs,
  logTabs,
  dataTabs,
  aiDiffTabs,
  gitDiffTabs,
  gitHistoryTabs,
  dockerDetailTabs,
  dockerHost,
  onOpenContainer,
  onConnectSsh,
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
          editors={editorTabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirty}
          onCloseTab={onCloseEditorTab}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "preview"} padded>
        <PreviewStack
          previews={previewTabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrl}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "markdown"} padded>
        <MarkdownStack markdowns={markdownTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "image"} padded>
        <ImageStack images={imageTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "log"} padded>
        <LogStack logs={logTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "data"} padded>
        <DataStack data={dataTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "s3"} padded>
        <S3Stack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "docker"} padded={false}>
        <DockerStack
          tabs={tabs}
          activeId={activeId}
          host={dockerHost}
          onOpenContainer={onOpenContainer}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "ssh"} padded={false}>
        <SshStack tabs={tabs} activeId={activeId} onConnect={onConnectSsh} />
      </TabLayer>
      <TabLayer visible={activeKind === "ai-diff"} padded>
        <AiDiffStack
          aiDiffs={aiDiffTabs}
          activeId={activeId}
          onAccept={(id) => onApprovalRespond(id, true)}
          onReject={(id) => onApprovalRespond(id, false)}
        />
      </TabLayer>
      <TabLayer visible={isGitDiff} padded>
        <GitDiffStack gitDiffs={gitDiffTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "git-history"} padded={false}>
        <GitHistoryStack
          gitHistories={gitHistoryTabs}
          activeId={activeId}
          onOpenCommitFile={onOpenCommitFile}
          onSearchHandle={onGitHistorySearchHandle}
        />
      </TabLayer>
      <TabLayer visible={activeKind === "bunqueue"} padded={false}>
        <BunqueueStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "docker-detail"} padded>
        <DockerDetailStack dockerDetails={dockerDetailTabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "agentlytics"} padded={false}>
        <AnalyticsStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "otel"} padded={false}>
        <OtelStack tabs={tabs} activeId={activeId} />
      </TabLayer>
      <TabLayer visible={activeKind === "kv"} padded={false}>
        <KvStack tabs={tabs} activeId={activeId} />
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
