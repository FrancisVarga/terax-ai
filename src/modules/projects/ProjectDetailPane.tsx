import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GitLogEntry } from "@/modules/ai/lib/native";
import {
  ArrowRight01Icon,
  Calendar03Icon,
  CircleIcon,
  Delete02Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  GitCommitIcon,
  PencilEdit02Icon,
  RefreshIcon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { AddProjectDialog } from "./AddProjectDialog";
import { type Project } from "./lib/projects";
import type {
  GitHubIssue,
  GitHubRepo,
  GitHubRun,
  Loadable,
  RepoSummary,
} from "./lib/projectInsights";
import { useProjectInsights } from "./lib/useProjectInsights";
import { useProjectsStore } from "./store/projectsStore";

type Props = {
  projectId: string;
  /** Open the project (spawns a window rooted at the project folder). */
  onOpenProject: (project: Project) => void;
};

const markdownComponents = { code: MarkdownCode };

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
 * Main-area detail page for a single project. Subscribes to the projects store
 * by id (so renames / edits reflect live) and loads rich git + GitHub insights
 * via {@link useProjectInsights}. Each insight panel renders its own loading /
 * empty / unavailable state so a single failure never blanks the page.
 */
export function ProjectDetailPane({ projectId, onOpenProject }: Props) {
  const project = useProjectsStore((s) =>
    s.projects.find((p) => p.id === projectId),
  );
  const upsert = useProjectsStore((s) => s.upsert);
  const remove = useProjectsStore((s) => s.remove);
  const [editing, setEditing] = useState(false);

  const { insights, reload } = useProjectInsights(project?.path ?? "");

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-[13px] text-muted-foreground">
        This project no longer exists.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
          {/* Header */}
          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <HugeiconsIcon
                icon={FolderLibraryIcon}
                size={28}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="truncate text-xl font-semibold text-foreground">
                  {project.name}
                </h1>
                <span
                  className="truncate text-[12px] text-muted-foreground"
                  title={project.path}
                >
                  {project.path}
                </span>
                <RepoChips summary={insights.summary} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={reload}
                title="Refresh insights"
              >
                <HugeiconsIcon icon={RefreshIcon} size={15} strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                title="Edit project"
              >
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  size={15}
                  strokeWidth={1.75}
                />
                Edit
              </Button>
              <Button size="sm" onClick={() => onOpenProject(project)}>
                Open
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={15}
                  strokeWidth={1.75}
                />
              </Button>
            </div>
          </header>

          {project.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {project.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[11px]">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}

          {/* Repo details (GitHub) */}
          <RepoDetailsSection repo={insights.repo} />

          {/* Two-column: commits + (issues, runs) */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CommitsSection commits={insights.commits} />
            <div className="flex flex-col gap-4">
              <IssuesSection issues={insights.issues} />
              <RunsSection runs={insights.runs} />
            </div>
          </div>

          {/* README preview */}
          <ReadmeSection readme={insights.readme} />

          {/* Notes + danger zone */}
          {project.notes.trim() ? (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                {project.notes}
              </p>
            </Section>
          ) : null}

          <div className="border-t border-border/60 pt-4">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => remove(project.id)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.75} />
              Remove from Projects
            </Button>
          </div>
        </div>
      </div>

      <AddProjectDialog
        open={editing}
        onOpenChange={setEditing}
        path={null}
        editing={project}
        onSubmit={(p) => upsert(p)}
      />
    </div>
  );
}

/* ── Building blocks ─────────────────────────────────────────────────── */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Hint({ text }: { text: string }) {
  return <p className="text-[12px] text-muted-foreground">{text}</p>;
}

/** Render a Loadable into loading / unavailable hints or the ready content. */
function withLoadable<T>(
  state: Loadable<T>,
  render: (data: T) => React.ReactNode,
  loadingText = "Loading…",
): React.ReactNode {
  if (state.kind === "loading") return <Hint text={loadingText} />;
  if (state.kind === "unavailable") return <Hint text={state.reason} />;
  return render(state.data);
}

function RepoChips({ summary }: { summary: Loadable<RepoSummary> }) {
  if (summary.kind !== "ready") return null;
  const s = summary.data;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.75} />
        {s.branch}
      </span>
      {s.ahead > 0 ? <span>↑{s.ahead}</span> : null}
      {s.behind > 0 ? <span>↓{s.behind}</span> : null}
      {s.changedCount > 0 ? (
        <span>{s.changedCount} uncommitted</span>
      ) : (
        <span>clean</span>
      )}
    </div>
  );
}

function RepoDetailsSection({ repo }: { repo: Loadable<GitHubRepo> }) {
  return (
    <Section title="Repository">
      {withLoadable(repo, (r) => (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <button
                type="button"
                onClick={() => r.url && void openUrl(r.url)}
                className="truncate text-left text-[14px] font-medium text-foreground hover:underline"
              >
                {r.nameWithOwner ?? "—"}
              </button>
              {r.description ? (
                <p className="text-[12.5px] text-muted-foreground">
                  {r.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1.5">
              {r.isPrivate ? (
                <Badge variant="outline" className="text-[10px]">
                  Private
                </Badge>
              ) : null}
              {r.isArchived ? (
                <Badge variant="outline" className="text-[10px]">
                  Archived
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-muted-foreground">
            {r.primaryLanguage?.name ? (
              <span className="flex items-center gap-1">
                <HugeiconsIcon icon={CircleIcon} size={10} strokeWidth={3} />
                {r.primaryLanguage.name}
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <HugeiconsIcon icon={StarIcon} size={12} strokeWidth={1.75} />
              {r.stargazerCount ?? 0}
            </span>
            <span>{r.forkCount ?? 0} forks</span>
            {r.issues?.totalCount != null ? (
              <span>{r.issues.totalCount} open issues</span>
            ) : null}
            {r.pullRequests?.totalCount != null ? (
              <span>{r.pullRequests.totalCount} open PRs</span>
            ) : null}
            {r.licenseInfo?.name ? <span>{r.licenseInfo.name}</span> : null}
            {r.pushedAt ? (
              <span className="flex items-center gap-1">
                <HugeiconsIcon
                  icon={Calendar03Icon}
                  size={12}
                  strokeWidth={1.75}
                />
                pushed {relativeTime(Date.parse(r.pushedAt))}
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </Section>
  );
}

function CommitsSection({ commits }: { commits: Loadable<GitLogEntry[]> }) {
  return (
    <Section title="Latest commits">
      {withLoadable(commits, (list) =>
        list.length === 0 ? (
          <Hint text="No commits yet." />
        ) : (
          <ul className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/50 p-1.5">
            {list.map((c) => (
              <li
                key={c.sha}
                className="flex items-start gap-2.5 rounded-md px-2 py-1.5"
              >
                <HugeiconsIcon
                  icon={GitCommitIcon}
                  size={14}
                  strokeWidth={1.75}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] text-foreground">
                    {c.subject}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    <span className="font-mono">{c.shortSha}</span> · {c.author}{" "}
                    · {relativeTime(c.timestampSecs * 1000)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ),
      )}
    </Section>
  );
}

function issueStateColor(state: string): string {
  return state.toLowerCase() === "open"
    ? "text-emerald-500"
    : "text-purple-500";
}

function IssuesSection({ issues }: { issues: Loadable<GitHubIssue[]> }) {
  return (
    <Section title="Open issues">
      {withLoadable(issues, (list) =>
        list.length === 0 ? (
          <Hint text="No open issues." />
        ) : (
          <ul className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/50 p-1.5">
            {list.map((i) => (
              <li key={i.number}>
                <button
                  type="button"
                  onClick={() => void openUrl(i.url)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/[0.04]"
                >
                  <HugeiconsIcon
                    icon={CircleIcon}
                    size={11}
                    strokeWidth={2.5}
                    className={cn("mt-1 shrink-0", issueStateColor(i.state))}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] text-foreground">
                      {i.title}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      #{i.number} · {i.author?.login ?? "unknown"} ·{" "}
                      {relativeTime(Date.parse(i.createdAt))}
                    </span>
                  </div>
                  {i.comments ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {i.comments}💬
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ),
      )}
    </Section>
  );
}

function runStatusColor(run: GitHubRun): string {
  if (run.status && run.status !== "completed") return "text-amber-500";
  switch (run.conclusion) {
    case "success":
      return "text-emerald-500";
    case "failure":
    case "timed_out":
      return "text-destructive";
    case "cancelled":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function RunsSection({ runs }: { runs: Loadable<GitHubRun[]> }) {
  return (
    <Section title="Workflow runs">
      {withLoadable(runs, (list) =>
        list.length === 0 ? (
          <Hint text="No workflow runs." />
        ) : (
          <ul className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/50 p-1.5">
            {list.map((run) => (
              <li key={run.databaseId ?? run.url}>
                <button
                  type="button"
                  onClick={() => run.url && void openUrl(run.url)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/[0.04]"
                >
                  <HugeiconsIcon
                    icon={CircleIcon}
                    size={11}
                    strokeWidth={2.5}
                    className={cn("mt-1 shrink-0", runStatusColor(run))}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] text-foreground">
                      {run.displayTitle ?? run.name ?? "run"}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {run.workflowName ?? "—"} · {run.headBranch ?? "?"} ·{" "}
                      {run.status === "completed"
                        ? (run.conclusion ?? "done")
                        : (run.status ?? "?")}
                      {run.createdAt
                        ? ` · ${relativeTime(Date.parse(run.createdAt))}`
                        : ""}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ),
      )}
    </Section>
  );
}

function ReadmeSection({
  readme,
}: {
  readme: Loadable<{ content: string }>;
}) {
  return (
    <Section title="README">
      {withLoadable(readme, (r) => (
        <div className="max-h-[480px] overflow-auto rounded-lg border border-border/60 bg-background px-5 py-4">
          <Streamdown
            className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={markdownComponents}
          >
            {r.content}
          </Streamdown>
        </div>
      ))}
    </Section>
  );
}
