import { isRemote } from "@/modules/explorer/lib/remote";
import { create } from "zustand";
import {
  GhError,
  createIssue,
  listIssues,
  resolveRepo,
  type Issue,
  type IssueState,
  type RepoInfo,
} from "../lib/gh";

/**
 * Stale-while-revalidate window for cached repo + issue lists. Within this
 * window a read serves the cache without spawning `gh`; past it the cache is
 * still served immediately but a background refresh is kicked off. Matches the
 * actions module so the two GitHub panels behave identically.
 */
const ISSUES_TTL_MS = 30_000;
/** Issues to fetch per state filter. */
const ISSUES_LIMIT = 50;

/** Which issue states the panel can show; the cache is keyed on this too. */
export type IssueFilter = "open" | "closed" | "all";

/** Default cache entry used before the first fetch resolves. */
const EMPTY: IssuesCache = {
  status: "loading",
  repo: null,
  issues: [],
  filter: "open",
  fetchedAt: 0,
  loading: false,
};

/**
 * Whether two issue lists are identical (same number/state/title/labels in
 * order). Used to suppress a no-op cache write on revalidation, so a refetch
 * that returns the same data keeps the existing array reference and React skips
 * the re-render — "revalidate only when there is new data".
 */
function issuesEqual(a: Issue[], b: Issue[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const o = b[i];
    return (
      x.number === o.number &&
      x.state === o.state &&
      x.title === o.title &&
      x.updatedAt === o.updatedAt &&
      x.labels.length === o.labels.length &&
      x.labels.every((l, j) => l.name === o.labels[j]?.name)
    );
  });
}

/**
 * Cached repo identity + issue list for one working dir. The panel reads this
 * synchronously so re-opening the sidebar tab is instant; it is revalidated in
 * the background once older than {@link ISSUES_TTL_MS}.
 */
export type IssuesCache = {
  status: "loading" | "ready" | "empty" | "no-repo" | "error";
  repo: RepoInfo | null;
  issues: Issue[];
  /** State filter the cached list was fetched under. */
  filter: IssueFilter;
  error?: string;
  /** Epoch ms of the last successful (or terminal) fetch; 0 while first loading. */
  fetchedAt: number;
  /** True while a fetch is in flight, to coalesce concurrent revalidations. */
  loading: boolean;
};

type IssuesState = {
  /** Issue cache, keyed by working dir. */
  cache: Record<string, IssuesCache>;
  /**
   * Ensure repo + issues for `cwd` are loaded. Serves cache when fresh,
   * revalidates in the background when stale. A changed `filter` always forces
   * a fetch. `force` bypasses the TTL (used by the manual reload button).
   * Remote roots resolve to a `no-repo` cache entry.
   */
  load: (cwd: string, filter: IssueFilter, force?: boolean) => Promise<void>;
  /**
   * Create an issue in `cwd`, then refresh the list so the new issue shows up
   * without waiting for the next TTL window. Returns the new issue's url, or
   * throws so the form can surface the error inline.
   */
  createIssue: (
    cwd: string,
    title: string,
    body: string,
    filter: IssueFilter,
  ) => Promise<{ number: number; url: string }>;
};

export const useIssuesStore = create<IssuesState>((set, get) => {
  const patch = (cwd: string, p: Partial<IssuesCache>) =>
    set((s) => {
      const cur = s.cache[cwd] ?? EMPTY;
      return { cache: { ...s.cache, [cwd]: { ...cur, ...p } } };
    });

  return {
    cache: {},

    load: async (cwd, filter, force = false) => {
      if (!cwd) return;
      const cached = get().cache[cwd];
      // Coalesce concurrent loads, and serve fresh cache (same filter) without
      // touching gh. A filter change always falls through to a fetch.
      if (cached?.loading) return;
      if (
        !force &&
        cached &&
        cached.status !== "loading" &&
        cached.filter === filter &&
        Date.now() - cached.fetchedAt < ISSUES_TTL_MS
      ) {
        return;
      }

      // Remote roots have no local gh context — record that terminally.
      if (isRemote(cwd)) {
        patch(cwd, {
          status: "no-repo",
          repo: null,
          issues: [],
          filter,
          error: undefined,
          fetchedAt: Date.now(),
          loading: false,
        });
        return;
      }

      // First-ever load shows a spinner; revalidations keep the stale view.
      patch(cwd, cached ? { loading: true } : { ...EMPTY, filter, loading: true });
      try {
        const repo = await resolveRepo(cwd);
        const issues = await listIssues(cwd, filter, ISSUES_LIMIT);
        const status = issues.length > 0 ? "ready" : "empty";
        // Revalidate only when there is new data: if the fetch matches the
        // cached repo + issue list (and filter), keep the existing `issues`
        // reference so subscribers don't re-render; just reset TTL + spinner.
        const prev = get().cache[cwd];
        const unchanged =
          prev?.status === status &&
          prev.filter === filter &&
          prev.repo?.nameWithOwner === repo.nameWithOwner &&
          prev.error === undefined &&
          issuesEqual(prev.issues, issues);
        patch(
          cwd,
          unchanged
            ? { fetchedAt: Date.now(), loading: false }
            : {
                status,
                repo,
                issues,
                filter,
                error: undefined,
                fetchedAt: Date.now(),
                loading: false,
              },
        );
      } catch (e) {
        const noRepo =
          e instanceof GhError && /not a (git|github) repo/i.test(e.message);
        patch(cwd, {
          status: noRepo ? "no-repo" : "error",
          filter,
          error: noRepo
            ? undefined
            : String(e instanceof Error ? e.message : e),
          fetchedAt: Date.now(),
          loading: false,
        });
      }
    },

    createIssue: async (cwd, title, body, filter) => {
      const result = await createIssue(cwd, title, body);
      // Force a refresh so the freshly created issue appears immediately.
      await get().load(cwd, filter, true);
      return result;
    },
  };
});

export type { Issue, IssueState };
