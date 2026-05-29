import { memo } from "react";
import type { GitHistoryTab } from "@/modules/tabs";
import { GitHistoryPane, type GitHistorySearchHandle } from "./GitHistoryPane";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  gitHistories: GitHistoryTab[];
  activeId: number;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onSearchHandle?: (handle: GitHistorySearchHandle | null) => void;
};

export const GitHistoryStack = memo(function GitHistoryStack({
  gitHistories,
  activeId,
  onOpenCommitFile,
  onSearchHandle,
}: Props) {
  const active = gitHistories.find((t) => t.id === activeId);
  if (!active) return null;
  return (
    <GitHistoryPane
      key={active.id}
      repoRoot={active.repoRoot}
      onOpenCommitFile={onOpenCommitFile}
      onSearchHandle={onSearchHandle}
    />
  );
});
