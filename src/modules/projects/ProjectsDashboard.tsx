import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  ClockIcon,
  Copy01Icon,
  FolderAddIcon,
  FolderLibraryIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GridIcon,
  HardDriveIcon,
  ListViewIcon,
  MoreVerticalIcon,
  RecordIcon,
  Search01Icon,
  ServerStackIcon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { AddProjectDialog } from "./AddProjectDialog";
import { AddRemoteProjectDialog } from "./AddRemoteProjectDialog";
import {
  normalizePath,
  serverGroupId,
  serverLabel,
  serverOf,
  type Project,
  type ServerKey,
} from "./lib/projects";
import {
  useProjectCardInsights,
  type ProjectCardInsights,
} from "./lib/useProjectCardInsights";
import { useProjectsStore } from "./store/projectsStore";

type Props = {
  /** Open the project (spawns a window rooted at the project folder). */
  onOpenProject: (project: Project) => void;
  /** Open the project's detail page in a main-area tab. */
  onOpenDetail: (project: Project) => void;
};

type SortKey = "name" | "added" | "active";
type Density = "grid" | "list";

/** Compact relative-time formatter (shared shape with the detail pane). */
function relativeTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Full-width projects dashboard rendered in the main workspace area (the
 * default startup surface). Unlike the sidebar {@link ProjectsPanel}, this view
 * is interactive: a toolbar drives live search, tag filtering, sort order and
 * grid/list density, and each card lazily loads compact git + GitHub signals
 * (branch, dirty count, ahead/behind, stars, open issues, last-active time) as
 * it scrolls into view.
 */
export function ProjectsDashboard({ onOpenProject, onOpenDetail }: Props) {
  const hydrated = useProjectsStore((s) => s.hydrated);
  const hydrate = useProjectsStore((s) => s.hydrate);
  const projects = useProjectsStore((s) => s.projects);
  const upsert = useProjectsStore((s) => s.upsert);
  const remove = useProjectsStore((s) => s.remove);
  const hasPath = useProjectsStore((s) => s.hasPath);
  const [editing, setEditing] = useState<Project | null>(null);
  // Path passed to the local add dialog after the native folder picker resolves.
  const [addPath, setAddPath] = useState<string | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [density, setDensity] = useState<Density>("grid");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Native folder picker → prefill the local add dialog. If the chosen folder is
  // already a project we silently no-op (the dialog would reject a dup anyway).
  const pickLocalFolder = async () => {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Add project folder",
    });
    if (typeof picked !== "string") return;
    const norm = normalizePath(picked);
    if (hasPath(norm)) return;
    setAddPath(norm);
  };

  // All tags across projects, sorted, for the filter chip row.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) for (const t of p.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [projects]);

  // Derived list: filter (query + tag) then sort. Pure view state — never
  // triggers any data fetching, so typing stays instant on large lists.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (activeTag && !p.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
    const sorted = [...filtered];
    switch (sort) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "added":
        sorted.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "active":
        // Most-recently-added first as a stable proxy; live activity is shown
        // per-card but isn't known until cards load, so we don't sort on it.
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }
    return sorted;
  }, [projects, query, activeTag, sort]);

  // Recent row: the 10 most-recently-opened projects (ignores search/filter so
  // it's a stable "jump back in" surface). Projects never opened are excluded.
  const recent = useMemo(() => {
    return projects
      .filter((p) => p.lastOpenedAt != null)
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
      .slice(0, 10);
  }, [projects]);

  // Group the (filtered, sorted) visible projects by derived server. Local is
  // pinned first; remote hosts follow alphabetically. Order within each group
  // is preserved from `visible` so the sort toggle still applies per-group.
  const groups = useMemo(() => {
    const map = new Map<string, { key: ServerKey; items: Project[] }>();
    for (const p of visible) {
      const key = serverOf(p.path);
      const id = serverGroupId(key);
      const entry = map.get(id);
      if (entry) entry.items.push(p);
      else map.set(id, { key, items: [p] });
    }
    return [...map.values()].sort((a, b) => {
      if (a.key.kind !== b.key.kind) return a.key.kind === "local" ? -1 : 1;
      return serverLabel(a.key).localeCompare(serverLabel(b.key));
    });
  }, [visible]);

  // Only worth showing server headers when projects span >1 server.
  const showGroups = groups.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header + toolbar */}
      <div className="flex shrink-0 flex-col gap-3 px-6 pt-6 pb-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={FolderLibraryIcon}
            size={20}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <h1 className="text-lg font-semibold text-foreground">Projects</h1>
          {projects.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">
              {visible.length === projects.length
                ? `${projects.length}`
                : `${visible.length} / ${projects.length}`}
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" className="h-8 gap-1.5" onClick={pickLocalFolder}>
              <HugeiconsIcon icon={FolderAddIcon} size={15} strokeWidth={1.75} />
              Add project
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => setRemoteOpen(true)}
            >
              <HugeiconsIcon
                icon={ServerStackIcon}
                size={15}
                strokeWidth={1.75}
              />
              Add remote
            </Button>
            <SortToggle value={sort} onChange={setSort} />
            <DensityToggle value={density} onChange={setDensity} />
          </div>
        </div>

        {projects.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                size={15}
                strokeWidth={1.75}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects by name, path or tag…"
                className="h-8 pl-8 text-[13px]"
              />
            </div>

            {allTags.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <TagChip
                  label="All"
                  active={activeTag === null}
                  onClick={() => setActiveTag(null)}
                />
                {allTags.map((tag) => (
                  <TagChip
                    key={tag}
                    label={tag}
                    active={activeTag === tag}
                    onClick={() =>
                      setActiveTag((curr) => (curr === tag ? null : tag))
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {!hydrated ? null : projects.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-[13px] leading-relaxed text-muted-foreground">
            No projects yet. Use{" "}
            <span className="font-medium text-foreground/80">Add project</span>{" "}
            above (or right-click a folder in the explorer).
          </div>
        ) : visible.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border border-border/60 bg-card/40 px-5 py-6 text-[13px] text-muted-foreground">
            No projects match your search.
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-6">
            {/* Recent — hidden while a search/tag filter is active, since the
                row deliberately ignores the filter and would feel inconsistent. */}
            {recent.length > 0 && !query.trim() && !activeTag ? (
              <section className="flex flex-col gap-2">
                <SectionHeader icon={ClockIcon} label="Recent" />
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {recent.map((p) => (
                    <ProjectCard
                      key={`recent-${p.id}`}
                      project={p}
                      density="grid"
                      onOpen={() => onOpenProject(p)}
                      onOpenDetail={() => onOpenDetail(p)}
                      onEdit={() => setEditing(p)}
                      onRemove={() => remove(p.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Server-grouped sections (flat list when only one server). */}
            {showGroups ? (
              groups.map((g) => (
                <section
                  key={serverGroupId(g.key)}
                  className="flex flex-col gap-2"
                >
                  <SectionHeader
                    icon={
                      g.key.kind === "ssh" ? ServerStackIcon : HardDriveIcon
                    }
                    label={serverLabel(g.key)}
                    count={g.items.length}
                  />
                  <ProjectGrid
                    items={g.items}
                    density={density}
                    onOpenProject={onOpenProject}
                    onOpenDetail={onOpenDetail}
                    onEdit={setEditing}
                    onRemove={remove}
                  />
                </section>
              ))
            ) : (
              <ProjectGrid
                items={visible}
                density={density}
                onOpenProject={onOpenProject}
                onOpenDetail={onOpenDetail}
                onEdit={setEditing}
                onRemove={remove}
              />
            )}
          </div>
        )}
      </div>

      <AddProjectDialog
        open={editing !== null || addPath !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setAddPath(null);
          }
        }}
        path={addPath}
        editing={editing}
        onSubmit={(project) => upsert(project)}
      />

      <AddRemoteProjectDialog
        open={remoteOpen}
        onOpenChange={setRemoteOpen}
        onSubmit={(project) => upsert(project)}
      />
    </div>
  );
}

/* ── Section header + grid ───────────────────────────────────────────── */

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: typeof ClockIcon;
  label: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <HugeiconsIcon
        icon={icon}
        size={14}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {count != null ? (
        <span className="text-[11px] text-muted-foreground/70">{count}</span>
      ) : null}
    </div>
  );
}

function ProjectGrid({
  items,
  density,
  onOpenProject,
  onOpenDetail,
  onEdit,
  onRemove,
}: {
  items: Project[];
  density: Density;
  onOpenProject: (p: Project) => void;
  onOpenDetail: (p: Project) => void;
  onEdit: (p: Project) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        density === "grid"
          ? "grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3"
          : "flex flex-col gap-1.5",
      )}
    >
      {items.map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          density={density}
          onOpen={() => onOpenProject(p)}
          onOpenDetail={() => onOpenDetail(p)}
          onEdit={() => onEdit(p)}
          onRemove={() => onRemove(p.id)}
        />
      ))}
    </div>
  );
}

/* ── Toolbar controls ────────────────────────────────────────────────── */

function SortToggle({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
}) {
  const labels: Record<SortKey, string> = {
    added: "Added",
    name: "Name",
    active: "Recent",
  };
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as SortKey)}
      variant="outline"
      size="sm"
      className="h-8"
    >
      {(Object.keys(labels) as SortKey[]).map((k) => (
        <ToggleGroupItem
          key={k}
          value={k}
          className="px-2.5 text-[12px]"
          title={`Sort by ${labels[k].toLowerCase()}`}
        >
          {labels[k]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function DensityToggle({
  value,
  onChange,
}: {
  value: Density;
  onChange: (v: Density) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as Density)}
      variant="outline"
      size="sm"
      className="h-8"
    >
      <ToggleGroupItem value="grid" title="Grid view" aria-label="Grid view">
        <HugeiconsIcon icon={GridIcon} size={15} strokeWidth={1.75} />
      </ToggleGroupItem>
      <ToggleGroupItem value="list" title="List view" aria-label="List view">
        <HugeiconsIcon icon={ListViewIcon} size={15} strokeWidth={1.75} />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/15 text-foreground"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/* ── Lazy in-view detection ──────────────────────────────────────────── */

/**
 * Returns a ref + a one-way `inView` flag that flips true the first time the
 * element intersects the viewport. One-way so a card never re-fetches when it
 * scrolls back out and in again.
 */
function useInViewOnce<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  return { ref, inView };
}

/* ── Card ────────────────────────────────────────────────────────────── */

function ProjectCard({
  project,
  density,
  onOpen,
  onOpenDetail,
  onEdit,
  onRemove,
}: {
  project: Project;
  density: Density;
  onOpen: () => void;
  onOpenDetail: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const { ref, inView } = useInViewOnce<HTMLDivElement>();
  const insights = useProjectCardInsights(project.path, inView);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          className={cn(
            "group relative flex flex-col gap-2 rounded-lg border border-border/60 bg-card/50 transition-colors",
            "hover:border-border hover:bg-foreground/[0.04]",
            density === "grid" ? "p-3.5" : "px-4 py-2.5",
          )}
        >
          {/* Title row */}
          <button
            type="button"
            onClick={onOpen}
            title={project.path}
            className="flex min-w-0 items-center gap-2.5 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <HugeiconsIcon
              icon={FolderLibraryIcon}
              size={density === "grid" ? 17 : 16}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground group-hover:text-foreground"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] font-medium text-foreground">
                {project.name}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {project.path}
              </span>
            </span>
          </button>

          {/* Live signals */}
          <SignalRow insights={insights} />

          {/* Tags */}
          {project.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {project.tags.slice(0, 4).map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="h-4 px-1.5 text-[9px] leading-none"
                >
                  {t}
                </Badge>
              ))}
              {project.tags.length > 4 ? (
                <span className="text-[9px] text-muted-foreground">
                  +{project.tags.length - 4}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Hover quick actions (top-right) */}
          <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <QuickAction
              icon={FolderOpenIcon}
              title="Open in new window"
              onClick={onOpen}
            />
            <QuickAction
              icon={Copy01Icon}
              title="Copy path"
              onClick={() => void copyToClipboard(project.path)}
            />
            <QuickAction
              icon={MoreVerticalIcon}
              title="Open project details"
              onClick={onOpenDetail}
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={onOpenDetail}>Open details</ContextMenuItem>
        <ContextMenuItem onSelect={onOpen}>Open in new window</ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyToClipboard(project.path)}>
          Copy path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void revealInFinder(project.path)}>
          Reveal in file manager
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onEdit}>Edit…</ContextMenuItem>
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
  );
}

function QuickAction({
  icon,
  title,
  onClick,
}: {
  icon: typeof FolderOpenIcon;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
        "bg-background/70 backdrop-blur hover:bg-foreground/[0.1] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
    </button>
  );
}

/**
 * The compact live-signal row under a card title. Shows nothing until the
 * card's git summary resolves, then renders branch + dirty/ahead/behind, GitHub
 * stars / open issues, and a "last active" relative time when available.
 */
function SignalRow({ insights }: { insights: ProjectCardInsights }) {
  const { summary, stars, openIssues, lastCommit } = insights;

  if (summary.kind === "loading") {
    return (
      <div className="h-3.5 w-24 animate-pulse rounded bg-foreground/[0.06]" />
    );
  }
  if (summary.kind === "unavailable") {
    return (
      <span className="text-[10.5px] text-muted-foreground/70">
        {summary.reason}
      </span>
    );
  }

  const s = summary.data;
  const dirty = s.changedCount > 0;
  // Working-tree breakdown — present on freshly-resolved summaries; older cache
  // entries lack the split and fall back to the flat "N changed" pill.
  const hasBreakdown =
    s.staged != null || s.unstaged != null || s.untracked != null;
  const staged = s.staged ?? 0;
  const unstaged = s.unstaged ?? 0;
  const untracked = s.untracked ?? 0;
  // Tooltip spells out each slot the compact pills abbreviate.
  const dirtyTitle = dirty
    ? [
        staged > 0 ? `${staged} staged` : null,
        unstaged > 0 ? `${unstaged} modified` : null,
        untracked > 0 ? `${untracked} untracked` : null,
      ]
        .filter(Boolean)
        .join(", ") || `${s.changedCount} changed`
    : "working tree clean";
  const churn =
    lastCommit && (lastCommit.insertions != null || lastCommit.deletions != null)
      ? { ins: lastCommit.insertions ?? 0, del: lastCommit.deletions ?? 0 }
      : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground">
      <span className="flex items-center gap-1 font-medium text-foreground/80">
        <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={1.75} />
        {s.branch}
      </span>
      {s.ahead > 0 ? (
        <span className="flex items-center gap-0.5" title={`${s.ahead} ahead`}>
          <HugeiconsIcon icon={ArrowUpRightIcon} size={11} strokeWidth={2} />
          {s.ahead}
        </span>
      ) : null}
      {s.behind > 0 ? (
        <span className="flex items-center gap-0.5" title={`${s.behind} behind`}>
          <HugeiconsIcon icon={ArrowDownRightIcon} size={11} strokeWidth={2} />
          {s.behind}
        </span>
      ) : null}
      {/* Dirty/clean indicator. When the per-slot breakdown is available we
          render staged / modified / untracked as separate colored pills; older
          cached summaries fall back to the flat "N changed" count. */}
      {!dirty ? (
        <span
          className="flex items-center gap-1 text-emerald-500/80"
          title={dirtyTitle}
        >
          <HugeiconsIcon icon={RecordIcon} size={9} strokeWidth={3} />
          clean
        </span>
      ) : hasBreakdown ? (
        <span className="flex items-center gap-1.5" title={dirtyTitle}>
          {staged > 0 ? (
            <span className="text-emerald-500">+{staged}</span>
          ) : null}
          {unstaged > 0 ? (
            <span className="text-amber-500">~{unstaged}</span>
          ) : null}
          {untracked > 0 ? (
            <span className="text-sky-500">?{untracked}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-amber-500" title={dirtyTitle}>
          <HugeiconsIcon icon={RecordIcon} size={9} strokeWidth={3} />
          {s.changedCount} changed
        </span>
      )}
      {stars != null && stars > 0 ? (
        <span className="flex items-center gap-1" title={`${stars} stars`}>
          <HugeiconsIcon icon={StarIcon} size={11} strokeWidth={1.75} />
          {stars}
        </span>
      ) : null}
      {openIssues != null && openIssues > 0 ? (
        <span>{openIssues} issues</span>
      ) : null}
      {lastCommit ? (
        <span className="flex items-center gap-1.5 truncate" title={lastCommit.subject}>
          <span>· {relativeTime(lastCommit.atMs)}</span>
          {churn && (churn.ins > 0 || churn.del > 0) ? (
            <span className="flex items-center gap-1">
              {churn.ins > 0 ? (
                <span className="text-emerald-500">+{churn.ins}</span>
              ) : null}
              {churn.del > 0 ? (
                <span className="text-rose-500">−{churn.del}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
