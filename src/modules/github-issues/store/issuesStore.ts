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
/**
 * Background poll cadence while the issues tab is mounted. The panel drives a
 * `setInterval` at this rate; each tick calls `load`, which respects the TTL,
 * so a fresh cache no-ops and only stale entries actually re-query `gh`.
 * Mirrors the github-feed module's `POLL_INTERVAL_MS`.
 */
export const POLL_INTERVAL_MS = 60_000;

/** localStorage key the issue cache is persisted under. */
const STORAGE_KEY = "terax:github-issues-cache";
/**
 * Max repos kept in the persisted cache. The in-memory cache is keyed by `cwd`
 * (one entry per repo ever visited); persisting all of them would grow
 * localStorage without bound, so we keep only the most-recently-fetched roots.
 */
const MAX_PERSISTED_ROOTS = 12;

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

/**
 * Restore the persisted issue cache from localStorage. Every restored entry is
 * marked stale (`fetchedAt: 0`, `loading: false`) so it paints instantly on
 * launch but the panel's first `load` bypasses the TTL and re-polls `gh` for
 * fresh data — same "serve cache, then revalidate" contract, just across a
 * restart. A `loading` status is downgraded to `empty` since no fetch is in
 * flight after a cold start. Malformed blobs are dropped silently.
 */
function loadPersisted(): Record<string, IssuesCache> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, IssuesCache> = {};
    for (const [cwd, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<IssuesCache>;
      if (!e || !Array.isArray(e.issues)) continue;
      out[cwd] = {
        status: e.status === "loading" ? "empty" : (e.status ?? "empty"),
        repo: e.repo ?? null,
        issues: e.issues as Issue[],
        filter: e.filter ?? "open",
        error: undefined,
        // Force stale so the next load() ignores the TTL and revalidates.
        fetchedAt: 0,
        loading: false,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist the issue cache to localStorage, keeping only the
 * {@link MAX_PERSISTED_ROOTS} most-recently-fetched roots so the blob stays
 * bounded. `loading`/`error` transient fields are written as-is but reset on
 * restore. Best-effort: quota or serialization failures are swallowed.
 */
function persistCache(cache: Record<string, IssuesCache>): void {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(cache)
      // Don't persist no-repo placeholders or never-fetched stubs.
      .filter(([, c]) => c.status !== "no-repo" && c.issues.length > 0)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, MAX_PERSISTED_ROOTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore quota / serialization failures
  }
}

type IssuesState = {
  /** Issue cache, keyed by working dir. */
  cache: Record<string, IssuesCache>;
  /**
   * Ensure repo + issues for `cwd` are loaded. Serves cache when fresh,
   * revalidates in the background when stale. A changed `filter` always forces
   * a fetch. `force` bypasses the TTL (used by the manual reload button).
   * Remote roots resolve to a `no-repo` cache entry. `nowMs` is the caller's
   * clock, injected so the store has no hidden dependency on a restricted
   * clock — matches the github-feed store's `loadFeed(nowMs, …)` convention.
   */
  load: (
    cwd: string,
    filter: IssueFilter,
    nowMs: number,
    force?: boolean,
  ) => Promise<void>;
  /**
   * Create an issue in `cwd`, then refresh the list so the new issue shows up
   * without waiting for the next TTL window. Returns the new issue's url, or
   * throws so the form can surface the error inline. `nowMs` threads through to
   * the forced refresh.
   */
  createIssue: (
    cwd: string,
    title: string,
    body: string,
    filter: IssueFilter,
    nowMs: number,
  ) => Promise<{ number: number; url: string }>;
};

export const useIssuesStore = create<IssuesState>((set, get) => {
  const patch = (cwd: string, p: Partial<IssuesCache>) =>
    set((s) => {
      const cur = s.cache[cwd] ?? EMPTY;
      const cache = { ...s.cache, [cwd]: { ...cur, ...p } };
      // Persist on every cache mutation so issues survive an app restart. This
      // is the single write path for the cache, so one call here covers loads,
      // revalidations, and issue creation.
      persistCache(cache);
      return { cache };
    });

  return {
    // Seed from localStorage: re-opening the app paints the last-known issues
    // immediately, then the panel's first load() revalidates (entries restore
    // stale, so the TTL is bypassed).
    cache: loadPersisted(),

    load: async (cwd, filter, nowMs, force = false) => {
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
        nowMs - cached.fetchedAt < ISSUES_TTL_MS
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
          fetchedAt: nowMs,
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
            ? { fetchedAt: nowMs, loading: false }
            : {
                status,
                repo,
                issues,
                filter,
                error: undefined,
                fetchedAt: nowMs,
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
          fetchedAt: nowMs,
          loading: false,
        });
      }
    },

    createIssue: async (cwd, title, body, filter, nowMs) => {
      const result = await createIssue(cwd, title, body);
      // Force a refresh so the freshly created issue appears immediately.
      await get().load(cwd, filter, nowMs, true);
      return result;
    },
  };
});

export type { Issue, IssueState };
