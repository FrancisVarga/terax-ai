/**
 * github-create-issue worker — runs in the Bun runtime (NOT the webview).
 *
 * Terax's Rust backend spawns this script with `bun` on app start. It connects
 * to the embedded bunqueue server over TCP (127.0.0.1:7889) and processes
 * `github-create-issue` jobs by shelling out to the GitHub CLI.
 *
 * Auth: `gh` uses its own stored credentials (`gh auth login` / GH_TOKEN), so
 * this worker never handles tokens itself. SECURITY: because gh runs with the
 * user's ambient credentials, a job can create an issue in ANY repo that token
 * can reach (confused-deputy). The enqueue path is the trust boundary — only
 * code that already runs with the user's authority (the Tauri backend / the
 * webview it controls) should be able to enqueue `github-create-issue` jobs,
 * and the `repo`/`cwd` it passes should be constrained to the active workspace.
 * This worker additionally redacts any token-shaped strings from gh/git output
 * before they land in a job result or log (see redactSecrets).
 *
 * Job payload (see CreateIssuePayload). The processor's return value is stored
 * as the job result; throwing routes the job to retry/DLQ per server policy.
 *
 * Run standalone for debugging:
 *   bun src/modules/bunqueue/workers/githubCreateIssue.ts
 *
 * Env overrides: BUNQUEUE_HOST, BUNQUEUE_TCP_PORT.
 */

import { Worker, type Job } from "bunqueue/client";

const QUEUE = "github-create-issue";
const HOST = process.env.BUNQUEUE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BUNQUEUE_TCP_PORT ?? 7889);

export type CreateIssuePayload = {
  /**
   * "owner/name". Optional — when omitted, the worker derives it from the
   * git remote (`origin`) of `cwd`.
   */
  repo?: string;
  /**
   * Working directory of the target repo (the active workspace folder). Used
   * to resolve the repo from `git remote -v` and as gh's cwd. Required when
   * `repo` is not given.
   */
  cwd?: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  /** Optional milestone title or number. */
  milestone?: string;
};

export type CreateIssueResult = {
  url: string;
  number: number | null;
  /** The repo the issue was created in (resolved or explicit). */
  repo: string;
};

/** Validate and normalize a raw job payload. Throws on bad input. */
function validate(data: unknown): CreateIssuePayload {
  if (!data || typeof data !== "object") {
    throw new Error("payload must be an object");
  }
  const d = data as Record<string, unknown>;
  const title = d.title;
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error("title is required");
  }
  const repo = typeof d.repo === "string" ? d.repo : undefined;
  if (repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`invalid repo (expected "owner/name"): ${repo}`);
  }
  const cwd = typeof d.cwd === "string" && d.cwd.trim() !== "" ? d.cwd : undefined;
  if (!repo && !cwd) {
    throw new Error("either repo or cwd is required");
  }
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  return {
    repo,
    cwd,
    title,
    body: typeof d.body === "string" ? d.body : undefined,
    labels: strArray(d.labels),
    assignees: strArray(d.assignees),
    milestone: typeof d.milestone === "string" ? d.milestone : undefined,
  };
}

/**
 * Strip anything that looks like a credential from gh/git output before it
 * reaches a job result or log. `gh`/`git` can echo token-tagged remote URLs
 * (https://x-access-token:<TOKEN>@github.com/...) or `GH_TOKEN=...` on failure;
 * those must never be persisted as a job error.
 */
function redactSecrets(text: string): string {
  return text
    // userinfo in URLs: scheme://user:secret@host  ->  scheme://***@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+(@)/gi, "$1***$2")
    // bare github/gh tokens
    .replace(/\bgh[opsu]_[A-Za-z0-9]{20,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***")
    // KEY=secret style env leaks for token-ish keys
    .replace(/\b([A-Z_]*TOKEN|GH_TOKEN|GITHUB_TOKEN)=\S+/g, "$1=***");
}

/** Run a command in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
async function run(
  cmd: string[],
  cwd?: string,
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = redactSecrets(stderr.trim() || stdout.trim());
    throw new Error(`${cmd[0]} failed (exit ${exitCode}): ${detail}`);
  }
  return stdout.trim();
}

/** Extract "owner/name" from any GitHub remote URL form (ssh, https, git). */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  // git@github.com:owner/name(.git)  |  ssh://git@github.com/owner/name
  // https://github.com/owner/name(.git)  |  github.com/owner/name
  const m = url.match(
    /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i,
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Resolve the GitHub repo from the git remote of `cwd`. */
async function resolveRepoFromCwd(cwd: string): Promise<string> {
  // Prefer origin; fall back to the first remote if origin is absent.
  let remote: string;
  try {
    remote = await run(["git", "-C", cwd, "remote", "get-url", "origin"], cwd);
  } catch {
    const all = await run(["git", "-C", cwd, "remote", "-v"], cwd);
    const first = all.split("\n").find((l) => l.includes("github.com"));
    remote = first ? first.split(/\s+/)[1] ?? "" : "";
  }
  const repo = parseGitHubRepo(remote);
  if (!repo) {
    throw new Error(`could not resolve GitHub repo from remote: ${remote || "(none)"}`);
  }
  return repo;
}

/** Build the `gh issue create` argument vector for an explicit repo. */
function buildArgs(p: CreateIssuePayload, repo: string): string[] {
  const args = ["issue", "create", "-R", repo, "-t", p.title];
  // gh requires a body; pass empty string rather than opening an editor.
  args.push("-b", p.body ?? "");
  for (const label of p.labels ?? []) args.push("-l", label);
  for (const assignee of p.assignees ?? []) args.push("-a", assignee);
  if (p.milestone) args.push("-m", p.milestone);
  return args;
}

/** Parse the issue URL gh prints on success, and the trailing issue number. */
function parseResult(stdout: string, repo: string): CreateIssueResult {
  const url = stdout.trim().split(/\s+/).pop() ?? "";
  const m = url.match(/\/issues\/(\d+)\s*$/);
  return { url, number: m ? Number(m[1]) : null, repo };
}

export async function createIssue(
  payload: CreateIssuePayload,
): Promise<CreateIssueResult> {
  // Resolve repo: explicit wins, else derive from cwd's git remote.
  const repo =
    payload.repo ?? (await resolveRepoFromCwd(payload.cwd as string));

  // Run gh in cwd when given so its own repo inference / auth context matches.
  const stdout = await run(["gh", ...buildArgs(payload, repo)], payload.cwd);
  return parseResult(stdout, repo);
}

const processor = async (job: Job): Promise<CreateIssueResult> => {
  const payload = validate(job.data);
  return createIssue(payload);
};

// Skip auto-start when imported (e.g. in unit tests). `import.meta.main` is
// true only when this file is the entry point Bun executed.
if (import.meta.main) {
  const worker = new Worker(QUEUE, processor, {
    connection: { host: HOST, port: PORT },
  });

  worker.on("ready", () =>
    console.log(`[${QUEUE}] worker ready → ${HOST}:${PORT}`),
  );
  worker.on("completed", (job: Job, result: unknown) =>
    console.log(`[${QUEUE}] #${job.id} created`, result),
  );
  worker.on("failed", (job: Job | undefined, err: Error) =>
    console.error(`[${QUEUE}] #${job?.id ?? "?"} failed: ${err.message}`),
  );
  worker.on("error", (err: Error) =>
    console.error(`[${QUEUE}] worker error: ${err.message}`),
  );

  const shutdown = async () => {
    console.log(`[${QUEUE}] shutting down`);
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
