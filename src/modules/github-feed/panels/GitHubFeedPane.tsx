import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CodeIcon,
  Comment01Icon,
  FireIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GithubIcon,
  GlobalIcon,
  PlusSignIcon,
  RecordIcon,
  RefreshIcon,
  RocketIcon,
  Search01Icon,
  SourceCodeIcon,
  StarIcon,
  StarOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  POLL_INTERVAL_MS,
  useFeedStore,
  type FeedCategory,
  type FeedEvent,
  type TrendingRange,
  type TrendingRepo,
} from "../store/feedStore";

/** Time-range tabs for the trending column. */
const RANGES: { id: TrendingRange; label: string }[] = [
  { id: "day", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

/** Common languages offered in the trending language picker. "" = any. */
const LANGUAGES = [
  "",
  "TypeScript",
  "JavaScript",
  "Python",
  "Rust",
  "Go",
  "Java",
  "C++",
  "C#",
  "Swift",
  "Kotlin",
  "Ruby",
];

/**
 * Per-category icon + accent color (text + soft bg). Mirrors GitHub's feed,
 * where each activity type gets a colored glyph so the eye can scan by kind.
 */
const CATEGORY_STYLE: Record<
  FeedCategory,
  { icon: typeof StarIcon; fg: string; bg: string }
> = {
  star: { icon: StarIcon, fg: "text-amber-400", bg: "bg-amber-400/10" },
  fork: { icon: GitForkIcon, fg: "text-sky-400", bg: "bg-sky-400/10" },
  push: { icon: SourceCodeIcon, fg: "text-violet-400", bg: "bg-violet-400/10" },
  create: { icon: PlusSignIcon, fg: "text-emerald-400", bg: "bg-emerald-400/10" },
  pr: { icon: GitPullRequestIcon, fg: "text-emerald-400", bg: "bg-emerald-400/10" },
  issue: { icon: RecordIcon, fg: "text-green-400", bg: "bg-green-400/10" },
  comment: { icon: Comment01Icon, fg: "text-blue-400", bg: "bg-blue-400/10" },
  release: { icon: RocketIcon, fg: "text-fuchsia-400", bg: "bg-fuchsia-400/10" },
  public: { icon: GlobalIcon, fg: "text-teal-400", bg: "bg-teal-400/10" },
  other: { icon: CodeIcon, fg: "text-muted-foreground", bg: "bg-foreground/5" },
};

/** Filter-chip labels keyed by category (friendlier than raw event types). */
const CATEGORY_LABEL: Record<FeedCategory, string> = {
  star: "Stars",
  fork: "Forks",
  push: "Pushes",
  create: "Created",
  pr: "Pull requests",
  issue: "Issues",
  comment: "Comments",
  release: "Releases",
  public: "Open-sourced",
  other: "Other",
};

/** Relative "2 minutes ago" style timestamp (long form, like GitHub). */
function ago(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * A feed item is either a single rich event or a collapsed group of low-signal
 * events (e.g. "12 people starred owner/repo"). Grouping mirrors GitHub, which
 * folds runs of stars/forks into one card so releases/PRs stand out.
 */
type FeedItem =
  | { kind: "single"; event: FeedEvent; compact?: boolean }
  // "pile" — star/fork events folded by repo into an avatar stack.
  | {
      kind: "group";
      category: FeedCategory;
      repo: string;
      action: string;
      url: string;
      actors: { login: string; avatarUrl: string }[];
      latestAt: string;
    }
  // "thread" — several events folded into one collapsible card. Two flavors:
  //   • conversation: many events on the SAME repo#number (busy PR/issue)
  //   • burst: ONE actor doing the SAME action across MANY items in a repo
  //     (e.g. "bartlomieju labeled 8 issues in denoland/deno")
  // `heading` is the pre-rendered summary line; `subtitle` is an optional
  // single title (only meaningful for the conversation flavor).
  | {
      kind: "thread";
      flavor: "conversation" | "burst";
      repo: string;
      heading: string;
      url: string;
      events: FeedEvent[];
      latestAt: string;
    };

/** Star/fork fold into an avatar pile by repo. */
const PILE = new Set<FeedCategory>(["star", "fork"]);
/** These categories participate in thread/burst folding. */
const FOLDABLE = new Set<FeedCategory>(["comment", "pr", "issue"]);
/** Minimum members for a burst (one actor, same action) to fold. */
const BURST_MIN = 3;

/**
 * Compress the feed for readability, in priority order per event:
 *  1. star/fork → "pile" card per repo (avatar stack).
 *  2. comment/pr/issue on the same repo#number (≥2) → "conversation" thread.
 *  3. comment/pr/issue with the same repo+actor+action (≥3) that didn't join a
 *     conversation → "burst" thread (one actor hammering one repo).
 *  4. otherwise → a normal card (or compact row for a lone star/fork).
 * All folds are window-wide and anchored at each bucket's first event so the
 * chronological position is preserved.
 */
function groupFeed(events: FeedEvent[]): FeedItem[] {
  // Pre-compute bucket membership so we can decide an event's fate up front.
  const pileOf = new Map<string, FeedEvent[]>();
  const convoOf = new Map<string, FeedEvent[]>();
  const burstOf = new Map<string, FeedEvent[]>();
  const pileKey = (e: FeedEvent) => `${e.category}:${e.repo}`;
  const convoKey = (e: FeedEvent) => `${e.repo}#${e.number}`;
  const burstKey = (e: FeedEvent) => `${e.repo}|${e.actor}|${e.action}`;

  for (const e of events) {
    if (PILE.has(e.category)) {
      (pileOf.get(pileKey(e)) ?? pileOf.set(pileKey(e), []).get(pileKey(e))!).push(e);
    } else if (FOLDABLE.has(e.category)) {
      if (e.number)
        (convoOf.get(convoKey(e)) ?? convoOf.set(convoKey(e), []).get(convoKey(e))!).push(e);
      (burstOf.get(burstKey(e)) ?? burstOf.set(burstKey(e), []).get(burstKey(e))!).push(e);
    }
  }

  // Decide which bucket (if any) each event belongs to, by priority.
  type Assign = { type: "pile" | "convo" | "burst"; key: string } | null;
  const assign = (e: FeedEvent): Assign => {
    if (PILE.has(e.category)) return { type: "pile", key: pileKey(e) };
    if (FOLDABLE.has(e.category)) {
      if (e.number && (convoOf.get(convoKey(e))?.length ?? 0) >= 2)
        return { type: "convo", key: convoKey(e) };
      if ((burstOf.get(burstKey(e))?.length ?? 0) >= BURST_MIN)
        return { type: "burst", key: burstKey(e) };
    }
    return null;
  };

  // Emit in source order, anchoring each bucket at its first event.
  const emitted = new Set<string>();
  const items: FeedItem[] = [];
  for (const e of events) {
    const a = assign(e);
    if (!a) {
      items.push({ kind: "single", event: e });
      continue;
    }
    const tag = `${a.type}:${a.key}`;
    if (emitted.has(tag)) continue;
    emitted.add(tag);

    if (a.type === "pile") {
      const bucket = pileOf.get(a.key) ?? [e];
      if (bucket.length === 1) {
        items.push({ kind: "single", event: bucket[0], compact: true });
      } else {
        const seen = new Set<string>();
        const actors = bucket
          .filter((x) => !seen.has(x.actor) && seen.add(x.actor))
          .map((x) => ({ login: x.actor, avatarUrl: x.actorAvatarUrl }));
        items.push({
          kind: "group",
          category: bucket[0].category,
          repo: bucket[0].repo,
          action: bucket[0].action,
          url: bucket[0].url,
          actors,
          latestAt: bucket[0].createdAt,
        });
      }
    } else if (a.type === "convo") {
      const bucket = convoOf.get(a.key) ?? [e];
      const title = bucket.find((x) => x.title)?.title;
      const num = bucket[0].number;
      items.push({
        kind: "thread",
        flavor: "conversation",
        repo: bucket[0].repo,
        heading: `${bucket.length} updates on #${num}${title ? ` — ${title}` : ""}`,
        url: bucket[0].url,
        events: bucket,
        latestAt: bucket[0].createdAt,
      });
    } else {
      const bucket = burstOf.get(a.key) ?? [e];
      items.push({
        kind: "thread",
        flavor: "burst",
        repo: bucket[0].repo,
        heading: `${bucket[0].actor} ${bucket[0].action.replace(/ a(n)? /, " ")} on ${bucket.length} items`,
        url: `https://github.com/${bucket[0].repo}`,
        events: bucket,
        latestAt: bucket[0].createdAt,
      });
    }
  }
  return items;
}

export function GitHubFeedPane() {
  const viewer = useFeedStore((s) => s.viewer);
  const loadFeed = useFeedStore((s) => s.loadFeed);
  const loadTrending = useFeedStore((s) => s.loadTrending);

  const feed = useFeedStore((s) => s.feed);
  const feedStatus = useFeedStore((s) => s.feedStatus);
  const feedError = useFeedStore((s) => s.feedError);
  const feedLoading = useFeedStore((s) => s.feedLoading);
  const feedHasMore = useFeedStore((s) => s.feedHasMore);
  const feedLoadingMore = useFeedStore((s) => s.feedLoadingMore);
  const feedMode = useFeedStore((s) => s.feedMode);
  const loadMoreFeed = useFeedStore((s) => s.loadMoreFeed);

  const trending = useFeedStore((s) => s.trending);
  const topics = useFeedStore((s) => s.topics);
  const trendingStatus = useFeedStore((s) => s.trendingStatus);
  const trendingError = useFeedStore((s) => s.trendingError);
  const trendingLoading = useFeedStore((s) => s.trendingLoading);

  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState<FeedCategory | null>(null);
  const [range, setRange] = useState<TrendingRange>("week");
  const [language, setLanguage] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  useEffect(() => {
    void loadFeed(Date.now());
    const id = setInterval(() => void loadFeed(Date.now()), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadFeed]);

  useEffect(() => {
    const lang = language || null;
    void loadTrending(Date.now(), range, lang);
    const id = setInterval(
      () => void loadTrending(Date.now(), range, lang),
      POLL_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [loadTrending, range, language]);

  // Infinite scroll: when the sentinel near the list bottom scrolls into view,
  // pull the next page. An IntersectionObserver (rooted on the scroll column)
  // is cheaper than an onScroll handler and fires once per crossing. Disabled
  // while filtering, since filters operate on the already-loaded set.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const filtering = query.trim().length > 0 || catFilter !== null;
  useEffect(() => {
    if (filtering || !feedHasMore) return;
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreFeed();
      },
      { root, rootMargin: "400px 0px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [filtering, feedHasMore, loadMoreFeed, feed.length]);

  // Categories present in the current feed, ordered by GitHub-ish priority.
  const cats = useMemo(() => {
    const order: FeedCategory[] = [
      "release",
      "pr",
      "issue",
      "comment",
      "push",
      "fork",
      "star",
      "create",
      "public",
      "other",
    ];
    const present = new Set(feed.map((e) => e.category));
    return order.filter((c) => present.has(c));
  }, [feed]);

  const filteredFeed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return feed.filter((e) => {
      if (catFilter && e.category !== catFilter) return false;
      if (!q) return true;
      return (
        e.repo.toLowerCase().includes(q) ||
        e.actor.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q) ||
        (e.title?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [feed, query, catFilter]);

  const items = useMemo(() => groupFeed(filteredFeed), [filteredFeed]);

  const filteredTrending = useMemo(() => {
    if (!topicFilter) return trending;
    return trending.filter((r) => r.topics.includes(topicFilter));
  }, [trending, topicFilter]);

  const reload = () => {
    void loadFeed(Date.now(), true);
    void loadTrending(Date.now(), range, language || null, true);
  };

  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-5">
        <HugeiconsIcon icon={GithubIcon} size={19} strokeWidth={1.75} />
        <span className="text-[15px] font-semibold text-foreground">Feed</span>
        {viewer ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <img src={viewer.avatarUrl} alt="" className="size-5 rounded-full" />
            {viewer.login}
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={reload}
          title="Reload"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={15}
            strokeWidth={1.75}
            className={cn((feedLoading || trendingLoading) && "animate-spin")}
          />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- Feed column ---- */}
        <div className="flex min-h-0 flex-col border-r border-border/60">
          <div className="flex shrink-0 flex-col gap-2.5 border-b border-border/60 px-5 py-3">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter feed by repo, user, or action…"
                className="w-full rounded-lg border border-border/60 bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
              />
            </div>
            {cats.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={catFilter === null} onClick={() => setCatFilter(null)}>
                  All
                </Chip>
                {cats.map((c) => {
                  const st = CATEGORY_STYLE[c];
                  return (
                    <Chip
                      key={c}
                      active={catFilter === c}
                      onClick={() => setCatFilter(c)}
                    >
                      <HugeiconsIcon icon={st.icon} size={11} className={st.fg} />
                      {CATEGORY_LABEL[c]}
                    </Chip>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          >
            {feedStatus === "loading" ? (
              <Centered>Loading feed…</Centered>
            ) : feedStatus === "error" ? (
              <Centered tone="error">
                Could not load feed.
                <br />
                <span className="text-muted-foreground">{feedError}</span>
              </Centered>
            ) : items.length === 0 ? (
              <Centered>
                {feed.length === 0 ? "No recent activity." : "No matches."}
              </Centered>
            ) : (
              <div className="mx-auto flex max-w-2xl flex-col gap-2">
                {items.map((item) =>
                  item.kind === "single" ? (
                    item.compact ? (
                      <CompactRow
                        key={item.event.id}
                        event={item.event}
                        nowMs={now}
                      />
                    ) : (
                      <EventCard
                        key={item.event.id}
                        event={item.event}
                        nowMs={now}
                      />
                    )
                  ) : item.kind === "thread" ? (
                    <ThreadCard
                      key={`${item.flavor}:${item.repo}:${item.heading}:${item.latestAt}`}
                      item={item}
                      nowMs={now}
                    />
                  ) : (
                    <GroupCard
                      key={`${item.category}:${item.repo}:${item.latestAt}`}
                      item={item}
                      nowMs={now}
                    />
                  ),
                )}

                {/* Infinite-scroll sentinel + status. Hidden while filtering. */}
                {!filtering ? (
                  <div ref={sentinelRef} className="py-3 text-center">
                    {feedLoadingMore ? (
                      <span className="text-xs text-muted-foreground">
                        {feedMode === "history"
                          ? "Loading older history…"
                          : "Loading more…"}
                      </span>
                    ) : !feedHasMore ? (
                      <span className="text-[11px] text-muted-foreground/60">
                        End of the last 4 weeks
                      </span>
                    ) : feedMode === "history" ? (
                      <span className="text-[11px] text-muted-foreground/50">
                        Live activity ends here — showing history (last 4 weeks)
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* ---- Trending column ---- */}
        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <HugeiconsIcon icon={FireIcon} size={14} className="text-orange-500" />
              Trending
            </div>
            <div className="flex items-center gap-1">
              {RANGES.map((r) => (
                <Chip
                  key={r.id}
                  active={range === r.id}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </Chip>
              ))}
              <div className="flex-1" />
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary/50"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l === "" ? "Any lang" : l}
                  </option>
                ))}
              </select>
            </div>

            {topics.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {topicFilter ? (
                  <Chip active onClick={() => setTopicFilter(null)}>
                    <HugeiconsIcon icon={Cancel01Icon} size={10} />
                    {topicFilter}
                  </Chip>
                ) : (
                  topics.slice(0, 12).map((t) => (
                    <Chip
                      key={t.topic}
                      active={false}
                      onClick={() => setTopicFilter(t.topic)}
                    >
                      {t.topic}
                      <span className="opacity-50">{t.count}</span>
                    </Chip>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {trendingStatus === "loading" ? (
              <Centered>Loading trending…</Centered>
            ) : trendingStatus === "error" ? (
              <Centered tone="error">
                Could not load trending.
                <br />
                <span className="text-muted-foreground">{trendingError}</span>
              </Centered>
            ) : filteredTrending.length === 0 ? (
              <Centered>No trending repos.</Centered>
            ) : (
              <div className="divide-y divide-border/40">
                {filteredTrending.map((r) => (
                  <TrendingRow key={r.fullName} repo={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-border bg-foreground/[0.09] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "px-4 py-10 text-center text-xs leading-relaxed",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** Small colored category glyph shown beside the avatar on every card. */
function CategoryBadge({ category }: { category: FeedCategory }) {
  const st = CATEGORY_STYLE[category];
  return (
    <span
      className={cn(
        "flex size-5 items-center justify-center rounded-full ring-2 ring-background",
        st.bg,
      )}
    >
      <HugeiconsIcon icon={st.icon} size={12} className={st.fg} />
    </span>
  );
}

/** Avatar with a category badge tucked into the bottom-right corner. */
function AvatarWithBadge({
  avatarUrl,
  category,
}: {
  avatarUrl: string;
  category: FeedCategory;
}) {
  return (
    <div className="relative shrink-0">
      <img src={avatarUrl} alt="" className="size-9 rounded-full" />
      <span className="absolute -bottom-1 -right-1">
        <CategoryBadge category={category} />
      </span>
    </div>
  );
}

const MD_COMPONENTS = { code: MarkdownCode };

/**
 * Renders a feed body as GitHub-flavored markdown using the project's shared
 * Streamdown renderer. Tight prose styling keeps it compact inside the card;
 * links open in the system browser via the global opener (Streamdown emits
 * normal <a> tags, which Tauri routes through the opener plugin).
 */
function FeedMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      className={cn(
        // The repo has no @tailwindcss/typography plugin, so `prose-*` classes
        // are no-ops; Streamdown self-styles its elements. We just set the base
        // size/color and trim leading/trailing margins to fit the card.
        "select-text text-[13px] leading-relaxed text-muted-foreground",
        "[&_a]:text-primary [&_a:hover]:underline",
        "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-[13px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_:is(h1,h2,h3)]:text-foreground/90",
        "[&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
        "[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5",
        "[&>*]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
      components={MD_COMPONENTS}
    >
      {children}
    </Streamdown>
  );
}

function EventCard({ event, nowMs }: { event: FeedEvent; nowMs: number }) {
  const open = () => void openUrl(event.url).catch(() => {});
  const hasBody = Boolean(event.body);
  const [expanded, setExpanded] = useState(false);
  // Collapse long bodies behind a max-height + fade until "Read more".
  const longBody = (event.body?.length ?? 0) > 220;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 transition-colors hover:border-border">
      {/* Header */}
      <button
        type="button"
        onClick={open}
        className="flex w-full items-start gap-3 px-4 pt-3.5 text-left"
      >
        <AvatarWithBadge avatarUrl={event.actorAvatarUrl} category={event.category} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="text-sm leading-snug">
            <span className="font-semibold text-foreground">{event.repo}</span>{" "}
            <span className="text-muted-foreground">{event.action}</span>
            {event.number ? (
              <span className="text-muted-foreground"> #{event.number}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{event.actor}</span>
            <span>·</span>
            <span>{ago(event.createdAt, nowMs)}</span>
          </div>
        </div>
      </button>

      {/* Title + body (releases, PRs, issues, comments, pushes) */}
      {event.title || hasBody ? (
        <div className="px-4 pb-3.5 pt-2.5">
          {event.title ? (
            <button
              type="button"
              onClick={open}
              className="mb-1.5 block text-left text-[15px] font-semibold leading-snug text-foreground hover:underline"
            >
              {event.title}
            </button>
          ) : null}
          {hasBody ? (
            <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
              <div
                className={cn(
                  "relative overflow-hidden",
                  longBody && !expanded && "max-h-24",
                )}
              >
                <FeedMarkdown>{event.body as string}</FeedMarkdown>
                {longBody && !expanded ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/90 to-transparent" />
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                {longBody ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="text-xs font-semibold text-foreground hover:underline"
                  >
                    {expanded ? "Show less" : "Read more"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={open}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  Open on GitHub
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="pb-3.5" />
      )}
    </div>
  );
}

/**
 * Compact one-line row for a lone low-signal event (a single star/fork). Keeps
 * the feed scannable — full cards are reserved for releases/PRs/issues.
 */
function CompactRow({ event, nowMs }: { event: FeedEvent; nowMs: number }) {
  const st = CATEGORY_STYLE[event.category];
  return (
    <button
      type="button"
      onClick={() => void openUrl(event.url).catch(() => {})}
      title={`${event.actor} ${event.action} ${event.repo}`}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent/40"
    >
      <img
        src={event.actorAvatarUrl}
        alt=""
        className="size-5 shrink-0 rounded-full"
      />
      <HugeiconsIcon icon={st.icon} size={13} className={cn("shrink-0", st.fg)} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
        <span className="font-semibold">{event.repo}</span>{" "}
        <span className="text-muted-foreground">{event.action}</span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {event.actor} · {ago(event.createdAt, nowMs)}
      </span>
    </button>
  );
}

function GroupCard({
  item,
  nowMs,
}: {
  item: Extract<FeedItem, { kind: "group" }>;
  nowMs: number;
}) {
  const open = () => void openUrl(item.url).catch(() => {});
  const shown = item.actors.slice(0, 7);
  const extra = item.actors.length - shown.length;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 transition-colors hover:border-border">
      <button
        type="button"
        onClick={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <div className="relative shrink-0 pt-0.5">
          <CategoryBadge category={item.category} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-sm leading-snug">
            <span className="font-semibold text-foreground">
              {item.actors.length} people
            </span>{" "}
            <span className="text-muted-foreground">{item.action}</span>{" "}
            <span className="font-semibold text-foreground">{item.repo}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex -space-x-2">
              {shown.map((a) => (
                <img
                  key={a.login}
                  src={a.avatarUrl}
                  alt={a.login}
                  title={a.login}
                  className="size-6 rounded-full ring-2 ring-card"
                />
              ))}
            </div>
            {extra > 0 ? (
              <span className="text-xs text-muted-foreground">+{extra}</span>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {ago(item.latestAt, nowMs)}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

/**
 * Collapsible card for a folded set of events — either a conversation (many
 * events on one repo#number) or a burst (one actor repeating an action across
 * many items in a repo). Collapsed shows the pre-rendered `heading` + a
 * participant avatar pile; expands to a compact per-event list with body
 * previews.
 */
function ThreadCard({
  item,
  nowMs,
}: {
  item: Extract<FeedItem, { kind: "thread" }>;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = () => void openUrl(item.url).catch(() => {});
  // Distinct participants, for the avatar pile in the header.
  const seen = new Set<string>();
  const actors = item.events.filter(
    (e) => !seen.has(e.actor) && seen.add(e.actor),
  );
  const shown = actors.slice(0, 5);
  const st = CATEGORY_STYLE[item.events[0].category];
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 transition-colors hover:border-border">
      {/* Header — click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
            st.bg,
          )}
        >
          <HugeiconsIcon icon={st.icon} size={15} className={st.fg} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-sm leading-snug">
            <span className="font-semibold text-foreground">{item.repo}</span>
          </div>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">
            {item.heading}
          </span>
          <div className="flex items-center gap-1.5">
            <div className="flex -space-x-2">
              {shown.map((a) => (
                <img
                  key={a.actor}
                  src={a.actorAvatarUrl}
                  alt={a.actor}
                  title={a.actor}
                  className="size-5 rounded-full ring-2 ring-card"
                />
              ))}
            </div>
            <span className="ml-auto text-xs text-muted-foreground">
              {ago(item.latestAt, nowMs)}
            </span>
          </div>
        </div>
        <span className="mt-0.5 text-xs font-medium text-muted-foreground">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>

      {/* Expanded: each event as a compact sub-row */}
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-border/50 px-4 py-3">
          {item.events.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => void openUrl(e.url).catch(() => {})}
              className="flex flex-col gap-1 rounded-lg px-2 py-1.5 text-left hover:bg-accent/40"
            >
              <div className="flex items-center gap-1.5 text-xs">
                <img
                  src={e.actorAvatarUrl}
                  alt=""
                  className="size-4 rounded-full"
                />
                <span className="font-medium text-foreground/90">{e.actor}</span>
                <span className="text-muted-foreground">{e.action}</span>
                <span className="text-muted-foreground">
                  · {ago(e.createdAt, nowMs)}
                </span>
              </div>
              {e.body ? (
                <p className="line-clamp-2 pl-5 text-[12px] leading-relaxed text-muted-foreground">
                  {e.body}
                </p>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            onClick={open}
            className="self-start px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            {item.flavor === "conversation"
              ? "Open on GitHub"
              : `Open ${item.repo} on GitHub`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TrendingRow({ repo }: { repo: TrendingRepo }) {
  const toggleStar = useFeedStore((s) => s.toggleStar);
  return (
    <div className="group flex items-start gap-2 px-4 py-2.5 hover:bg-accent/40">
      <button
        type="button"
        onClick={() => void openUrl(repo.url).catch(() => {})}
        title={`${repo.fullName} — open on GitHub`}
        className="flex min-w-0 flex-1 flex-col text-left"
      >
        <span className="truncate text-xs font-semibold text-foreground/90">
          {repo.fullName}
        </span>
        {repo.description ? (
          <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {repo.description}
          </span>
        ) : null}
        <span className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-0.5">
            <HugeiconsIcon icon={StarIcon} size={10} />
            {repo.stars.toLocaleString()}
          </span>
          {repo.language ? <span>· {repo.language}</span> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={() => void toggleStar(repo.fullName)}
        title={repo.starred ? "Unstar" : "Star"}
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          repo.starred
            ? "border-amber-400/40 text-amber-400 hover:bg-accent"
            : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <HugeiconsIcon
          icon={repo.starred ? StarIcon : StarOffIcon}
          size={14}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
}
