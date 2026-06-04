import { useEffect, useState } from "react";
import {
  loadCommits,
  loadRepo,
  loadRepoSummary,
  type Loadable,
  type RepoSummary,
} from "./projectInsights";
import { readInsights, writeInsights } from "./insightsCache";

/**
 * The compact signal set a dashboard card shows. Deliberately a strict subset
 * of {@link ProjectInsights}: a card only needs the headline numbers (branch,
 * dirty/ahead/behind, stars, open issues, last commit time), not the full
 * commit list / README / runs the detail page renders.
 */
export type ProjectCardInsights = {
  /** Git summary: repo root, branch, dirty/ahead/behind. Local, always tried. */
  summary: Loadable<RepoSummary>;
  /** GitHub star/issue counts. Only when the remote is a GitHub repo. */
  stars: number | null;
  openIssues: number | null;
  /** Most recent commit: subject/time + churn, for a "last active" line.
   *  Churn is optional — entries cached before it was tracked omit it. */
  lastCommit: {
    subject: string;
    atMs: number;
    insertions?: number;
    deletions?: number;
  } | null;
};

const LOADING = { kind: "loading" } as const;

const INITIAL: ProjectCardInsights = {
  summary: LOADING,
  stars: null,
  openIssues: null,
  lastCommit: null,
};

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Lazy, lightweight cousin of {@link useProjectInsights} for dashboard cards.
 *
 * Nothing is fetched until `enabled` flips true — the dashboard wires this to
 * an IntersectionObserver so a large grid only spawns `git`/`gh` for the cards
 * actually on screen. Each source resolves independently, so the (offline,
 * always-available) git summary shows even when `gh` is missing or the remote
 * isn't GitHub.
 */
export function useProjectCardInsights(
  projectPath: string,
  enabled: boolean,
): ProjectCardInsights {
  const [insights, setInsights] = useState<ProjectCardInsights>(INITIAL);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setInsights(INITIAL);

    const patch = (p: Partial<ProjectCardInsights>) => {
      if (!cancelled) setInsights((curr) => ({ ...curr, ...p }));
    };

    // Accumulates the resolved card payload so we can persist it once the live
    // pass settles. Seeded from cache, overwritten by fresh values.
    const fresh: {
      summary?: RepoSummary;
      stars: number | null;
      openIssues: number | null;
      lastCommit: ProjectCardInsights["lastCommit"];
    } = { stars: null, openIssues: null, lastCommit: null };

    void (async () => {
      // 1. Stale-while-revalidate: paint last-known values immediately so a
      //    scrolling grid never flashes a loading spinner per card.
      const cached = await readInsights(projectPath).catch(() => null);
      if (cancelled) return;
      const card = cached?.data.card;
      if (card) {
        fresh.summary = card.summary;
        fresh.stars = card.stars;
        fresh.openIssues = card.openIssues;
        fresh.lastCommit = card.lastCommit;
        patch({
          summary: card.summary
            ? { kind: "ready", data: card.summary }
            : LOADING,
          stars: card.stars,
          openIssues: card.openIssues,
          lastCommit: card.lastCommit,
        });
      }
      // A present-and-fresh cache needs no subprocess spawn at all.
      if (cached && !cached.stale && card?.summary) return;

      // 2. Revalidate against live git/gh.
      let summary: RepoSummary | null;
      try {
        summary = await loadRepoSummary(projectPath);
      } catch (e) {
        if (cancelled) return;
        if (!card) patch({ summary: { kind: "unavailable", reason: reasonOf(e) } });
        return;
      }
      if (cancelled) return;

      if (!summary) {
        if (!card)
          patch({ summary: { kind: "unavailable", reason: "Not a git repo." } });
        return;
      }
      fresh.summary = summary;
      patch({ summary: { kind: "ready", data: summary } });

      const persist = () => {
        void writeInsights(projectPath, {
          card: {
            summary: fresh.summary,
            stars: fresh.stars,
            openIssues: fresh.openIssues,
            lastCommit: fresh.lastCommit,
          },
        });
      };

      // Most recent commit — local, cheap (limit 1).
      const commitsDone = loadCommits(summary.repoRoot, 1)
        .then((list) => {
          const c = list[0];
          if (c) {
            fresh.lastCommit = {
              subject: c.subject,
              atMs: c.timestampSecs * 1000,
              insertions: c.insertions,
              deletions: c.deletions,
            };
            patch({ lastCommit: fresh.lastCommit });
          }
        })
        .catch(() => {
          /* leave lastCommit as-is */
        });

      // GitHub headline numbers — only for GitHub remotes.
      const gh = summary.remote?.host === "github" ? summary.remote : null;
      const ghDone = gh
        ? loadRepo(summary.repoRoot, `${gh.owner}/${gh.repo}`)
            .then((r) => {
              fresh.stars = r.stargazerCount ?? null;
              fresh.openIssues = r.issues?.totalCount ?? null;
              patch({ stars: fresh.stars, openIssues: fresh.openIssues });
            })
            .catch(() => {
              /* leave GitHub numbers as-is */
            })
        : Promise.resolve();

      // Persist once both background sources settle, so the cached card holds
      // a complete, consistent snapshot rather than a half-filled one.
      void Promise.all([commitsDone, ghDone]).then(() => {
        if (!cancelled) persist();
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath, enabled]);

  return insights;
}
