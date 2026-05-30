import { memo } from "react";
import type { AiDiffTab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  /** Pre-filtered, referentially-stable slice (see `useStableTabSlice`). */
  aiDiffs: AiDiffTab[];
  activeId: number;
  onAccept: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
};

export const AiDiffStack = memo(function AiDiffStack({
  aiDiffs,
  activeId,
  onAccept,
  onReject,
}: Props) {
  const active = aiDiffs.find((t) => t.id === activeId);
  if (!active) return null;
  return (
    <div className="h-full w-full">
      <AiDiffPane
        key={active.id}
        path={active.path}
        originalContent={active.originalContent}
        proposedContent={active.proposedContent}
        status={active.status}
        isNewFile={active.isNewFile}
        onAccept={() => onAccept(active.approvalId)}
        onReject={() => onReject(active.approvalId)}
      />
    </div>
  );
});
