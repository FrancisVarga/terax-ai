import { useCallback, useEffect, useState } from "react";
import {
  loadCommits,
  loadIssues,
  loadReadme,
  loadRepo,
  loadRepoSummary,
  loadRuns,
  type Loadable,
  type ProjectInsights,
  type RepoSummary,
} from "./projectInsights";

const LOADING = { kind: "loading" } as const;

const INITIAL: ProjectInsights = {
  summary: LOADING,
  commits: LOADING,
  readme: LOADING,
  repo: LOADING,
  issues: LOADING,
  runs: LOADING,
};

function unavailable(reason: string): Loadable<never> {
  return { kind: "unavailable", reason };
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Loads everything a project detail page shows: git summary + commits + README
 * (local), plus GitHub repo / issues / workflow runs (via the `gh` CLI). Each
 * source has independent {@link Loadable} state so a single failure (e.g. gh
 * not installed, or a non-GitHub remote) only blanks its own panel.
 *
 * The git summary loads first because the repo root + remote it resolves are
 * the inputs the other loaders need.
 */
export function useProjectInsights(projectPath: string): {
  insights: ProjectInsights;
  isRepo: boolean | null;
  reload: () => void;
} {
  const [insights, setInsights] = useState<ProjectInsights>(INITIAL);
  // null = unknown (still resolving); false = path is not a git repo.
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setInsights(INITIAL);
    setIsRepo(null);

    const patch = (p: Partial<ProjectInsights>) => {
      if (!cancelled) setInsights((curr) => ({ ...curr, ...p }));
    };

    void (async () => {
      let summary: RepoSummary | null;
      try {
        summary = await loadRepoSummary(projectPath);
      } catch (e) {
        if (cancelled) return;
        setIsRepo(false);
        patch({
          summary: unavailable(reasonOf(e)),
          commits: unavailable("Not a git repository."),
          readme: unavailable("Not a git repository."),
          repo: unavailable("Not a git repository."),
          issues: unavailable("Not a git repository."),
          runs: unavailable("Not a git repository."),
        });
        return;
      }
      if (cancelled) return;

      if (!summary) {
        setIsRepo(false);
        const reason = "This folder is not a git repository.";
        patch({
          summary: unavailable(reason),
          commits: unavailable(reason),
          readme: unavailable(reason),
          repo: unavailable("No git remote."),
          issues: unavailable("No git remote."),
          runs: unavailable("No git remote."),
        });
        return;
      }

      setIsRepo(true);
      patch({ summary: { kind: "ready", data: summary } });

      // Local git + filesystem sources — always attempted.
      void loadCommits(summary.repoRoot)
        .then((data) => patch({ commits: { kind: "ready", data } }))
        .catch((e) => patch({ commits: unavailable(reasonOf(e)) }));

      void loadReadme(summary.repoRoot)
        .then((content) => patch({ readme: { kind: "ready", data: { content } } }))
        .catch((e) => patch({ readme: unavailable(reasonOf(e)) }));

      // GitHub sources — only when the remote is a GitHub repo.
      const gh = summary.remote?.host === "github" ? summary.remote : null;
      if (!gh) {
        const reason = "No GitHub remote detected.";
        patch({
          repo: unavailable(reason),
          issues: unavailable(reason),
          runs: unavailable(reason),
        });
        return;
      }
      const ownerRepo = `${gh.owner}/${gh.repo}`;

      void loadRepo(summary.repoRoot, ownerRepo)
        .then((data) => patch({ repo: { kind: "ready", data } }))
        .catch((e) => patch({ repo: unavailable(reasonOf(e)) }));

      void loadIssues(summary.repoRoot, ownerRepo)
        .then((data) => patch({ issues: { kind: "ready", data } }))
        .catch((e) => patch({ issues: unavailable(reasonOf(e)) }));

      void loadRuns(summary.repoRoot, ownerRepo)
        .then((data) => patch({ runs: { kind: "ready", data } }))
        .catch((e) => patch({ runs: unavailable(reasonOf(e)) }));
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath, nonce]);

  return { insights, isRepo, reload };
}
