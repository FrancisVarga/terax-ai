import { cn } from "@/lib/utils";
import {
  CloudIcon,
  ContainerIcon,
  FolderGitTwoIcon,
  FolderLibraryIcon,
  FolderTreeIcon,
  ServerStack02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  id: SidebarViewId;
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  badge?: number;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
  /**
   * True when this window is pinned to a project. Marks the "Files" rail item
   * with an accent so the window reads as project-scoped at a glance.
   */
  isProject: boolean;
};

export function SidebarRail({
  activeView,
  onSelectView,
  changedCount,
  isProject,
}: Props) {
  const items: RailItem[] = [
    { id: "explorer", label: "Files", icon: FolderTreeIcon },
    {
      id: "source-control",
      label: "Source Control",
      icon: FolderGitTwoIcon,
      badge: changedCount,
    },
    { id: "ssh-remote", label: "SSH", icon: ServerStack02Icon },
    { id: "docker", label: "Docker", icon: ContainerIcon },
    { id: "projects", label: "Projects", icon: FolderLibraryIcon },
    { id: "s3", label: "S3", icon: CloudIcon },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-t border-border/60 bg-card/85 px-1.5 py-1 backdrop-blur"
    >
      {items.map((item) => {
        const isActive = item.id === activeView;
        const showBadge = !!item.badge && item.badge > 0;
        // The Files item gets a primary accent in a project window so the rail
        // signals "this window is a project" — strongest when Files is the
        // active view, a softer tint when it's not.
        const isProjectFiles = isProject && item.id === "explorer";
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              "group relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[11px] font-medium outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              isProjectFiles &&
                (isActive
                  ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 dark:bg-primary/20"
                  : "text-primary/90 hover:bg-primary/10 hover:text-primary"),
            )}
          >
            <HugeiconsIcon
              icon={item.icon}
              size={14}
              strokeWidth={isActive || isProjectFiles ? 2 : 1.75}
              className="shrink-0 transition-[stroke-width] duration-150"
            />
            <span>{item.label}</span>
            {isProjectFiles ? (
              <span
                className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                aria-hidden
              />
            ) : null}
            {showBadge ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 bg-card px-1 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground/95">
                {item.badge! > 99 ? "99+" : item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
