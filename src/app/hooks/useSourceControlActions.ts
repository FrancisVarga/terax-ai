import { useCallback } from "react";
import { native } from "@/modules/ai/lib/native";
import type { useSourceControl } from "@/modules/source-control";

type SourceControl = ReturnType<typeof useSourceControl>;

type OpenCommitHistoryTab = (args: {
  repoRoot: string;
  branch: string | null;
}) => void;

type UseSourceControlActionsArgs = {
  sourceControl: SourceControl;
  /** Resolved git context path for the active tab (null when none applies). */
  sourceControlContextPath: string | null;
  openCommitHistoryTab: OpenCommitHistoryTab;
  /** Toggle/cycle the left sidebar to a given view. */
  cycleSidebarView: (view: "source-control") => void;
};

/**
 * Source-control actions: toggling the SCM sidebar view and opening the commit
 * history (git graph) tab for the active tab's repo — resolving the repo via
 * the already-loaded `sourceControl` state when possible, else a one-off git
 * resolve. Extracted from App.tsx.
 */
export function useSourceControlActions({
  sourceControl,
  sourceControlContextPath,
  openCommitHistoryTab,
  cycleSidebarView,
}: UseSourceControlActionsArgs) {
  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    sourceControlContextPath,
  ]);

  return { toggleSourceControl, openGitGraphFromContext };
}
