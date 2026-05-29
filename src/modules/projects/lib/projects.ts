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
