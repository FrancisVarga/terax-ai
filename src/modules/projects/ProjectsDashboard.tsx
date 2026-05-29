import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  FolderLibraryIcon,
  MoreVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { AddProjectDialog } from "./AddProjectDialog";
import { type Project } from "./lib/projects";
import { useProjectsStore } from "./store/projectsStore";

type Props = {
  /** Open the project (spawns a window rooted at the project folder). */
  onOpenProject: (project: Project) => void;
  /** Open the project's detail page in a main-area tab. */
  onOpenDetail: (project: Project) => void;
};

/**
 * Full-width projects list rendered in the main workspace area (the default
 * startup surface). Mirrors {@link ProjectsPanel}'s data wiring but lays
 * projects out as a roomy list suited to the center pane. Each row exposes a
 * kebab button that opens the project's detail page.
 */
export function ProjectsDashboard({ onOpenProject, onOpenDetail }: Props) {
  const hydrated = useProjectsStore((s) => s.hydrated);
  const hydrate = useProjectsStore((s) => s.hydrate);
  const projects = useProjectsStore((s) => s.projects);
  const upsert = useProjectsStore((s) => s.upsert);
  const remove = useProjectsStore((s) => s.remove);
  const [editing, setEditing] = useState<Project | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const sorted = [...projects].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 pt-6 pb-4">
        <HugeiconsIcon
          icon={FolderLibraryIcon}
          size={20}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <h1 className="text-lg font-semibold text-foreground">Projects</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {!hydrated ? null : sorted.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-[13px] leading-relaxed text-muted-foreground">
            No projects yet. Right-click a folder in the explorer and choose{" "}
            <span className="font-medium text-foreground/80">
              Add to Projects
            </span>
            .
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-1">
            {sorted.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onOpen={() => onOpenProject(p)}
                onOpenDetail={() => onOpenDetail(p)}
                onEdit={() => setEditing(p)}
                onRemove={() => remove(p.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <AddProjectDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        path={null}
        editing={editing}
        onSubmit={(project) => upsert(project)}
      />
    </div>
  );
}

function ProjectRow({
  project,
  onOpen,
  onOpenDetail,
  onEdit,
  onRemove,
}: {
  project: Project;
  onOpen: () => void;
  onOpenDetail: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-4 py-3 transition-colors",
              "hover:border-border hover:bg-foreground/[0.04]",
            )}
          >
            <button
              type="button"
              onClick={onOpen}
              title={project.path}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <HugeiconsIcon
                icon={FolderLibraryIcon}
                size={18}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground group-hover:text-foreground"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-foreground">
                    {project.name}
                  </span>
                  {project.tags.length > 0 ? (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 px-1.5 text-[9px] leading-none"
                    >
                      {project.tags[0]}
                      {project.tags.length > 1
                        ? ` +${project.tags.length - 1}`
                        : ""}
                    </Badge>
                  ) : null}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {project.path}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenDetail}
              title="Open project details"
              aria-label="Open project details"
              className={cn(
                "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
                "hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
              )}
            >
              <HugeiconsIcon
                icon={MoreVerticalIcon}
                size={16}
                strokeWidth={1.75}
              />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          <ContextMenuItem onSelect={onOpenDetail}>
            Open details
          </ContextMenuItem>
          <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={onEdit}>Edit…</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={(e) => {
              e.preventDefault();
              if (isConfirming) onRemove();
              else setIsConfirming(true);
            }}
            onMouseLeave={() => setTimeout(() => setIsConfirming(false), 1500)}
          >
            {isConfirming ? "Click again to confirm" : "Remove"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
