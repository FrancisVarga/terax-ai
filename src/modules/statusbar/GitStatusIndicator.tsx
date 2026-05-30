import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getSourceControlRemoteIndicator,
  type SourceControlSummary,
} from "@/modules/source-control";
import {
  GitBranchIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  sourceControl: SourceControlSummary;
  /** Opens the Source Control side panel when the branch chip is clicked. */
  onOpen?: () => void;
};

/**
 * Compact git status for the bottom status bar: highlighted current branch,
 * dirty-file count, and the ahead/behind sync indicator. Derives everything
 * from the shared SourceControlSummary so it never issues its own git calls.
 */
export function GitStatusIndicator({ sourceControl, onOpen }: Props) {
  const { hasRepo, status, repo, changedCount } = sourceControl;
  if (!hasRepo || (!status && !repo)) return null;

  const isDetached = status?.isDetached ?? repo?.isDetached ?? false;
  const branch = status?.branch ?? repo?.branch ?? "";
  const branchLabel = isDetached ? "detached" : branch;
  const remote = getSourceControlRemoteIndicator(sourceControl);

  const branchTitle = isDetached
    ? `Detached HEAD at ${branch}`
    : `On branch ${branch}. Click to open Source Control.`;

  return (
    <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 font-medium transition-colors",
              // Highlight the current branch so it reads as the active context.
              "bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.12]",
              isDetached && "text-amber-700 dark:text-amber-400",
            )}
          >
            <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={2} />
            <span className="max-w-40 truncate">{branchLabel || "—"}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          {branchTitle}
        </TooltipContent>
      </Tooltip>

      {changedCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 cursor-default items-center gap-0.5">
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={11}
                strokeWidth={2}
              />
              <span>{changedCount}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            {changedCount} changed {changedCount === 1 ? "file" : "files"}
          </TooltipContent>
        </Tooltip>
      ) : null}

      {remote.visible ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 cursor-default items-center tabular-nums">
              {remote.label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64 text-[11px]">
            {remote.title}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
