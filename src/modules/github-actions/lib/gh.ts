/**
 * Thin wrappers over the GitHub CLI (`gh`), run through the same local shell
 * backend the task runner uses. We deliberately drive `gh` *subcommands* rather
 * than the REST API: `gh` already resolves the repo from the cwd and injects
 * the stored auth token itself, so the token never passes through our JS and
 * "get the repo + token from the current pwd" is handled by gh's own context.
 */

import { native } from "@/modules/ai/lib/native";

/** A workflow run's lifecycle state from `gh run list`. */
export type RunStatus =
  | "queued"
  | "in_progress"
  | "requested"
  | "waiting"
  | "pending"
  | "completed";

/** Terminal outcome once `status === "completed"`. */
export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | null;

export type WorkflowDef = {
  /** Numeric workflow id (stable across renames). */
  id: number;
  name: string;
  /** Workflow file path, e.g. ".github/workflows/ci.yml". */
  path: string;
  state: string;
};

export type WorkflowRun = {
  databaseId: number;
  status: RunStatus;
  conclusion: RunConclusion;
  displayTitle: string;
  workflowName: string;
  headBranch: string;
  createdAt: string;
  url: string;
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

/** List active workflows defined in the repo. */
export function listWorkflows(cwd: string): Promise<WorkflowDef[]> {
  return ghJson<WorkflowDef[]>(
    "workflow list --json id,name,path,state --limit 100",
    cwd,
  );
}

/** The most recent runs for the repo (any workflow), newest first. */
export function listRuns(cwd: string, limit = 30): Promise<WorkflowRun[]> {
  return ghJson<WorkflowRun[]>(
    `run list --limit ${limit} --json databaseId,status,conclusion,displayTitle,workflowName,headBranch,createdAt,url`,
    cwd,
  );
}

/** A single run by id — used for polling one run to completion. */
export function getRun(cwd: string, id: number): Promise<WorkflowRun> {
  return ghJson<WorkflowRun>(
    `run view ${id} --json databaseId,status,conclusion,displayTitle,workflowName,headBranch,createdAt,url`,
    cwd,
  );
}

/**
 * Dispatch a workflow on `ref`. `gh` does not return the new run id (GitHub
 * assigns it asynchronously), so callers snapshot the latest run id beforehand
 * and poll {@link listRuns} for a newer one. Throws on dispatch failure.
 */
export async function runWorkflow(
  cwd: string,
  workflowFileOrId: string,
  ref?: string,
): Promise<void> {
  const refArg = ref ? ` --ref ${shellQuote(ref)}` : "";
  const res = await native.runCommand(
    `gh workflow run ${shellQuote(workflowFileOrId)}${refArg}`,
    cwd,
    30,
  );
  if (res.exit_code !== 0) {
    throw new GhError((res.stderr || res.stdout || "dispatch failed").trim());
  }
}

/** Minimal POSIX single-quote escaping for an interpolated argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
