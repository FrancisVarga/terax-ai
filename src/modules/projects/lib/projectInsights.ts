import { native, type GitLogEntry } from "@/modules/ai/lib/native";
import { parseRemoteWebUrl, type RemoteWebInfo } from "@/modules/git-history/lib/remoteWebUrl";

/** README candidate filenames, in preference order. */
const README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.markdown",
  "README",
];

export type RepoSummary = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  remoteUrl: string | null;
  remote: RemoteWebInfo | null;
};

/** Subset of `gh repo view --json` we surface. All fields optional/defensive. */
export type GitHubRepo = {
  nameWithOwner?: string;
  description?: string | null;
  url?: string;
  homepageUrl?: string | null;
  primaryLanguage?: { name?: string } | null;
  stargazerCount?: number;
  forkCount?: number;
  watchers?: { totalCount?: number } | null;
  issues?: { totalCount?: number } | null;
  pullRequests?: { totalCount?: number } | null;
  defaultBranchRef?: { name?: string } | null;
  isPrivate?: boolean;
  isArchived?: boolean;
  licenseInfo?: { name?: string } | null;
  pushedAt?: string;
  updatedAt?: string;
  visibility?: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  author?: { login?: string } | null;
  labels?: { name: string; color?: string }[];
  comments?: number;
};

export type GitHubRun = {
  databaseId?: number;
  name?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  workflowName?: string;
  headBranch?: string;
  event?: string;
  createdAt?: string;
  url?: string;
};

/** Per-source async state so one failure never blanks the whole page. */
export type Loadable<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "unavailable"; reason: string };

export type ProjectInsights = {
  summary: Loadable<RepoSummary>;
  commits: Loadable<GitLogEntry[]>;
  readme: Loadable<{ content: string }>;
  repo: Loadable<GitHubRepo>;
  issues: Loadable<GitHubIssue[]>;
  runs: Loadable<GitHubRun[]>;
};

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

/**
 * Validate an `owner/name` slug before it is interpolated into a shell command.
 *
 * `ownerRepo` is derived from the repo's git remote URL, which is
 * attacker-controllable (e.g. a malicious `.git/config`). `runCommand` runs
 * through a shell, so an unvalidated slug like `foo;rm -rf ~` would be command
 * injection. GitHub owner/repo names are restricted to `[A-Za-z0-9._-]`; we
 * additionally reject a leading `-` so the value can't be parsed as a gh flag.
 */
function assertSafeOwnerRepo(ownerRepo: string): void {
  const parts = ownerRepo.split("/");
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (parts.length !== 2 || !parts.every((p) => segment.test(p))) {
    throw new Error(`unsafe repo slug: ${ownerRepo}`);
  }
}

/**
 * Run a `gh` command in `cwd`, returning parsed JSON or throwing a reason.
 *
 * `runCommand` only accepts a shell command string (no argv form), so every
 * interpolated value must be either a hardcoded constant or pre-validated.
 * Callers pass `ownerRepo` through {@link assertSafeOwnerRepo}; `limit` is an
 * internal integer and `fields` is a fixed allowlist.
 */
async function gh<T>(args: string, cwd: string): Promise<T> {
  const out = await native.runCommand(`gh ${args}`, cwd, 30);
  if (out.exit_code !== 0) {
    const msg = (out.stderr || out.stdout || "").trim();
    // gh prints a recognizable hint when unauthenticated / not installed.
    throw new Error(msg || `gh exited ${out.exit_code}`);
  }
  return parseJson<T>(out.stdout);
}

/**
 * Resolve git repo + status for a project path. Returns null if the path is not
 * a git repo (the detail page then shows a non-repo state).
 */
export async function loadRepoSummary(
  path: string,
): Promise<RepoSummary | null> {
  try {
    await native.workspaceAuthorize(path);
  } catch {
    // Non-fatal — git/gh calls below will surface authorization failures.
  }
  const repo = await native.gitResolveRepo(path);
  if (!repo) return null;
  const [status, remoteUrl] = await Promise.all([
    native.gitStatus(repo.repoRoot).catch(() => null),
    native.gitRemoteUrl(repo.repoRoot).catch(() => null),
  ]);
  return {
    repoRoot: repo.repoRoot,
    branch: repo.branch,
    upstream: repo.upstream,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    changedCount: status?.changedFiles.length ?? 0,
    remoteUrl: remoteUrl ?? null,
    remote: parseRemoteWebUrl(remoteUrl),
  };
}

export async function loadCommits(
  repoRoot: string,
  limit = 12,
): Promise<GitLogEntry[]> {
  return native.gitLog(repoRoot, { limit });
}

/** Read the first README found at the repo root. Throws if none. */
export async function loadReadme(repoRoot: string): Promise<string> {
  const root = repoRoot.replace(/[\\/]+$/, "");
  for (const name of README_NAMES) {
    try {
      const res = await native.readFile(`${root}/${name}`);
      if (res.kind === "text") return res.content;
    } catch {
      // try next candidate
    }
  }
  throw new Error("No README found");
}

export async function loadRepo(
  repoRoot: string,
  ownerRepo: string,
): Promise<GitHubRepo> {
  assertSafeOwnerRepo(ownerRepo);
  const fields = [
    "nameWithOwner",
    "description",
    "url",
    "homepageUrl",
    "primaryLanguage",
    "stargazerCount",
    "forkCount",
    "watchers",
    "issues",
    "pullRequests",
    "defaultBranchRef",
    "isPrivate",
    "isArchived",
    "licenseInfo",
    "pushedAt",
    "updatedAt",
    "visibility",
  ].join(",");
  return gh<GitHubRepo>(`repo view ${ownerRepo} --json ${fields}`, repoRoot);
}

export async function loadIssues(
  repoRoot: string,
  ownerRepo: string,
  limit = 10,
): Promise<GitHubIssue[]> {
  assertSafeOwnerRepo(ownerRepo);
  const n = Math.max(1, Math.floor(limit));
  const fields = "number,title,state,url,createdAt,author,labels,comments";
  return gh<GitHubIssue[]>(
    `issue list -R ${ownerRepo} --state open --limit ${n} --json ${fields}`,
    repoRoot,
  );
}

export async function loadRuns(
  repoRoot: string,
  ownerRepo: string,
  limit = 10,
): Promise<GitHubRun[]> {
  assertSafeOwnerRepo(ownerRepo);
  const n = Math.max(1, Math.floor(limit));
  const fields =
    "databaseId,name,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url";
  return gh<GitHubRun[]>(
    `run list -R ${ownerRepo} --limit ${n} --json ${fields}`,
    repoRoot,
  );
}
