/**
 * Thin wrappers over the GitHub CLI (`gh`) for repository issues, run through
 * the same local shell backend the task runner uses. As with the actions
 * module we drive `gh` *subcommands* rather than the REST API: `gh` resolves
 * the repo from the cwd and injects the stored auth token itself, so the token
 * never passes through our JS and "get the repo + token from the current pwd"
 * is handled by gh's own context.
 */

import { native } from "@/modules/ai/lib/native";

/** Open/closed lifecycle state of an issue from `gh issue list`. */
export type IssueState = "OPEN" | "CLOSED";

export type IssueLabel = {
  name: string;
  /** 6-char hex (no leading #), as GitHub returns it. */
  color: string;
};

export type Issue = {
  number: number;
  title: string;
  state: IssueState;
  /** Issue body (markdown). May be empty. */
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: IssueLabel[];
  author: string;
};

export type RepoInfo = { owner: string; name: string; nameWithOwner: string };

export class GhError extends Error {}

/**
 * Run a `gh` command in `cwd` and return parsed JSON of type T. Throws a
 * {@link GhError} carrying stderr on non-zero exit so the UI can show why
 * (not installed, not authenticated, cwd isn't a repo, …).
 */
async function ghJson<T>(args: string, cwd: string): Promise<T> {
  const res = await native.runCommand(`gh ${args}`, cwd, 30);
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

/** Resolve the GitHub repo for `cwd`. Throws if cwd isn't a gh-known repo. */
export async function resolveRepo(cwd: string): Promise<RepoInfo> {
  // `owner` comes back as an object { login }, the rest as strings.
  const raw = await ghJson<{
    owner: { login: string } | string;
    name: string;
    nameWithOwner: string;
  }>("repo view --json owner,name,nameWithOwner", cwd);
  return {
    owner: typeof raw.owner === "object" ? raw.owner.login : String(raw.owner),
    name: raw.name,
    nameWithOwner: raw.nameWithOwner,
  };
}

/** Shape of a label as `gh issue list --json labels` returns it. */
type RawLabel = { name: string; color: string };
/** Shape of an issue row from `gh issue list --json …`. */
type RawIssue = {
  number: number;
  title: string;
  state: string;
  body?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels?: RawLabel[];
  author?: { login: string } | null;
};

function normalizeIssue(r: RawIssue): Issue {
  return {
    number: r.number,
    title: r.title,
    // gh returns "OPEN"/"CLOSED"; guard against unexpected casing.
    state: r.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    body: r.body ?? "",
    url: r.url,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    labels: (r.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    author: r.author?.login ?? "",
  };
}

/**
 * List issues for the repo at `cwd`. `state` filters open/closed/all; newest
 * first (gh's default order). Pull requests are excluded by `gh issue list`.
 */
export async function listIssues(
  cwd: string,
  state: "open" | "closed" | "all" = "open",
  limit = 50,
): Promise<Issue[]> {
  const raw = await ghJson<RawIssue[]>(
    `issue list --state ${state} --limit ${limit} --json number,title,state,body,url,createdAt,updatedAt,labels,author`,
    cwd,
  );
  return raw.map(normalizeIssue);
}

/**
 * Create an issue with `title` and optional `body`. Returns the new issue's
 * number + url (parsed from the URL `gh issue create` prints on success).
 * Throws a {@link GhError} on failure (auth, no repo, validation).
 */
export async function createIssue(
  cwd: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string }> {
  // `gh issue create` prints the new issue URL to stdout, e.g.
  // https://github.com/owner/repo/issues/123 — parse the trailing number.
  const res = await native.runCommand(
    `gh issue create --title ${shellQuote(title)} --body ${shellQuote(body)}`,
    cwd,
    30,
  );
  if (res.exit_code !== 0) {
    throw new GhError((res.stderr || res.stdout || "issue create failed").trim());
  }
  const url = res.stdout.trim().split(/\s+/).pop() ?? "";
  const num = Number(url.match(/\/issues\/(\d+)\s*$/)?.[1] ?? 0);
  return { number: num, url };
}

/** Minimal POSIX single-quote escaping for an interpolated argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
