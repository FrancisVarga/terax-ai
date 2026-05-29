import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  loadProjects,
  newProjectId,
  saveProjects,
  type Project,
} from "../lib/projects";

const CHANGED_EVENT = "terax://projects-changed";

type State = {
  hydrated: boolean;
  projects: Project[];
  hydrate: () => Promise<void>;
  /** Insert or update a project (matched by id). */
  upsert: (project: Project) => void;
  remove: (id: string) => void;
  /** True when any project already points at `path` (normalized compare). */
  hasPath: (path: string) => boolean;
};

let initialized = false;

export const useProjectsStore = create<State>((set, get) => ({
  hydrated: false,
  projects: [],
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    set({ projects: await loadProjects(), hydrated: true });
    void listen(CHANGED_EVENT, async () => {
      set({ projects: await loadProjects() });
    });
  },
  upsert: (project) => {
    const list = get().projects;
    const idx = list.findIndex((p) => p.id === project.id);
    const next =
      idx === -1
        ? [...list, project]
        : list.map((p) => (p.id === project.id ? project : p));
    set({ projects: next });
    void saveProjects(next).then(() => emit(CHANGED_EVENT));
  },
  remove: (id) => {
    const next = get().projects.filter((p) => p.id !== id);
    set({ projects: next });
    void saveProjects(next).then(() => emit(CHANGED_EVENT));
  },
  hasPath: (path) => {
    const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return get().projects.some(
      (p) => p.path.replace(/\\/g, "/").replace(/\/+$/, "") === norm,
    );
  },
}));

export { newProjectId };
