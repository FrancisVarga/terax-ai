import { LazyStore } from "@tauri-apps/plugin-store";
import { normalizePath } from "./projects";
import type {
  GitHubIssue,
  GitHubRepo,
  GitHubRun,
  RepoSummary,
} from "./projectInsights";
import type { GitLogEntry } from "@/modules/ai/lib/native";

/**
 * Disk-backed, stale-while-revalidate cache for project insights.
 *
 * The insight hooks ({@link useProjectInsights}, {@link useProjectCardInsights})
 * spawn `git`/`gh` subprocesses on every mount. The dashboard wires the card
 * hook to an IntersectionObserver, so scrolling a large grid re-spawns those
 * processes constantly, and reopening a detail page re-fetches from scratch.
 *
 * This cache persists each project's resolved insight data to a JSON file (via
 * tauri-plugin-store, the same mechanism `projects.ts` / settings use) so the
 * data survives app restarts. Hooks read the cache first — showing last-known
 * values immediately — then revalidate in the background and write fresh data
 * back. Only successfully-resolved payloads are cached; transient loading /
 * error states are UI-only and never persisted.
 */

/** Per-source cached payloads. Each is the resolved `data` of a `Loadable`. */
export type CachedInsights = {
  summary?: RepoSummary;
  commits?: GitLogEntry[];
  readme?: { content: string };
  repo?: GitHubRepo;
  issues?: GitHubIssue[];
  runs?: GitHubRun[];
  /** Compact card subset, cached separately so the cheap card path doesn't
   *  depend on the heavier detail-page sources being present. */
  card?: {
    summary?: RepoSummary;
    stars: number | null;
    openIssues: number | null;
    lastCommit: { subject: string; atMs: number } | null;
  };
};

type Entry = {
  data: CachedInsights;
  /** Epoch-ms each source was last written, for per-source staleness. */
  updatedAt: number;
};

const STORE_PATH = "terax-project-insights.json";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/**
 * Default freshness window. An entry older than this is still returned (so the
 * UI never blanks), but the hook will also revalidate. 10 minutes balances
 * "feels live" against "don't re-spawn gh on every scroll".
 */
export const INSIGHTS_TTL_MS = 10 * 60 * 1000;

/** Normalize a project path into the cache key. Mirrors the store's convention
 *  so a card and the detail page for the same folder hit one entry. */
function keyOf(projectPath: string): string {
  return normalizePath(projectPath);
}

/** Read a project's cached insights, or null if never cached. */
export async function readInsights(
  projectPath: string,
): Promise<{ data: CachedInsights; stale: boolean } | null> {
  const entry = await store.get<Entry>(keyOf(projectPath));
  if (!entry || typeof entry !== "object" || !entry.data) return null;
  const stale = isStale(entry.updatedAt);
  return { data: entry.data, stale };
}

/** True when an entry's timestamp is older than the TTL (or missing). */
function isStale(updatedAt: number | undefined): boolean {
  if (typeof updatedAt !== "number") return true;
  // `Date.now()` is fine here — this is runtime UI code, not a workflow script.
  return Date.now() - updatedAt > INSIGHTS_TTL_MS;
}

/**
 * Merge a partial insight payload into a project's cache entry and persist it.
 *
 * Merging (rather than replacing) lets each independently-resolving source
 * write as it lands — the same incremental pattern the hooks already use for
 * their in-memory state — without clobbering sources resolved earlier in the
 * same pass. `autoSave: 200` debounces the actual disk write, so calling this
 * once per source is cheap.
 */
export async function writeInsights(
  projectPath: string,
  patch: Partial<CachedInsights>,
): Promise<void> {
  const key = keyOf(projectPath);
  const prev = (await store.get<Entry>(key)) ?? null;
  const merged: Entry = {
    data: { ...(prev?.data ?? {}), ...patch },
    updatedAt: Date.now(),
  };
  await store.set(key, merged);
  await store.save();
}

/** Drop a project's cache entry (e.g. when it's removed from the dashboard). */
export async function clearInsights(projectPath: string): Promise<void> {
  await store.delete(keyOf(projectPath));
  await store.save();
}
