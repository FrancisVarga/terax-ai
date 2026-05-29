import { useCallback, useEffect, useRef, useState } from "react";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  removeLeaf,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";

// Matches the renderer slot pool size — over this we'd evict an active leaf.
export const MAX_PANES_PER_TAB = 4;

export type TerminalTab = {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
};

export type EditorTab = {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state — opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
};

export type PreviewTab = {
  id: number;
  kind: "preview";
  title: string;
  url: string;
};

export type MarkdownTab = {
  id: number;
  kind: "markdown";
  title: string;
  path: string;
};

/** Image preview (png/jpg/gif/webp/svg/…) rendered via the asset protocol. */
export type ImageTab = {
  id: number;
  kind: "image";
  title: string;
  path: string;
};

/** Log file viewer with per-line level colorization. */
export type LogTab = {
  id: number;
  kind: "log";
  title: string;
  path: string;
};

/** Tabular data preview (SQLite / CSV / Parquet) rendered in an AG Grid. */
export type DataTab = {
  id: number;
  kind: "data";
  title: string;
  path: string;
  format: "sqlite" | "csv" | "parquet";
};

/** S3 file browser — a singleton main-content tab (tree + object preview). */
export type S3Tab = {
  id: number;
  kind: "s3";
  title: string;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = {
  id: number;
  kind: "ai-diff";
  title: string;
  path: string;
  /** "" for newly created files. */
  originalContent: string;
  proposedContent: string;
  /** Tool-call approval id used to resolve the AI SDK approval. */
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitDiffTab = {
  id: number;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
};

export type GitHistoryTab = {
  id: number;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

export type GitCommitFileDiffTab = {
  id: number;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type BunqueueTab = {
  id: number;
  kind: "bunqueue";
  title: string;
};

export type AnalyticsTab = {
  id: number;
  kind: "agentlytics";
  title: string;
};

/** Local OpenTelemetry observability dashboard — a singleton main-content tab. */
export type OtelTab = {
  id: number;
  kind: "otel";
  title: string;
};

/** AG Grid Community feature showcase — a singleton main-content tab. */
export type DataGridMasterTab = {
  id: number;
  kind: "data-grid-master";
  title: string;
};

export type CcusageTab = {
  id: number;
  kind: "ccusage";
  title: string;
};

export type ProjectsTab = {
  id: number;
  kind: "projects";
  title: string;
};

export type ProjectDetailTab = {
  id: number;
  kind: "project-detail";
  title: string;
  /** Project id (from the projects store) this detail page renders. */
  projectId: string;
};

export type DockerDetailTab = {
  id: number;
  kind: "docker-detail";
  title: string;
  /** Container id or name passed to `docker inspect`/`docker logs`. */
  containerId: string;
  /** Display name (without the leading slash Docker prepends). */
  containerName: string;
  /** SSH alias for a remote daemon; `null` = local. */
  host: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | PreviewTab
  | MarkdownTab
  | ImageTab
  | LogTab
  | DataTab
  | S3Tab
  | AiDiffTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab
  | BunqueueTab
  | DockerDetailTab
  | AnalyticsTab
  | OtelTab
  | DataGridMasterTab
  | CcusageTab
  | ProjectsTab
  | ProjectDetailTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  url: string;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

export function useTabs(
  initial?: Partial<TerminalTab>,
  options?: {
    /**
     * When true the window opened for a specific project (via `?dir=`) and
     * should focus the terminal on launch. When false/omitted a plain launch
     * focuses the Projects dashboard instead.
     */
    focusTerminalOnLaunch?: boolean;
  },
) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    // Seed the projects dashboard as the first (and initially active) tab,
    // followed by the bunqueue dashboard and a default shell.
    // IDs: projects=1, bunqueue=2, terminal=3, its leaf=4.
    const projectsId = 1;
    const bunqueueId = 2;
    const termId = 3;
    const leafId = 4;
    return [
      { id: projectsId, kind: "projects", title: "Projects" },
      { id: bunqueueId, kind: "bunqueue", title: "bunqueue" },
      {
        id: termId,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  // A project window (opened via `?dir=`) focuses its terminal (id 3); a plain
  // launch focuses the Projects dashboard (id 1).
  const [activeId, setActiveId] = useState(
    options?.focusTerminalOnLaunch ? 3 : 1,
  );
  const nextIdRef = useRef(5);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "shell",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  const newAgentTab = useCallback(
    (cwd: string | undefined, title: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title,
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ]);
      setActiveId(tabId);
      return { tabId, leafId };
    },
    [],
  );

  // Open a terminal tab pre-split into a 2x2 grid (4 leaves). Used by the
  // "Create Claude team" command. Returns the tab id and the 4 leaf ids in
  // visual order (top-left, bottom-left, top-right, bottom-right) so the caller
  // can launch a process in each. Capped at MAX_PANES_PER_TAB (=4).
  const newGridTab = useCallback(
    (cwd: string | undefined, title: string) => {
      const tabId = nextIdRef.current++;
      const outerSplit = nextIdRef.current++;
      const leftSplit = nextIdRef.current++;
      const rightSplit = nextIdRef.current++;
      const a = nextIdRef.current++;
      const b = nextIdRef.current++;
      const c = nextIdRef.current++;
      const d = nextIdRef.current++;
      const leaf = (id: number): PaneNode => ({ kind: "leaf", id, cwd });
      const paneTree: PaneNode = {
        kind: "split",
        id: outerSplit,
        dir: "row",
        children: [
          {
            kind: "split",
            id: leftSplit,
            dir: "col",
            children: [leaf(a), leaf(b)],
          },
          {
            kind: "split",
            id: rightSplit,
            dir: "col",
            children: [leaf(c), leaf(d)],
          },
        ],
      };
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title,
          cwd,
          paneTree,
          activeLeafId: a,
        },
      ]);
      setActiveId(tabId);
      return { tabId, leafIds: [a, b, c, d] as const };
    },
    [],
  );

  const newPrivateTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "private",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        private: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default) — opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false` — VSCode-style **preview** tab. A single shared slot is
   *   reused: if a persistent tab for the path already exists it is activated;
   *   otherwise the current preview slot is replaced with the new path.
   */
  const openFileTab = useCallback((path: string, pin = true) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      if (pin) {
        // Persistent open: find any existing editor tab, pin it if needed.
        const existing = curr.find(
          (t) => t.kind === "editor" && t.path === path,
        );
        if (existing) {
          targetId = existing.id;
          if ((existing as EditorTab).preview) {
            return curr.map((t) =>
              t.id === existing.id ? { ...t, preview: false } : t,
            );
          }
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        return [
          ...curr,
          {
            id,
            kind: "editor",
            title: basename(path),
            path,
            dirty: false,
            preview: false,
          } satisfies EditorTab,
        ];
      } else {
        // Preview open: persistent tab for this path takes priority.
        const persistent = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && !(t as EditorTab).preview,
        );
        if (persistent) {
          targetId = persistent.id;
          return curr;
        }
        // Reuse the slot if it already shows the same path.
        const existingPreview = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && (t as EditorTab).preview,
        );
        if (existingPreview) {
          targetId = existingPreview.id;
          return curr;
        }
        // Replace the current preview slot, or append a new one.
        const previewIdx = curr.findIndex(
          (t) => t.kind === "editor" && (t as EditorTab).preview,
        );
        const id = nextIdRef.current++;
        targetId = id;
        const tab: EditorTab = {
          id,
          kind: "editor",
          title: basename(path),
          path,
          dirty: false,
          preview: true,
        };
        if (previewIdx === -1) return [...curr, tab];
        const next = [...curr];
        next[previewIdx] = tab;
        return next;
      }
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId as number | null;
  }, []);

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty edits also auto-promote (see `updateTab`).
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "editor" ? { ...t, preview: false } : t,
      ),
    );
  }, []);

  const openAiDiffTab = useCallback(
    (input: {
      path: string;
      originalContent: string;
      proposedContent: string;
      approvalId: string;
      isNewFile: boolean;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "ai-diff" && t.approvalId === input.approvalId,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        const title = `${basename(input.path)} (AI diff)`;
        return [
          ...curr,
          {
            id,
            kind: "ai-diff",
            title,
            path: input.path,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            approvalId: input.approvalId,
            status: "pending",
            isNewFile: input.isNewFile,
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  const setAiDiffStatus = useCallback(
    (approvalId: string, status: AiDiffStatus) => {
      setTabs((curr) =>
        curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status }
            : t,
        ),
      );
    },
    [],
  );

  const closeAiDiffTab = useCallback((approvalId: string) => {
    setTabs((curr) => {
      const target = curr.find(
        (t) => t.kind === "ai-diff" && t.approvalId === approvalId,
      );
      if (!target || curr.length <= 1) {
        if (!target) return curr;
        return curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status: "approved" as AiDiffStatus }
            : t,
        );
      }
      const idx = curr.findIndex((t) => t.id === target.id);
      const next = curr.filter((t) => t.id !== target.id);
      setActiveId((active) =>
        target.id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
  }, []);

  const newPreviewTab = useCallback((url: string) => {
    const id = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      { id, kind: "preview", title: titleFromUrl(url), url },
    ]);
    setActiveId(id);
    return id;
  }, []);

  /** Open (or focus) the singleton bunqueue dashboard tab. */
  const openBunqueueTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "bunqueue");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "bunqueue", title: "bunqueue" }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /**
   * Open (or focus) a Docker container detail tab. Keyed by host+containerId so
   * re-clicking the same container focuses the existing tab rather than piling
   * up duplicates.
   */
  const openDockerDetailTab = useCallback(
    (input: {
      containerId: string;
      containerName: string;
      host: string | null;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) =>
            t.kind === "docker-detail" &&
            t.containerId === input.containerId &&
            t.host === input.host,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        return [
          ...curr,
          {
            id,
            kind: "docker-detail",
            title: input.containerName,
            containerId: input.containerId,
            containerName: input.containerName,
            host: input.host,
          } satisfies DockerDetailTab,
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId;
    },
    [],
  );

  /** Open (or focus) the singleton projects dashboard tab. */
  const openProjectsTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "projects");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "projects", title: "Projects" }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /** Open (or focus) the singleton S3 file browser tab. */
  const openS3Tab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "s3");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "s3", title: "S3" } satisfies S3Tab];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /**
   * Open (or focus) a project detail tab. Keyed by project id so re-opening the
   * same project focuses the existing tab instead of stacking duplicates. The
   * title is refreshed on focus to track project renames.
   */
  const openProjectDetailTab = useCallback(
    (input: { projectId: string; title: string }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "project-detail" && t.projectId === input.projectId,
        );
        if (existing) {
          targetId = existing.id;
          return existing.title === input.title
            ? curr
            : curr.map((t) =>
                t.id === existing.id ? { ...t, title: input.title } : t,
              );
        }
        const id = nextIdRef.current++;
        targetId = id;
        return [
          ...curr,
          {
            id,
            kind: "project-detail",
            title: input.title,
            projectId: input.projectId,
          } satisfies ProjectDetailTab,
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId;
    },
    [],
  );

  /** Open (or focus) the singleton Agentlytics analytics dashboard tab. */
  const openAnalyticsTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "agentlytics");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "agentlytics", title: "Agentlytics" }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /** Open (or focus) the singleton OpenTelemetry observability dashboard tab. */
  const openOtelTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "otel");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "otel", title: "Observability" }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /** Open (or focus) the singleton AG Grid feature-showcase tab. */
  const openDataGridMasterTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "data-grid-master");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [
        ...curr,
        { id, kind: "data-grid-master", title: "Data Grid" },
      ];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  /** Open (or focus) the singleton ccusage token/cost dashboard tab. */
  const openCcusageTab = useCallback(() => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "ccusage");
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "ccusage", title: "ccusage" }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newMarkdownTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find(
        (t) => t.kind === "markdown" && t.path === path,
      );
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "markdown", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newImageTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "image" && t.path === path);
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "image", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newLogTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "log" && t.path === path);
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "log", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newDataTab = useCallback(
    (path: string, format: DataTab["format"]) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "data" && t.path === path,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        return [
          ...curr,
          { id, kind: "data", title: basename(path), path, format },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId;
    },
    [],
  );

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      repoRoot: string;
      mode: "-" | "+";
      originalPath?: string | null;
      title?: string;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-diff" &&
          t.repoRoot === input.repoRoot &&
          t.path === input.path &&
          t.mode === input.mode,
      );
      const computedTitle =
        input.title ?? `${basename(input.path)} (${input.mode})`;
      const originalPath = input.originalPath ?? null;

      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? { ...t, title: computedTitle, originalPath }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }

      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-diff",
          title: computedTitle,
          path: input.path,
          repoRoot: input.repoRoot,
          mode: input.mode,
          originalPath,
        } satisfies GitDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) => t.kind === "git-history" && t.repoRoot === input.repoRoot,
      );
      const title = input.branch
        ? `History · ${input.branch}`
        : "Git History";
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id ? { ...t, title } : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-history",
          title,
          repoRoot: input.repoRoot,
        } satisfies GitHistoryTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.repoRoot === input.repoRoot &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-commit-file",
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const closeTab = useCallback((id: number) => {
    let toDispose: number[] = [];
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const target = curr[idx];
      if (target && target.kind === "terminal") {
        toDispose = leafIds(target.paneTree);
      }
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) =>
        id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    setTabs((t) =>
      t.map((x) => {
        if (x.id !== id) return x;
        if (x.kind === "terminal") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.cwd !== undefined && { cwd: patch.cwd }),
          };
        }
        if (x.kind === "preview") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.url !== undefined && {
              url: patch.url,
              title: patch.title ?? titleFromUrl(patch.url),
            }),
          };
        }
        if (x.kind === "markdown") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
          };
        }
        if (x.kind === "image" || x.kind === "log") {
          // Path-keyed: follow renames of the underlying file.
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.path !== undefined && { path: patch.path }),
          };
        }
        if (x.kind === "data") {
          // Path-keyed tab: follow renames of the underlying file.
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.path !== undefined && { path: patch.path }),
          };
        }
        // editor tab: auto-promote from preview the moment the file becomes dirty.
        const autoPin =
          patch.dirty === true && (x as EditorTab).preview
            ? { preview: false }
            : {};
        return {
          ...x,
          ...autoPin,
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.dirty !== undefined && { dirty: patch.dirty }),
          ...(patch.path !== undefined && { path: patch.path }),
        };
      }),
    );
  }, []);

  const selectByIndex = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed — shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        const cwdChanged = isActive && t.cwd !== cwd;
        if (paneTree === t.paneTree && !cwdChanged) return t;
        changed = true;
        return { ...t, paneTree, ...(cwdChanged && { cwd }) };
      });
      return changed ? next : curr;
    });
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        const cwd = findLeafCwd(t.paneTree, leafId);
        return {
          ...t,
          activeLeafId: leafId,
          ...(cwd !== undefined && { cwd }),
        };
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (next === t.activeLeafId) return t;
        const cwd = findLeafCwd(t.paneTree, next);
        return { ...t, activeLeafId: next, ...(cwd !== undefined && { cwd }) };
      }),
    );
  }, []);

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir, cwd?: string): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            // Caller may pin a cwd (e.g. launch claude at project root);
            // otherwise inherit the tab's working directory.
            cwd ?? t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    let didRemove = false;
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) =>
          active === tab.id ? next[Math.max(0, idx - 1)].id : active,
        );
        didRemove = true;
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      didRemove = true;
      return curr.map((x) =>
        x.id === tab.id
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (didRemove) disposeSession(leafId);
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    let removedLeaf: number | null = null;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t || t.kind !== "terminal") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tabId);
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) =>
          active === tabId ? next[Math.max(0, idx - 1)].id : active,
        );
        closedTab = true;
        removedLeaf = target;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive =
        sib && remaining.includes(sib) ? sib : remaining[0];
      removedLeaf = target;
      return curr.map((x) =>
        x.id === tabId
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (removedLeaf !== null) disposeSession(removedLeaf);
    return closedTab;
  }, []);

  const resetWorkspace = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    let toDispose: number[] = [];
    setTabs((curr) => {
      toDispose = curr.flatMap((t) =>
        t.kind === "terminal" ? leafIds(t.paneTree) : [],
      );
      return [
        {
          id: tabId,
          kind: "terminal",
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ];
    });
    setActiveId(tabId);
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  return {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newAgentTab,
    newGridTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    newImageTab,
    newLogTab,
    newDataTab,
    openS3Tab,
    openBunqueueTab,
    openProjectsTab,
    openProjectDetailTab,
    openAnalyticsTab,
    openOtelTab,
    openDataGridMasterTab,
    openCcusageTab,
    openDockerDetailTab,
    openAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    setAiDiffStatus,
    closeAiDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  };
}
