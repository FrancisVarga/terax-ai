import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { AddProjectDialog } from "./AddProjectDialog";
import { type Project } from "./lib/projects";
import { useProjectsStore } from "./store/projectsStore";

type Props = {
  /** Open (or focus) the detail tab for a project in the main area. */
  onOpenProject: (project: Project) => void;
};

/**
 * Sidebar panel listing curated projects. Clicking a row opens its detail tab
 * in the main area. Right-click exposes edit/remove. Projects are added from
 * the explorer's folder context menu ("Add to Projects").
 */
export function ProjectsPanel({ onOpenProject }: Props) {
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
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          Projects
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!hydrated ? null : sorted.length === 0 ? (
          <div className="px-2 py-3 text-[12px] leading-relaxed text-muted-foreground">
            No projects yet. Right-click a folder in the explorer and choose{" "}
            <span className="font-medium text-foreground/80">
              Add to Projects
            </span>
            .
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                onOpen={() => onOpenProject(p)}
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
  onEdit,
  onRemove,
}: {
  project: Project;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            title={project.path}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
              "hover:bg-foreground/[0.055] focus-visible:ring-2 focus-visible:ring-primary/40",
            )}
          >
            <HugeiconsIcon
              icon={FolderLibraryIcon}
              size={15}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground group-hover:text-foreground"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium text-foreground">
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
              <span className="truncate text-[11px] text-muted-foreground">
                {project.path}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
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
