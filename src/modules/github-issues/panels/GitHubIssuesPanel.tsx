import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  Add01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  RecordIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import type { Issue, IssueFilter } from "../store/issuesStore";
import { useIssuesStore } from "../store/issuesStore";

const FILTERS: { id: IssueFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

export function GitHubIssuesPanel() {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const live = useChatStore((s) => s.live);
  const root = live.getWorkspaceRoot();

  const load = useIssuesStore((s) => s.load);
  const cache = useIssuesStore((s) => (root ? s.cache[root] : undefined));

  const [filter, setFilter] = useState<IssueFilter>("open");
  const [composing, setComposing] = useState(false);

  // SWR: on mount / root change / env change / filter change, ask the store to
  // ensure the cache is warm. The store no-ops when the cache is still fresh
  // for this filter, so rapid sidebar tab toggles do not spawn `gh`.
  useEffect(() => {
    if (!root) return;
    void load(root, filter);
  }, [root, workspaceEnv, filter, load]);

  const reload = useCallback(() => {
    if (!root) return;
    void load(root, filter, true);
  }, [root, filter, load]);

  // Derive the header/empty-state from the cache (default to loading).
  const status = !root ? "no-repo" : (cache?.status ?? "loading");
  const refreshing = Boolean(cache?.loading);
  // Only trust the cached list when it was fetched under the active filter;
  // otherwise we are mid-switch and should fall back to loading.
  const issues =
    cache && cache.filter === filter ? cache.issues : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1 truncate">
          {cache?.repo?.nameWithOwner ?? "GitHub Issues"}
        </span>
        <button
          type="button"
          onClick={() => setComposing((v) => !v)}
          aria-label="New issue"
          title="New issue"
          disabled={status === "no-repo"}
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={reload}
          aria-label="Reload issues"
          title="Reload issues"
          className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={13}
            strokeWidth={1.75}
            className={cn(refreshing && "animate-spin")}
          />
        </button>
      </div>

      {composing && root ? (
        <CreateIssueForm
          cwd={root}
          filter={filter}
          onClose={() => setComposing(false)}
        />
      ) : null}

      {status !== "no-repo" ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                f.id === filter
                  ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                  : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" ? (
          <div className="px-3 py-5 text-center text-xs text-muted-foreground">
            Loading issues…
          </div>
        ) : status === "no-repo" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No GitHub repository here.
            <br />
            Open a folder whose <code>gh</code> context is a GitHub repo.
          </div>
        ) : status === "error" ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-destructive">
            Could not load issues.
            <br />
            <span className="text-muted-foreground">{cache?.error}</span>
          </div>
        ) : issues.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No {filter === "all" ? "" : filter} issues.
          </div>
        ) : (
          <div className="p-1">
            {issues.map((issue) => (
              <IssueRow key={issue.number} issue={issue} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline new-issue composer. Submits through the store's `createIssue`, which
 * shells out to `gh issue create` and force-refreshes the list on success.
 * Errors are surfaced inline rather than thrown away.
 */
function CreateIssueForm({
  cwd,
  filter,
  onClose,
}: {
  cwd: string;
  filter: IssueFilter;
  onClose: () => void;
}) {
  const createIssue = useIssuesStore((s) => s.createIssue);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createIssue(cwd, title.trim(), body.trim(), filter);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, createIssue, cwd, title, body, filter, onClose]);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 bg-card/60 p-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        // Cmd/Ctrl+Enter submits from the title field too, for keyboard flow.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="Issue title"
        autoFocus
        className="w-full rounded border border-border/60 bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="Description (optional) — ⌘/Ctrl+Enter to submit"
        rows={3}
        className="w-full resize-none rounded border border-border/60 bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
      />
      {error ? (
        <span className="text-[10px] leading-snug text-destructive">{error}</span>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          {submitting ? (
            <HugeiconsIcon icon={Loading03Icon} size={12} className="animate-spin" />
          ) : (
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          )}
          Create
        </button>
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const open = issue.state === "OPEN";
  return (
    <button
      type="button"
      onClick={() => void openUrl(issue.url).catch(() => {})}
      title={`#${issue.number} ${issue.title} — open on GitHub`}
      className="group flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/40"
    >
      <HugeiconsIcon
        icon={open ? RecordIcon : CheckmarkCircle02Icon}
        size={13}
        className={cn(
          "mt-0.5 shrink-0",
          open ? "text-emerald-500" : "text-purple-400",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs text-foreground/90">
          {issue.title}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="tabular-nums">#{issue.number}</span>
          {issue.author ? <span className="truncate">· {issue.author}</span> : null}
        </span>
        {issue.labels.length > 0 ? (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {issue.labels.map((l) => (
              <span
                key={l.name}
                className="rounded-full border px-1.5 text-[9px] leading-[1.4] text-foreground/80"
                style={{
                  borderColor: `#${l.color}80`,
                  backgroundColor: `#${l.color}1a`,
                }}
              >
                {l.name}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </button>
  );
}
