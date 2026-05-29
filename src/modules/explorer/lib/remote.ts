import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { DirEntry } from "./useFileTree";

/**
 * Remote (SSH/SFTP) roots are encoded as `ssh://<alias>/<absolute/path>` so the
 * explorer's path-keyed tree state can treat them like any other path string.
 * The alias is the `~/.ssh/config` Host; the path after it is the absolute
 * remote path (always `/`-separated).
 */
const SSH_PREFIX = "ssh://";

export function isRemote(path: string): boolean {
  return path.startsWith(SSH_PREFIX);
}

export type RemoteRef = { alias: string; path: string };

/** Parse `ssh://alias/abs/path` → { alias, path }. Path is always absolute. */
export function parseRemote(uri: string): RemoteRef | null {
  if (!isRemote(uri)) return null;
  const rest = uri.slice(SSH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { alias: rest, path: "/" };
  const alias = rest.slice(0, slash);
  const path = rest.slice(slash) || "/";
  return { alias, path };
}

/** Build a remote URI from an alias + absolute remote path. Strips a trailing
 * slash (except root) so the URI is byte-stable regardless of whether it came
 * from `canonicalize` (no slash) or a shell hook (`$PWD` may carry one). A
 * stable URI is essential: it is the `nodes`-map key the tree reads back, so a
 * trailing-slash variant would write entries under a key `buildRows` never
 * walks — the new file would only surface after a remount. */
export function remoteUri(alias: string, path: string): string {
  let abs = path.startsWith("/") ? path : `/${path}`;
  if (abs.length > 1 && abs.endsWith("/")) abs = abs.replace(/\/+$/, "");
  return `${SSH_PREFIX}${alias}${abs}`;
}

type RemoteEntry = {
  name: string;
  kind: string;
  size: number;
  mtime: number;
};

/**
 * Read a directory, routing remote (`ssh://`) paths to the SFTP backend and
 * local paths to the normal `fs_read_dir`. Returns the same `DirEntry[]` shape
 * either way so the tree renderer is agnostic to the source.
 */
export async function readDir(
  path: string,
  showHidden: boolean,
): Promise<DirEntry[]> {
  const ref = parseRemote(path);
  if (ref) {
    const entries = await invoke<RemoteEntry[]>("ssh_fs_read_dir", {
      alias: ref.alias,
      path: ref.path,
      showHidden,
    });
    return entries.map((e) => ({
      name: e.name,
      kind: e.kind as DirEntry["kind"],
      size: e.size,
      mtime: e.mtime,
      ignored: false, // remote roots have no gitignore evaluation
    }));
  }
  return invoke<DirEntry[]>("fs_read_dir", {
    path,
    showHidden,
    workspace: currentWorkspaceEnv(),
  });
}

/**
 * Walk a remote tree (server-side `find` over SSH) for files whose basename is
 * in `names`, pruning node_modules / .git. Returns absolute remote paths
 * (`/`-separated). Used by the task-runner scan to discover manifests +
 * lockfiles on the remote host. `path` is the absolute remote root.
 */
export async function remoteGlob(
  alias: string,
  path: string,
  names: string[],
): Promise<string[]> {
  return invoke<string[]>("ssh_fs_glob", { alias, root: path, names });
}

/** Read a single remote file's text content over SFTP. */
export async function readRemoteFile(
  alias: string,
  path: string,
): Promise<string> {
  return invoke<string>("ssh_fs_read_file", { alias, path });
}

/** Write text content to a remote file over SFTP (create or overwrite). */
export async function writeRemoteFile(
  alias: string,
  path: string,
  content: string,
): Promise<void> {
  await invoke("ssh_fs_write_file", { alias, path, content });
}

/** Create an empty remote file. Fails if it already exists. */
export async function createRemoteFile(
  alias: string,
  path: string,
): Promise<void> {
  await invoke("ssh_fs_create_file", { alias, path });
}

/** Create a remote directory. Fails if it already exists. */
export async function createRemoteDir(
  alias: string,
  path: string,
): Promise<void> {
  await invoke("ssh_fs_create_dir", { alias, path });
}

/** Rename/move a remote path. Refuses to overwrite an existing target. */
export async function renameRemote(
  alias: string,
  from: string,
  to: string,
): Promise<void> {
  await invoke("ssh_fs_rename", { alias, from, to });
}

/** Copy a remote path (recursive for dirs). Refuses to overwrite a target. */
export async function copyRemote(
  alias: string,
  from: string,
  to: string,
): Promise<void> {
  await invoke("ssh_fs_copy", { alias, from, to });
}

/** Delete a remote file or directory (recursive for dirs). */
export async function deleteRemote(alias: string, path: string): Promise<void> {
  await invoke("ssh_fs_delete", { alias, path });
}

/** Connect (or reuse) an SFTP session; resolves the remote home dir. */
export async function connectRemote(alias: string): Promise<string> {
  return invoke<string>("ssh_fs_connect", { alias });
}

export async function disconnectRemote(alias: string): Promise<void> {
  await invoke("ssh_fs_disconnect", { alias });
}
