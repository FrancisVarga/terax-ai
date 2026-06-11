use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Walks up from `dir` looking for the enclosing git work tree (the first
/// ancestor containing a `.git` entry). Returns `None` when `dir` isn't inside
/// a repo — in that case nothing is git-ignored.
fn find_git_root(dir: &Path) -> Option<PathBuf> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

/// Builds a gitignore matcher for entries living directly in `dir`, stacking the
/// `.gitignore` files from the git root down to `dir` (parent rules apply to
/// nested dirs, matching git semantics). Returns `None` outside a repo.
///
/// This is a per-directory matcher: it's cheap to build for one listing and
/// avoids a recursive walk. It does not consult the git index or
/// `core.excludesFile`, but covers the common case (repo + nested `.gitignore`).
fn build_ignore_matcher(dir: &Path) -> Option<Gitignore> {
    let root = find_git_root(dir)?;
    let mut builder = GitignoreBuilder::new(&root);

    // Stack ancestor .gitignore files from the repo root down to `dir`.
    let mut chain: Vec<&Path> = Vec::new();
    let mut cur = Some(dir);
    while let Some(d) = cur {
        chain.push(d);
        if d == root {
            break;
        }
        cur = d.parent();
    }
    for d in chain.into_iter().rev() {
        let gi = d.join(".gitignore");
        if gi.exists() {
            let _ = builder.add(gi);
        }
    }

    builder.build().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since UNIX epoch; 0 if unavailable.
    pub mtime: u64,
    /// True when git would ignore this entry (matched by a `.gitignore` rule in
    /// scope, or the `.git` dir itself). The frontend dims these rows.
    pub ignored: bool,
}

/// Lists immediate children of `path`. Dirs first, then files, each sorted
/// case-insensitively. Dot-prefixed entries (files and dirs) are hidden unless
/// `show_hidden` is set.
// (async): directory IO (slow on network drives / WSL mounts); off the main thread.
#[tauri::command(async)]
pub fn fs_read_dir(
    path: String,
    show_hidden: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<DirEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&path, &workspace);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("fs_read_dir({}) failed: {e}", root.display());
        e.to_string()
    })?;

    // Built once per listing, reused for every entry. `None` outside a repo.
    let matcher = build_ignore_matcher(&root);

    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;

            // `metadata()` follows symlinks → it returns the target's stat in
            // one syscall (file_type + size + mtime all derived from it). We
            // fall back to `symlink_metadata` for broken symlinks so we don't
            // silently drop them from the listing.
            let (meta, was_symlink) = match std::fs::metadata(entry.path()) {
                Ok(m) => (Some(m), false),
                Err(_) => (entry.metadata().ok(), true),
            };
            let meta = meta?;

            let kind = if was_symlink {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };

            if name.starts_with('.') && !show_hidden {
                return None;
            }

            let is_dir = matches!(kind, EntryKind::Dir);
            let ignored = name == ".git"
                || matcher
                    .as_ref()
                    .map(|m| m.matched(root.join(&name), is_dir).is_ignore())
                    .unwrap_or(false);

            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            Some(DirEntry {
                name,
                kind,
                size,
                mtime,
                ignored,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        let rank = |k: &EntryKind| match k {
            EntryKind::Dir => 0,
            EntryKind::Symlink => 1,
            EntryKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Lists immediate subdirectories of `path`. Kept for the CwdBreadcrumb.
///
/// Symlinks to directories are included (matches shell `cd` semantics).
/// Hidden entries are filtered by dot-prefix only.
#[tauri::command]
pub fn list_subdirs(
    path: String,
    show_hidden: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = resolve_path(&path, &workspace);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("list_subdirs({}) read_dir failed: {e}", root.display());
        e.to_string()
    })?;

    let mut dirs: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => std::fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false),
            _ => false,
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| show_hidden || !name.starts_with('.'))
        .collect();

    dirs.sort_by_key(|a| a.to_lowercase());
    Ok(dirs)
}
