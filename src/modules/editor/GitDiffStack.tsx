import { memo } from "react";
import type {
  GitCommitFileDiffTab,
  GitDiffTab,
} from "@/modules/tabs";
import { GitDiffPane } from "./GitDiffPane";

type Props = {
  /** Pre-filtered, referentially-stable slice of both git-diff kinds. */
  gitDiffs: (GitDiffTab | GitCommitFileDiffTab)[];
  activeId: number;
};

export const GitDiffStack = memo(function GitDiffStack({
  gitDiffs,
  activeId,
}: Props) {
  const active = gitDiffs.find((t) => t.id === activeId);
  if (!active) return null;
  if (active.kind === "git-diff") {
    return (
      <div className="h-full w-full">
        <GitDiffPane
          key={active.id}
          active
          source={{
            kind: "working",
            repoRoot: active.repoRoot,
            path: active.path,
            mode: active.mode,
            originalPath: active.originalPath,
          }}
        />
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <GitDiffPane
        key={active.id}
        active
        source={{
          kind: "commit",
          repoRoot: active.repoRoot,
          sha: active.sha,
          path: active.path,
          originalPath: active.originalPath,
        }}
        chipLabel={active.shortSha}
      />
    </div>
  );
});
