/**
 * Thin wrappers over the GitHub CLI (`gh`) for the personal activity feed,
 * repository search ("trending"), and starring. Like the issues/actions
 * modules we drive `gh` rather than raw REST: `gh` injects the stored auth
 * token itself (from `gh auth login`), so the token never passes through our
 * JS. The feed is account-global, so these run with no cwd — gh uses the
 * active account's token regardless of the current folder.
 */

import { native } from "@/modules/ai/lib/native";

export class GhError extends Error {}

/**
 * Run a `gh` command and return parsed JSON of type T. Throws a {@link GhError}
 * carrying stderr on non-zero exit so the UI can show why (not installed, not
 * authenticated, rate-limited, …). `cwd` is intentionally null: the feed is an
 * account-level resource, not a per-repo one.
 */
async function ghJson<T>(args: string): Promise<T> {
  const res = await native.runCommand(`gh ${args}`, null, 30);
  if (res.exit_code !== 0) {
    const msg = (res.stderr || res.stdout || "gh command failed").trim();
    throw new GhError(msg);
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new GhError(`Could not parse gh output: ${res.stdout.slice(0, 200)}`);
  }
}

/** The authenticated user's login + avatar, used for the feed header. */
export type Viewer = { login: string; avatarUrl: string; name: string };

export async function resolveViewer(): Promise<Viewer> {
  const raw = await ghJson<{
    login: string;
    avatar_url: string;
    name: string | null;
  }>("api user");
  return {
    login: raw.login,
    avatarUrl: raw.avatar_url,
    name: raw.name ?? raw.login,
  };
}

/**
 * A normalized activity-feed event. GitHub's events API returns many `type`s
 * with heterogeneous `payload` shapes; we flatten the few we render into a
 * card-friendly model: a coarse `category` (drives the icon + accent color), a
 * short `action` verb, and — for rich events like releases/PRs/issues — an
 * optional `title` and `body` preview.
 */
export type FeedCategory =
  | "star"
  | "fork"
  | "push"
  | "create"
  | "pr"
  | "issue"
  | "comment"
  | "release"
  | "public"
  | "other";

export type FeedEvent = {
  id: string;
  type: string;
  category: FeedCategory;
  actor: string;
  actorAvatarUrl: string;
  repo: string;
  /** https URL to the most relevant target (repo, PR, issue, …). */
  url: string;
  createdAt: string;
  /** Short verb phrase, e.g. "starred", "opened a pull request". */
  action: string;
  /** Optional headline (release name, PR/issue title). */
  title?: string;
  /** Optional body preview (release notes, commit message, comment). */
  body?: string;
  /** Issue/PR number, when applicable. */
  number?: number;
};

/** Raw event shape from `gh api /users/{login}/received_events`. */
type RawEvent = {
  id: string;
  type: string;
  actor: { login: string; avatar_url: string };
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
};

/**
 * The handful of GitHub `:emoji:` shortcodes that show up constantly in bot
 * comments and release notes. GitHub renders these to unicode; markdown
 * renderers don't, so we expand the common ones ourselves. Unknown shortcodes
 * are left as-is (harmless literal text).
 */
const EMOJI: Record<string, string> = {
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  rocket: "🚀",
  tada: "🎉",
  sparkles: "✨",
  bug: "🐛",
  fire: "🔥",
  zap: "⚡",
  book: "📖",
  memo: "📝",
  bell: "🔔",
  lock: "🔒",
  art: "🎨",
  recycle: "♻️",
  wrench: "🔧",
  hammer: "🔨",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
  package: "📦",
  construction: "🚧",
  bookmark: "🔖",
  boom: "💥",
  ambulance: "🚑",
  green_heart: "💚",
  heart: "❤️",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  eyes: "👀",
  point_right: "👉",
  pushpin: "📌",
  label: "🏷️",
  lipstick: "💄",
  loud_sound: "🔊",
  mute: "🔇",
  truck: "🚚",
  pencil2: "✏️",
};

function expandEmoji(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (m, code: string) => EMOJI[code] ?? m);
}

/**
 * Normalize a markdown body for the feed card: fix literal "\n" artifacts,
 * expand emoji shortcodes, strip HTML comments, and truncate to a preview
 * length on a word boundary. The markdown itself is preserved so the card can
 * render it with the project's markdown renderer (headings, lists, code, links).
 */
function preview(text: string | undefined | null, max = 600): string | undefined {
  if (!text) return undefined;
  let clean = text
    .replace(/\r/g, "")
    // Some release bodies arrive with literal backslash-n sequences rather than
    // real newlines; normalize so they render as paragraphs, not "\n" text.
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  clean = expandEmoji(clean);
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  // Truncate at the last whitespace before the cap so we don't cut mid-word or
  // mid-markdown-token; append an ellipsis. The card shows "Read more" anyway.
  const cut = clean.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n") > max - 120 ? cut.lastIndexOf("\n") : cut.lastIndexOf(" ");
  return `${cut.slice(0, lastBreak > 0 ? lastBreak : max).trimEnd()}…`;
}

type Described = {
  category: FeedCategory;
  url: string;
  action: string;
  title?: string;
  body?: string;
  number?: number;
};

/** Map one raw event to the card model by its `type`. */
function describe(e: RawEvent): Described {
  const repoUrl = `https://github.com/${e.repo.name}`;
  const p = e.payload as {
    action?: string;
    ref?: string;
    ref_type?: string;
    pull_request?: { html_url: string; number: number; title: string; body: string | null };
    issue?: { html_url: string; number: number; title: string; body: string | null };
    comment?: { html_url: string; body: string | null };
    release?: { html_url: string; tag_name: string; name: string | null; body: string | null };
    commits?: { message: string }[];
  };
  switch (e.type) {
    case "WatchEvent":
      return { category: "star", url: repoUrl, action: "starred" };
    case "ForkEvent":
      return { category: "fork", url: repoUrl, action: "forked" };
    case "PushEvent": {
      const n = p.commits?.length ?? 0;
      const branch = (p.ref ?? "").replace("refs/heads/", "");
      return {
        category: "push",
        url: repoUrl,
        action: `pushed ${n} commit${n === 1 ? "" : "s"}${branch ? ` to ${branch}` : ""}`,
        body: preview(p.commits?.map((c) => `• ${c.message.split("\n")[0]}`).join("\n"), 240),
      };
    }
    case "CreateEvent":
      return {
        category: "create",
        url: repoUrl,
        action: `created ${p.ref_type ?? "repository"}${p.ref ? ` ${p.ref}` : ""}`,
      };
    case "PullRequestEvent":
      return {
        category: "pr",
        url: p.pull_request?.html_url ?? repoUrl,
        action: `${p.action ?? "updated"} a pull request`,
        number: p.pull_request?.number,
        title: p.pull_request?.title,
        body: preview(p.pull_request?.body),
      };
    case "PullRequestReviewEvent":
      return {
        category: "pr",
        url: p.pull_request?.html_url ?? repoUrl,
        action: "reviewed a pull request",
        number: p.pull_request?.number,
        title: p.pull_request?.title,
      };
    case "PullRequestReviewCommentEvent":
      return {
        category: "comment",
        url: p.comment?.html_url ?? p.pull_request?.html_url ?? repoUrl,
        action: "commented on a pull request",
        number: p.pull_request?.number,
        title: p.pull_request?.title,
        body: preview(p.comment?.body),
      };
    case "IssuesEvent":
      return {
        category: "issue",
        url: p.issue?.html_url ?? repoUrl,
        action: `${p.action ?? "updated"} an issue`,
        number: p.issue?.number,
        title: p.issue?.title,
        body: preview(p.issue?.body),
      };
    case "IssueCommentEvent":
      return {
        category: "comment",
        url: p.comment?.html_url ?? p.issue?.html_url ?? repoUrl,
        action: "commented",
        number: p.issue?.number,
        title: p.issue?.title,
        body: preview(p.comment?.body),
      };
    case "ReleaseEvent":
      return {
        category: "release",
        url: p.release?.html_url ?? repoUrl,
        action: "released",
        title: p.release?.name || p.release?.tag_name,
        body: preview(p.release?.body),
      };
    case "PublicEvent":
      return { category: "public", url: repoUrl, action: "open-sourced" };
    case "GollumEvent":
      return { category: "other", url: repoUrl, action: "updated the wiki" };
    default:
      return {
        category: "other",
        url: repoUrl,
        action: e.type.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
      };
  }
}

function normalizeEvent(e: RawEvent): FeedEvent {
  const d = describe(e);
  return {
    id: e.id,
    type: e.type,
    category: d.category,
    actor: e.actor.login,
    actorAvatarUrl: e.actor.avatar_url,
    repo: e.repo.name,
    url: d.url,
    createdAt: e.created_at,
    action: d.action,
    title: d.title,
    body: d.body,
    number: d.number,
  };
}

/**
 * Fetch the authenticated user's received-events feed (the same stream GitHub
 * shows on your dashboard: activity from people/repos you follow). Newest
 * first. `limit` is capped at 100 by the events API.
 */
export async function listFeed(
  login: string,
  limit = 50,
  page = 1,
): Promise<FeedEvent[]> {
  const raw = await ghJson<RawEvent[]>(
    `api "/users/${login}/received_events?per_page=${Math.min(limit, 100)}&page=${page}"`,
  );
  return raw.map(normalizeEvent);
}

/**
 * The `received_events` payload trims pull-request title/body (unlike issues),
 * so PR cards arrive title-less. This backfills them with one
 * `gh api /repos/{repo}/pulls/{n}` per distinct (repo, number), run in parallel
 * with a small concurrency cap to respect rate limits. Failures are ignored —
 * the card just stays compact. Returns a NEW array; the input is not mutated.
 */
export async function enrichPullRequests(
  events: FeedEvent[],
  maxLookups = 12,
): Promise<FeedEvent[]> {
  // Distinct PR-category events that are missing a title and have a number.
  const wanted = new Map<string, { repo: string; number: number }>();
  for (const e of events) {
    if (e.category === "pr" && !e.title && e.number) {
      wanted.set(`${e.repo}#${e.number}`, { repo: e.repo, number: e.number });
    }
  }
  if (wanted.size === 0) return events;

  const targets = [...wanted.entries()].slice(0, maxLookups);
  const results = await Promise.all(
    targets.map(async ([key, { repo, number }]) => {
      try {
        const pr = await ghJson<{ title: string; body: string | null }>(
          `api /repos/${repo}/pulls/${number}`,
        );
        return [key, { title: pr.title, body: preview(pr.body) }] as const;
      } catch {
        return [key, null] as const;
      }
    }),
  );
  const byKey = new Map(results.filter((r) => r[1]).map((r) => r as [string, { title: string; body?: string }]));

  return events.map((e) => {
    if (e.category !== "pr" || e.title || !e.number) return e;
    const hit = byKey.get(`${e.repo}#${e.number}`);
    return hit ? { ...e, title: hit.title, body: e.body ?? hit.body } : e;
  });
}

/** One page of search-backed history events plus whether more pages remain. */
export type HistoryPage = { events: FeedEvent[]; hasMore: boolean };

/** Raw issue/PR row from `gh api search/issues`. */
type RawSearchIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  updated_at: string;
  created_at: string;
  draft?: boolean;
  pull_request?: { merged_at: string | null } | null;
  user: { login: string; avatar_url: string } | null;
  // `repository_url` is like https://api.github.com/repos/owner/name
  repository_url: string;
};

const SEARCH_PER_PAGE = 50;

function repoFromUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(/^.*\/repos\//, "");
}

function normalizeSearchIssue(r: RawSearchIssue): FeedEvent {
  const isPr = Boolean(r.pull_request);
  const merged = Boolean(r.pull_request?.merged_at);
  const action = isPr
    ? merged
      ? "merged a pull request"
      : r.state === "closed"
        ? "closed a pull request"
        : r.draft
          ? "opened a draft pull request"
          : "opened a pull request"
    : r.state === "closed"
      ? "closed an issue"
      : "opened an issue";
  return {
    // Prefix to avoid colliding with event-feed ids (those are numeric strings).
    id: `search-${r.id}`,
    type: isPr ? "PullRequestEvent" : "IssuesEvent",
    category: isPr ? "pr" : "issue",
    actor: r.user?.login ?? "",
    actorAvatarUrl: r.user?.avatar_url ?? "",
    repo: repoFromUrl(r.repository_url),
    url: r.html_url,
    // Search history is sorted/keyed by updated_at so re-touched threads surface.
    createdAt: r.updated_at,
    action,
    title: r.title,
    body: preview(r.body),
    number: r.number,
  };
}

/**
 * Date-bounded history via the Search API — the events firehose hard-caps at
 * 300 events (~hours for an active account), so to scroll back weeks we switch
 * to search, which supports `updated:>=DATE` and paginates to 1000 results.
 * `qualifier` scopes it (e.g. `involves:@me`); `sinceDate` is YYYY-MM-DD.
 * Returns one page plus whether another page exists.
 */
export async function searchHistory(
  qualifier: string,
  sinceDate: string,
  page = 1,
): Promise<HistoryPage> {
  const raw = await ghJson<{ total_count: number; items: RawSearchIssue[] }>(
    `api -X GET search/issues ` +
      `-f q="${qualifier} updated:>=${sinceDate}" ` +
      `-f sort=updated -f order=desc ` +
      `-f per_page=${SEARCH_PER_PAGE} -f page=${page}`,
  );
  const events = raw.items.map(normalizeSearchIssue);
  // Search API caps at 1000 results (20 pages of 50); stop at a full page only.
  const hasMore = events.length >= SEARCH_PER_PAGE && page < 20;
  return { events, hasMore };
}

/** A repository as `gh api search/repositories` returns it (trimmed). */
export type TrendingRepo = {
  fullName: string;
  description: string;
  stars: number;
  language: string | null;
  url: string;
  topics: string[];
  /** Whether the viewer currently stars this repo (filled in lazily). */
  starred?: boolean;
};

type RawSearchRepo = {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  html_url: string;
  topics?: string[];
};

/** Trending time window — maps to a `created:>=DATE` search qualifier. */
export type TrendingRange = "day" | "week" | "month";

/**
 * Trending repositories. GitHub has no official trending endpoint, so we use
 * the documented proxy: repos created within the window, sorted by stars
 * descending. `sinceDate` is computed by the caller (the store) because
 * `Date.now()` is environment-restricted in some contexts; pass an ISO date
 * (YYYY-MM-DD). `language` narrows to one language when set.
 */
export async function listTrending(
  sinceDate: string,
  language: string | null,
  limit = 30,
): Promise<TrendingRepo[]> {
  const langQ = language ? ` language:${language}` : "";
  // gh's -f flag URL-encodes the value, so spaces in `q` are safe.
  const raw = await ghJson<{ items: RawSearchRepo[] }>(
    `api -X GET search/repositories ` +
      `-f q="created:>=${sinceDate} stars:>=10${langQ}" ` +
      `-f sort=stars -f order=desc -f per_page=${Math.min(limit, 100)}`,
  );
  return raw.items.map((r) => ({
    fullName: r.full_name,
    description: r.description ?? "",
    stars: r.stargazers_count,
    language: r.language,
    url: r.html_url,
    topics: r.topics ?? [],
  }));
}

/** An aggregated trending topic: name + how many trending repos carry it. */
export type TrendingTopic = { topic: string; count: number };

/** Roll up topics across a trending repo list, most-common first. */
export function aggregateTopics(repos: TrendingRepo[], top = 20): TrendingTopic[] {
  const counts = new Map<string, number>();
  for (const r of repos) {
    for (const t of r.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

/**
 * Star (PUT) or unstar (DELETE) a repo for the authenticated user. Both calls
 * are idempotent and return 204 No Content, so we go through `runCommand`
 * directly (no JSON to parse) and surface stderr on failure.
 */
export async function setStarred(
  fullName: string,
  starred: boolean,
): Promise<void> {
  const method = starred ? "PUT" : "DELETE";
  const res = await native.runCommand(
    `gh api -X ${method} /user/starred/${fullName}`,
    null,
    30,
  );
  if (res.exit_code !== 0) {
    throw new GhError((res.stderr || res.stdout || "star request failed").trim());
  }
}

/**
 * Whether the viewer stars each of `fullNames`. `gh api /user/starred/{repo}`
 * exits 0 (204) when starred and non-zero (404) when not, so we map exit code
 * → boolean. Runs in parallel; failures default to `false` (treated as
 * not-starred rather than blocking the list).
 */
export async function fetchStarred(
  fullNames: string[],
): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    fullNames.map(async (name) => {
      try {
        const res = await native.runCommand(
          `gh api /user/starred/${name}`,
          null,
          20,
        );
        return [name, res.exit_code === 0] as const;
      } catch {
        return [name, false] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
