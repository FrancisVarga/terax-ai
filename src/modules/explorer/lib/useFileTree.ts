import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { listenFsChanged, watchAdd, watchRemove } from "./watch";
import {
  copyRemote,
  createRemoteDir,
  createRemoteFile,
  deleteRemote,
  isRemote,
  parseRemote,
  readDir,
  renameRemote,
} from "./remote";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  /** True when git would ignore this entry; the tree dims it. */
  ignored: boolean;
};

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Split a filename into stem + extension, where extension keeps its leading
 * dot (`a.tar.gz` → `["a.tar", ".gz"]`, `README` → `["README", ""]`). A
 * leading-dot dotfile with no other dot (`.env`) is all stem. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/** Pick a non-colliding name in `taken` by appending " copy" / " copy N",
 * inserted before the extension (`a.txt` → `a copy.txt`). Mirrors the macOS
 * Finder convention and sidesteps the Rust no-clobber guard, which errors
 * rather than auto-renaming. */
function freeCopyName(original: string, taken: Set<string>): string {
  const [stem, ext] = splitExt(original);
  let candidate = `${stem} copy${ext}`;
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; ; n++) {
    candidate = `${stem} copy ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const EXPANSION_CACHE_LIMIT = 8;
const expansionCache = new Map<string, string[]>();

function rememberExpansion(root: string, expanded: Set<string>): void {
  expansionCache.delete(root);
  if (expanded.size > 0) expansionCache.set(root, [...expanded]);
  while (expansionCache.size > EXPANSION_CACHE_LIMIT) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
}

function recallExpansion(root: string): string[] {
  const v = expansionCache.get(root);
  if (!v) return [];
  expansionCache.delete(root);
  expansionCache.set(root, v);
  return v;
}

function isUnder(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
};

export function useFileTree(rootPath: string | null, options?: Options) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const showHiddenRef = useRef(showHidden);
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  // The path most recently "Copy"d — the source for the next "Paste". Null when
  // the clipboard is empty. Paste resolves the destination at paste time.
  const [copySource, setCopySource] = useState<string | null>(null);

  const expandedRef = useRef(expanded);
  const nodesRef = useRef(nodes);
  const watchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    showHiddenRef.current = showHidden;
  }, [showHidden]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const addWatch = useCallback((path: string) => {
    if (isRemote(path)) return; // remote roots have no fs watcher
    if (watchedRef.current.has(path)) return;
    watchedRef.current.add(path);
    watchAdd([path]);
  }, []);

  const removeWatch = useCallback((path: string) => {
    if (!watchedRef.current.delete(path)) return;
    watchRemove([path]);
  }, []);

  const fetchChildren = useCallback(async (path: string) => {
    // Only show the "loading" placeholder when there's nothing cached to show.
    // Re-listing an already-loaded dir (root change into a visited path, manual
    // refresh, showHidden toggle) keeps the stale entries on screen until the
    // fresh listing lands, so the tree never flashes empty over an SFTP RTT.
    setNodes((s) =>
      s[path]?.status === "loaded" ? s : { ...s, [path]: { status: "loading" } },
    );
    try {
      const entries = await readDir(path, showHiddenRef.current);

      const liveDirs = new Set(
        entries.filter((e) => e.kind === "dir").map((e) => joinPath(path, e.name)),
      );
      const removedRoots: string[] = [];
      for (const key of Object.keys(nodesRef.current)) {
        if (dirname(key) === path && !liveDirs.has(key)) removedRoots.push(key);
      }
      const dead = new Set<string>();
      if (removedRoots.length > 0) {
        const candidates = new Set<string>([
          ...Object.keys(nodesRef.current),
          ...expandedRef.current,
          ...watchedRef.current,
        ]);
        for (const k of candidates) {
          if (removedRoots.some((r) => isUnder(k, r))) dead.add(k);
        }
      }

      setNodes((s) => {
        const next: TreeState = {};
        for (const [k, v] of Object.entries(s)) if (!dead.has(k)) next[k] = v;
        next[path] = { status: "loaded", entries };
        return next;
      });

      if (dead.size > 0) {
        setExpanded((c) => {
          let changed = false;
          const n = new Set(c);
          for (const d of dead) if (n.delete(d)) changed = true;
          return changed ? n : c;
        });
        const toUnwatch: string[] = [];
        for (const d of dead) if (watchedRef.current.delete(d)) toUnwatch.push(d);
        watchRemove(toUnwatch);
      }
    } catch (e) {
      setNodes((s) => ({
        ...s,
        [path]: { status: "error", message: String(e) },
      }));
    }
  }, []);

  // Root change → restore the cached expansion for this root, re-scope watches,
  // and persist the outgoing root's expansion on the way out.
  useEffect(() => {
    if (!rootPath) {
      setNodes({});
      setExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      return;
    }
    setPendingCreate(null);
    setRenaming(null);

    const restored = recallExpansion(rootPath);
    setExpanded(new Set(restored));

    // Don't blank the tree on a root change. Rows only ever walk *down* from
    // rootPath, so any node not under the new root is invisible regardless —
    // dropping it is pure memory hygiene, not a render concern. Keeping the
    // nodes that ARE under the new root means a `cd` into an already-listed
    // remote dir repaints instantly instead of flashing empty for a full SFTP
    // round-trip. fetchChildren still re-lists the new root to pick up changes.
    setNodes((s) => {
      let changed = false;
      const next: TreeState = {};
      for (const [k, v] of Object.entries(s)) {
        if (isUnder(k, rootPath)) next[k] = v;
        else changed = true;
      }
      return changed ? next : s;
    });

    // Remote (SFTP) roots have no filesystem watcher — skip watch registration
    // and rely on manual refresh. Local roots watch as before.
    const remote = isRemote(rootPath);
    const toWatch = remote ? [] : [rootPath, ...restored];
    void fetchChildren(rootPath);
    for (const d of restored) void fetchChildren(d);
    for (const p of toWatch) watchedRef.current.add(p);
    if (toWatch.length > 0) watchAdd(toWatch);

    return () => {
      rememberExpansion(rootPath, expandedRef.current);
      if (watchedRef.current.size > 0) {
        watchRemove([...watchedRef.current]);
        watchedRef.current.clear();
      }
    };
  }, [rootPath, fetchChildren]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const current = nodesRef.current;
      const dirs = new Set<string>();
      for (const p of paths) {
        const parent = dirname(p);
        if (current[parent]?.status === "loaded") dirs.add(parent);
        if (current[p]?.status === "loaded") dirs.add(p);
      }
      for (const d of dirs) void fetchChildren(d);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [fetchChildren]);

  useEffect(() => {
    if (!rootPath) return;
    const loadedPaths = Object.entries(nodes)
      .filter(([, state]) => state.status === "loaded")
      .map(([path]) => path);
    for (const path of loadedPaths) void fetchChildren(path);
    // Re-list loaded directories when the visibility preference changes.
    // `nodes` is intentionally omitted so ordinary tree edits don't refetch
    // every expanded directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden, rootPath, fetchChildren]);

  const toggle = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.delete(path);
          return next;
        });
        removeWatch(path);
      } else {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.add(path);
          return next;
        });
        addWatch(path);
        void fetchChildren(path);
      }
    },
    [fetchChildren, addWatch, removeWatch],
  );

  const expand = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) return;
      setExpanded((curr) => {
        const next = new Set(curr);
        next.add(path);
        return next;
      });
      addWatch(path);
      void fetchChildren(path);
    },
    [fetchChildren, addWatch],
  );

  const refresh = useCallback(
    (path: string) => {
      void fetchChildren(path);
    },
    [fetchChildren],
  );

  // --- mutations ---

  // Remote roots are mutable over SFTP. Mutation commands branch on the
  // `ssh://alias/path` URI: the alias + the decoded remote path go to the
  // `ssh_fs_*` commands, local paths to the `fs_*` commands. Tree node keys keep
  // the `ssh://` form, so `joinPath`/`dirname` operate on the URI and we
  // `parseRemote` only at the invoke boundary.
  const readOnly = false;

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      if (readOnly) return;
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      // Ensure the parent is expanded so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        setExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
        addWatch(parentPath);
      }
      setNodes((curr) => {
        if (!curr[parentPath]) void fetchChildren(parentPath);
        return curr;
      });
    },
    [rootPath, fetchChildren, addWatch, readOnly],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      const path = joinPath(pendingCreate.parentPath, trimmed);
      const kind = pendingCreate.kind;
      try {
        const ref = parseRemote(path);
        if (ref) {
          if (kind === "dir") await createRemoteDir(ref.alias, ref.path);
          else await createRemoteFile(ref.alias, ref.path);
        } else {
          const cmd = kind === "dir" ? "fs_create_dir" : "fs_create_file";
          await invoke(cmd, { path, workspace: currentWorkspaceEnv() });
        }
      } catch (e) {
        console.error(`create ${kind} failed:`, e);
      } finally {
        // Always re-list the parent, even if the create threw. Remote roots
        // have no fs watcher, so this fetch is the only thing that surfaces the
        // new entry; running it unconditionally also recovers the "name already
        // exists" case (the no-clobber guard rejects, but the tree was stale).
        await fetchChildren(pendingCreate.parentPath);
        setPendingCreate(null);
      }
    },
    [pendingCreate, fetchChildren],
  );

  const beginRename = useCallback(
    (path: string) => {
      if (readOnly) return;
      setPendingCreate(null);
      setRenaming(path);
    },
    [readOnly],
  );

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming) return;
      const trimmed = newName.trim();
      const parent = dirname(renaming);
      const oldName = renaming.slice(parent === "/" ? 1 : parent.length + 1);
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return;
      }
      const to = joinPath(parent, trimmed);
      try {
        const fromRef = parseRemote(renaming);
        const toRef = parseRemote(to);
        if (fromRef && toRef) {
          await renameRemote(fromRef.alias, fromRef.path, toRef.path);
        } else {
          await invoke("fs_rename", {
            from: renaming,
            to,
            workspace: currentWorkspaceEnv(),
          });
        }
        options?.onPathRenamed?.(renaming, to);
        await fetchChildren(parent);
      } catch (e) {
        console.error("rename failed:", e);
      } finally {
        setRenaming(null);
      }
    },
    [renaming, fetchChildren, options],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (readOnly) return;
      try {
        const ref = parseRemote(path);
        if (ref) {
          await deleteRemote(ref.alias, ref.path);
        } else {
          await invoke("fs_delete", { path, workspace: currentWorkspaceEnv() });
        }
        options?.onPathDeleted?.(path);
        await fetchChildren(dirname(path));
      } catch (e) {
        console.error("delete failed:", e);
      }
    },
    [fetchChildren, options, readOnly],
  );

  // --- copy / paste ---

  // Stash a path as the paste source. Copy never mutates, so it's allowed even
  // when other mutations might be gated.
  const copyPath = useCallback((path: string) => setCopySource(path), []);

  const clearCopy = useCallback(() => setCopySource(null), []);

  // Paste the copied source into `destDir` (a directory path). Resolves a
  // collision-free name from the destination's *fresh* listing, then routes to
  // `ssh_fs_copy` for remote pairs (same host) or `fs_copy` locally. Cross-realm
  // and cross-host pastes aren't supported in this pass and are refused.
  const pasteInto = useCallback(
    async (destDir: string) => {
      if (readOnly) return;
      const from = copySource;
      if (!from) return;

      const srcRef = parseRemote(from);
      const dstRef = parseRemote(destDir);
      if (!!srcRef !== !!dstRef) {
        console.error("paste across local/remote is not supported");
        return;
      }
      if (srcRef && dstRef && srcRef.alias !== dstRef.alias) {
        console.error("paste across different remote hosts is not supported");
        return;
      }

      // Re-list the destination so the free-name search sees current siblings,
      // not a stale (or never-loaded) cache.
      await fetchChildren(destDir);
      const dest = nodesRef.current[destDir];
      const taken = new Set(
        dest?.status === "loaded" ? dest.entries.map((e) => e.name) : [],
      );

      const srcName = basename(from);
      // Pasting into the source's own directory would collide on name; offer a
      // " copy" variant. Elsewhere, keep the name unless it's already taken.
      const sameDir = dirname(from) === destDir;
      const name =
        sameDir || taken.has(srcName) ? freeCopyName(srcName, taken) : srcName;

      try {
        if (srcRef && dstRef) {
          // Remote commands take raw remote paths (no `ssh://` prefix).
          await copyRemote(srcRef.alias, srcRef.path, joinPath(dstRef.path, name));
        } else {
          await invoke("fs_copy", {
            from,
            to: joinPath(destDir, name),
            workspace: currentWorkspaceEnv(),
          });
        }
        await fetchChildren(destDir);
      } catch (e) {
        console.error("copy failed:", e);
      }
    },
    [copySource, fetchChildren, readOnly],
  );

  return {
    nodes,
    expanded,
    readOnly,
    pendingCreate,
    renaming,
    copySource,
    toggle,
    expand,
    refresh,
    beginCreate,
    cancelCreate,
    commitCreate,
    beginRename,
    cancelRename,
    commitRename,
    deletePath,
    copyPath,
    clearCopy,
    pasteInto,
    joinPath,
  };
}
