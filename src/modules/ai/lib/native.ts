import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { parseRemote, remoteUri } from "@/modules/explorer/lib/remote";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

export type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  writeFile: (path: string, content: string) =>
    invoke<void>("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
    }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", { path, workspace: currentWorkspaceEnv() }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", { path, workspace: currentWorkspaceEnv() }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: (path: string) =>
    invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: false,
      workspace: currentWorkspaceEnv(),
    }),
  grep: (params: {
    pattern: string;
    root: string;
    glob?: string[];
    caseInsensitive?: boolean;
    maxResults?: number;
  }) => {
    const ref = parseRemote(params.root);
    if (ref) {
      // Remote grep runs `rg`/`grep` over SSH exec; the `glob` filter has no
      // remote equivalent yet, so it is ignored on the remote path.
      return invoke<GrepResponse>("ssh_fs_grep", {
        alias: ref.alias,
        pattern: params.pattern,
        root: ref.path,
        caseInsensitive: params.caseInsensitive ?? null,
        maxResults: params.maxResults ?? null,
      });
    }
    return invoke<GrepResponse>("fs_grep", {
      pattern: params.pattern,
      root: params.root,
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    });
  },
  glob: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("fs_glob", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  /**
   * Like {@link glob} but driven by the bundled ripgrep sidecar in an async
   * backend command (off the IPC thread), so a deep-tree scan can't hang the
   * UI. Same ignore semantics (node_modules / .gitignore pruned).
   */
  globRg: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("fs_glob_rg", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  runCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),

  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellBgSpawn: (command: string, cwd?: string | null) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  // Remote (SSH) background tasks. Same poll/kill shape as the local shellBg*
  // commands so the task-runner store can route by alias without special-casing
  // the log/kill loop. `cwd` is an absolute remote path.
  sshBgSpawn: (alias: string, command: string, cwd?: string | null) =>
    invoke<number>("ssh_bg_spawn", { alias, command, cwd: cwd ?? null }),
  sshBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("ssh_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  sshBgKill: (handle: number) => invoke<void>("ssh_bg_kill", { handle }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
  // Git routing: a `ssh://alias/path` repoRoot/cwd dispatches to the remote
  // `ssh_git_*` commands (git run over the SSH exec channel). The remote
  // backend returns a bare POSIX repoRoot, which we re-wrap as `ssh://alias/...`
  // so the next call (gitStatus, gitDiff, …) stays on the remote path. Local
  // paths keep the `workspace`-scoped local git commands unchanged.
  gitResolveRepo: async (cwd: string): Promise<GitRepoInfo | null> => {
    const ref = parseRemote(cwd);
    if (ref) {
      const info = await invoke<GitRepoInfo | null>("ssh_git_resolve_repo", {
        alias: ref.alias,
        cwd: ref.path,
      });
      return info
        ? { ...info, repoRoot: remoteUri(ref.alias, info.repoRoot) }
        : null;
    }
    return invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitPanelSnapshot: async (cwd: string): Promise<GitPanelSnapshot> => {
    const ref = parseRemote(cwd);
    if (ref) {
      const snap = await invoke<GitPanelSnapshot>("ssh_git_panel_snapshot", {
        alias: ref.alias,
        cwd: ref.path,
      });
      const wrap = (root: string) => remoteUri(ref.alias, root);
      return {
        repo: snap.repo
          ? { ...snap.repo, repoRoot: wrap(snap.repo.repoRoot) }
          : null,
        status: snap.status
          ? { ...snap.status, repoRoot: wrap(snap.status.repoRoot) }
          : null,
      };
    }
    return invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitStatus: async (repoRoot: string): Promise<GitStatusSnapshot> => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      const s = await invoke<GitStatusSnapshot>("ssh_git_status", {
        alias: ref.alias,
        repoRoot: ref.path,
      });
      return { ...s, repoRoot: remoteUri(ref.alias, s.repoRoot) };
    }
    return invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitDiff: (repoRoot: string, path: string | null, staged: boolean) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<GitDiffResult>("ssh_git_diff", {
        alias: ref.alias,
        repoRoot: ref.path,
        path,
        staged,
      });
    }
    return invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
  ) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<GitDiffContentResult>("ssh_git_diff_content", {
        alias: ref.alias,
        repoRoot: ref.path,
        path,
        staged,
        originalPath: originalPath ?? null,
      });
    }
    return invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitStage: (repoRoot: string, paths: string[]) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<void>("ssh_git_stage", {
        alias: ref.alias,
        repoRoot: ref.path,
        paths,
      });
    }
    return invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitUnstage: (repoRoot: string, paths: string[]) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<void>("ssh_git_unstage", {
        alias: ref.alias,
        repoRoot: ref.path,
        paths,
      });
    }
    return invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      // The remote command splits tracked vs untracked into two arg lists.
      return invoke<void>("ssh_git_discard", {
        alias: ref.alias,
        repoRoot: ref.path,
        tracked: entries.filter((e) => !e.untracked).map((e) => e.path),
        untracked: entries.filter((e) => e.untracked).map((e) => e.path),
      });
    }
    return invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitCommit: (repoRoot: string, message: string) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<GitCommitResult>("ssh_git_commit", {
        alias: ref.alias,
        repoRoot: ref.path,
        message,
      });
    }
    return invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLog: (
    repoRoot: string,
    options?: { limit?: number; beforeSha?: string },
  ) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<GitLogEntry[]>("ssh_git_log", {
        alias: ref.alias,
        repoRoot: ref.path,
        limit: options?.limit ?? 100,
        beforeSha: options?.beforeSha ?? null,
      });
    }
    return invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitShowCommit: (repoRoot: string, sha: string) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<GitDiffResult>("ssh_git_show_commit", {
        alias: ref.alias,
        repoRoot: ref.path,
        sha,
      });
    }
    return invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    });
  },
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) => {
    const ref = parseRemote(repoRoot);
    if (ref) {
      return invoke<string | null>("ssh_git_remote_url", {
        alias: ref.alias,
        repoRoot: ref.path,
        name: name ?? "origin",
      });
    }
    return invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: currentWorkspaceEnv(),
    });
  },
};
