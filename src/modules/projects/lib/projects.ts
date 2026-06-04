import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * A user-curated project: a folder on disk plus editable metadata (name, tags,
 * notes). Added from the explorer's "Add to Projects" action and persisted via
 * tauri-plugin-store so it survives restarts and is shared across windows.
 */
export type Project = {
  id: string;
  /** Display name — defaults to the folder's basename, user-editable. */
  name: string;
  /** Absolute folder path (forward-slash normalized). */
  path: string;
  /** Free-form tags for grouping/filtering. */
  tags: string[];
  /** Free-form notes shown on the detail page. */
  notes: string;
  /** Creation time (ms since epoch) — for stable list ordering. */
  createdAt: number;
  /**
   * Last time the project was opened (ms since epoch). Optional for
   * back-compat: projects added before this field existed have it undefined and
   * simply don't appear in the "Recent" row until opened once.
   */
  lastOpenedAt?: number;
};

const STORE_PATH = "terax-projects.json";
const KEY_LIST = "projects";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadProjects(): Promise<Project[]> {
  return (await store.get<Project[]>(KEY_LIST)) ?? [];
}

export async function saveProjects(list: Project[]): Promise<void> {
  await store.set(KEY_LIST, list);
  await store.save();
}

export function newProjectId(): string {
  return `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Last path segment of a folder path, used as the default project name. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Normalize a path to forward slashes (matches the explorer's convention). */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || path;
}

const SSH_PREFIX = "ssh://";

/** A project's server group key, derived from its path (no stored field). */
export type ServerKey = { kind: "local" } | { kind: "ssh"; alias: string };

/**
 * Derive the "server" a project lives on purely from its path. Remote projects
 * are encoded as `ssh://<alias>/<path>` (see explorer/lib/remote.ts), so the
 * alias is the server. Everything else is the local machine. This keeps the
 * Project model free of a redundant `server` field.
 */
export function serverOf(path: string): ServerKey {
  if (path.startsWith(SSH_PREFIX)) {
    const rest = path.slice(SSH_PREFIX.length);
    const slash = rest.indexOf("/");
    const alias = slash === -1 ? rest : rest.slice(0, slash);
    if (alias) return { kind: "ssh", alias };
  }
  return { kind: "local" };
}

/** Stable string id for a server group (used as a Map key + section key). */
export function serverGroupId(key: ServerKey): string {
  return key.kind === "ssh" ? `ssh:${key.alias}` : "local";
}

/** Human-readable label for a server group header. */
export function serverLabel(key: ServerKey): string {
  return key.kind === "ssh" ? key.alias : "Local";
}

/** Parse a comma/whitespace separated tag string into a clean, deduped list. */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(/[,\n]/)) {
    const tag = t.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}
