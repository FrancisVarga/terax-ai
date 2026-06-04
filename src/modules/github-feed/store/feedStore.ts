import { readCache, writeCache } from "@/lib/localCache";
import { create } from "zustand";
import {
  GhError,
  aggregateTopics,
  enrichPullRequests,
  fetchStarred,
  listFeed,
  listTrending,
  resolveViewer,
  searchHistory,
  setStarred,
  type FeedCategory,
  type FeedEvent,
  type TrendingRange,
  type TrendingRepo,
  type TrendingTopic,
  type Viewer,
} from "../lib/gh";

/**
 * Stale-while-revalidate window. Within it a load serves cache without spawning
 * `gh`; past it the stale view is still shown immediately while a background
 * refresh runs. The panel also drives a longer background poll (see
 * POLL_INTERVAL_MS) so the feed stays live while the tab is open.
 */
const FEED_TTL_MS = 60_000;
const TRENDING_TTL_MS = 5 * 60_000;
/** Background poll cadence while the feed tab is mounted. */
export const POLL_INTERVAL_MS = 120_000;

const FEED_LIMIT = 50;
const TRENDING_LIMIT = 30;
/** How far back history (Search) mode reaches once the firehose is exhausted. */
const HISTORY_DAYS = 28;
/** Search scope for history mode — broadest personal involvement. */
const HISTORY_QUALIFIER = "involves:@me";

/**
 * localStorage cache so the feed survives an app reboot: on launch we hydrate
 * the last-seen feed/trending instantly (offline-friendly first paint), then
 * SWR-revalidate via `loadFeed`/`loadTrending`. The version is bumped whenever
 * the persisted shape changes so stale payloads are silently discarded.
 */
const CACHE_KEY = "github-feed";
const CACHE_VERSION = 1;

/** The slice we persist — only the expensive `gh` results, no transient flags. */
type PersistedFeed = {
  viewer: Viewer | null;
  feed: FeedEvent[];
  trending: TrendingRepo[];
  topics: TrendingTopic[];
  trendingRange: TrendingRange;
  trendingLanguage: string | null;
  /** Epoch ms of the last successful feed fetch (for the SWR TTL on boot). */
  feedFetchedAt: number;
  trendingFetchedAt: number;
};

function loadPersisted(): PersistedFeed | null {
  return readCache<PersistedFeed>(CACHE_KEY, CACHE_VERSION)?.value ?? null;
}

/** Snapshot the persistable slice of the current state and write it to cache. */
function persist(s: {
  viewer: Viewer | null;
  feed: FeedEvent[];
  trending: TrendingRepo[];
  topics: TrendingTopic[];
  trendingRange: TrendingRange;
  trendingLanguage: string | null;
  feedFetchedAt: number;
  trendingFetchedAt: number;
}): void {
  writeCache<PersistedFeed>(
    CACHE_KEY,
    CACHE_VERSION,
    {
      viewer: s.viewer,
      feed: s.feed,
      trending: s.trending,
      topics: s.topics,
      trendingRange: s.trendingRange,
      trendingLanguage: s.trendingLanguage,
      feedFetchedAt: s.feedFetchedAt,
      trendingFetchedAt: s.trendingFetchedAt,
    },
    Date.now(),
  );
}

export type LoadStatus = "loading" | "ready" | "empty" | "error";

/** Days back per trending range — used to compute the `created:>=` qualifier. */
const RANGE_DAYS: Record<TrendingRange, number> = {
  day: 1,
  week: 7,
  month: 30,
};

/**
 * ISO date (YYYY-MM-DD) `days` before `now`. `now` is injected so the store has
 * no hidden dependency on a restricted clock; callers pass `Date.now()`.
 */
function isoDaysAgo(nowMs: number, days: number): string {
  const d = new Date(nowMs - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function eventsEqual(a: FeedEvent[], b: FeedEvent[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i]?.id);
}

type FeedState = {
  viewer: Viewer | null;

  // --- Activity feed ---
  feed: FeedEvent[];
  feedStatus: LoadStatus;
  feedError?: string;
  feedFetchedAt: number;
  feedLoading: boolean;
  /** Highest events-firehose page fetched (1-based). Reset to 1 on fresh load. */
  feedPage: number;
  /** Whether more items may exist (firehose page or history page). */
  feedHasMore: boolean;
  /** True while a "load next page" fetch is in flight (infinite scroll). */
  feedLoadingMore: boolean;
  /**
   * Which source the next "load more" pulls from. We start on the events
   * firehose, then switch to date-bounded Search history once the firehose's
   * ~300-event ceiling is hit — so the user can keep scrolling back ~4 weeks.
   */
  feedMode: "events" | "history";
  /** Highest Search-history page fetched (1-based) once in history mode. */
  historyPage: number;

  // --- Trending ---
  trending: TrendingRepo[];
  topics: TrendingTopic[];
  trendingStatus: LoadStatus;
  trendingError?: string;
  trendingFetchedAt: number;
  trendingLoading: boolean;
  /** The (range, language) the cached trending list was fetched under. */
  trendingRange: TrendingRange;
  trendingLanguage: string | null;

  /** Ensure the feed is loaded; serve fresh cache, else revalidate. `nowMs`
   * is the caller's clock; `force` bypasses the TTL. */
  loadFeed: (nowMs: number, force?: boolean) => Promise<void>;
  /** Fetch the next page of feed events and append them (infinite scroll). */
  loadMoreFeed: () => Promise<void>;
  /** Ensure trending for (range, language) is loaded. A changed range/language
   * always refetches. */
  loadTrending: (
    nowMs: number,
    range: TrendingRange,
    language: string | null,
    force?: boolean,
  ) => Promise<void>;
  /** Toggle the star on a trending repo (optimistic, reverts on error). */
  toggleStar: (fullName: string) => Promise<void>;
};

export const useFeedStore = create<FeedState>((set, get) => {
  // Hydrate from the last persisted snapshot so a reboot shows the previous
  // feed instantly; a status of "ready" (not "loading") means the first paint
  // renders cached cards rather than a spinner, and `loadFeed` revalidates.
  const cached = loadPersisted();

  return {
  viewer: cached?.viewer ?? null,

  feed: cached?.feed ?? [],
  feedStatus: cached && cached.feed.length > 0 ? "ready" : "loading",
  feedFetchedAt: cached?.feedFetchedAt ?? 0,
  feedLoading: false,
  feedPage: 1,
  feedHasMore: true,
  feedLoadingMore: false,
  feedMode: "events",
  historyPage: 0,

  trending: cached?.trending ?? [],
  topics: cached?.topics ?? [],
  trendingStatus: cached && cached.trending.length > 0 ? "ready" : "loading",
  trendingFetchedAt: cached?.trendingFetchedAt ?? 0,
  trendingLoading: false,
  trendingRange: cached?.trendingRange ?? "week",
  trendingLanguage: cached?.trendingLanguage ?? null,

  loadFeed: async (nowMs, force = false) => {
    const s = get();
    if (s.feedLoading) return;
    if (
      !force &&
      s.feedStatus !== "loading" &&
      nowMs - s.feedFetchedAt < FEED_TTL_MS
    ) {
      return;
    }
    set({ feedLoading: true });
    try {
      const viewer = s.viewer ?? (await resolveViewer());
      const feed = await listFeed(viewer.login, FEED_LIMIT);
      const status: LoadStatus = feed.length > 0 ? "ready" : "empty";
      // Keep the existing array reference when nothing changed so subscribers
      // skip the re-render (revalidate only when there's new data).
      const prev = get();
      const unchanged =
        prev.feedStatus === status &&
        prev.feedError === undefined &&
        eventsEqual(prev.feed, feed);
      set({
        viewer,
        feedLoading: false,
        feedFetchedAt: nowMs,
        feedError: undefined,
        // A fresh load resets pagination + source back to the events firehose.
        // There is always "more" because history (Search) takes over once the
        // firehose is exhausted, so infinite scroll never dead-ends early.
        feedPage: 1,
        feedMode: "events",
        historyPage: 0,
        feedHasMore: true,
        ...(unchanged ? {} : { feed, feedStatus: status }),
      });
      // Persist the fresh feed so the next app launch hydrates from it.
      persist(get());
      // Progressive enhancement: the events API trims PR titles, so backfill
      // them in the background and patch the feed once they arrive. Only runs
      // when the base feed actually changed (skips redundant lookups on poll).
      if (!unchanged) {
        void enrichPullRequests(feed)
          .then((enriched) => {
            // Bail if a newer load replaced the feed meanwhile.
            if (!eventsEqual(get().feed, feed)) return;
            if (enriched !== feed) {
              set({ feed: enriched });
              persist(get());
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      set({
        feedLoading: false,
        feedFetchedAt: nowMs,
        feedStatus: "error",
        feedError: String(e instanceof Error ? e.message : e),
      });
    }
  },

  loadMoreFeed: async () => {
    const s = get();
    if (s.feedLoadingMore || s.feedLoading || !s.feedHasMore || !s.viewer) {
      return;
    }
    set({ feedLoadingMore: true });

    // Shared: append a batch (deduped by id), persist, and backfill PR titles.
    const appendBatch = (batch: FeedEvent[]) => {
      const seen = new Set(get().feed.map((e) => e.id));
      const fresh = batch.filter((e) => !seen.has(e.id));
      if (fresh.length > 0) {
        set((st) => ({ feed: [...st.feed, ...fresh] }));
        persist(get());
        void enrichPullRequests(fresh)
          .then((enriched) => {
            if (enriched === fresh) return;
            const byId = new Map(enriched.map((e) => [e.id, e]));
            set((st) => ({ feed: st.feed.map((e) => byId.get(e.id) ?? e) }));
            persist(get());
          })
          .catch(() => {});
      }
      return fresh.length;
    };

    try {
      if (s.feedMode === "events") {
        const nextPage = s.feedPage + 1;
        // received_events hard-caps at 300 (3 pages of 100). Past that the API
        // returns HTTP 422; we pre-empt by switching to history at page 3.
        if (nextPage > 3) {
          set({ feedMode: "history", feedLoadingMore: false });
          // Immediately pull the first history page on the same scroll.
          await get().loadMoreFeed();
          return;
        }
        try {
          const more = await listFeed(s.viewer.login, FEED_LIMIT, nextPage);
          appendBatch(more);
          // A short firehose page means it's exhausted → hand off to history.
          const exhausted = more.length < FEED_LIMIT;
          set({
            feedPage: nextPage,
            feedMode: exhausted ? "history" : "events",
            feedLoadingMore: false,
            feedHasMore: true,
          });
        } catch {
          // 422 (pagination limit) or transient error → switch to history.
          set({ feedMode: "history", feedLoadingMore: false });
          await get().loadMoreFeed();
        }
      } else {
        // History mode: date-bounded Search, paginated back ~4 weeks.
        const nextPage = s.historyPage + 1;
        const since = isoDaysAgo(Date.now(), HISTORY_DAYS);
        const { events, hasMore } = await searchHistory(
          HISTORY_QUALIFIER,
          since,
          nextPage,
        );
        appendBatch(events);
        set({
          historyPage: nextPage,
          feedHasMore: hasMore,
          feedLoadingMore: false,
        });
      }
    } catch {
      // Soft-fail: keep what we have, allow a retry on the next scroll.
      set({ feedLoadingMore: false });
    }
  },

  loadTrending: async (nowMs, range, language, force = false) => {
    const s = get();
    if (s.trendingLoading) return;
    const sameQuery =
      s.trendingRange === range && s.trendingLanguage === language;
    if (
      !force &&
      sameQuery &&
      s.trendingStatus !== "loading" &&
      nowMs - s.trendingFetchedAt < TRENDING_TTL_MS
    ) {
      return;
    }
    set({
      trendingLoading: true,
      trendingRange: range,
      trendingLanguage: language,
      // A query change shows the spinner rather than stale results for the
      // wrong filter.
      ...(sameQuery ? {} : { trendingStatus: "loading" }),
    });
    try {
      const since = isoDaysAgo(nowMs, RANGE_DAYS[range]);
      const repos = await listTrending(since, language, TRENDING_LIMIT);
      // Annotate each repo with the viewer's star state (best-effort, parallel).
      const starred = await fetchStarred(repos.map((r) => r.fullName));
      const withStars = repos.map((r) => ({
        ...r,
        starred: starred[r.fullName] ?? false,
      }));
      set({
        trending: withStars,
        topics: aggregateTopics(withStars),
        trendingStatus: withStars.length > 0 ? "ready" : "empty",
        trendingError: undefined,
        trendingFetchedAt: nowMs,
        trendingLoading: false,
      });
      // Persist so the trending column is warm on the next launch.
      persist(get());
    } catch (e) {
      const rate =
        e instanceof GhError && /rate limit/i.test(e.message)
          ? "GitHub API rate limit hit — try again in a minute."
          : String(e instanceof Error ? e.message : e);
      set({
        trendingLoading: false,
        trendingFetchedAt: nowMs,
        trendingStatus: "error",
        trendingError: rate,
      });
    }
  },

  toggleStar: async (fullName) => {
    const cur = get().trending.find((r) => r.fullName === fullName);
    if (!cur) return;
    const next = !cur.starred;
    // Optimistic flip.
    set((st) => ({
      trending: st.trending.map((r) =>
        r.fullName === fullName ? { ...r, starred: next } : r,
      ),
    }));
    try {
      await setStarred(fullName, next);
      // Persist the new star state into the cached trending snapshot.
      persist(get());
    } catch {
      // Revert on failure.
      set((st) => ({
        trending: st.trending.map((r) =>
          r.fullName === fullName ? { ...r, starred: cur.starred } : r,
        ),
      }));
    }
  },
  };
});

export type {
  FeedCategory,
  FeedEvent,
  TrendingRepo,
  TrendingTopic,
  TrendingRange,
  Viewer,
};
