import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { FileExplorerHandle } from "@/modules/explorer";
import type { SidebarViewId } from "@/modules/sidebar";
import type { RightSidebarViewId } from "@/modules/right-sidebar";
import { useTaskRunnerStore } from "@/modules/task-runner";
import { hasExplicitLaunchDir } from "@/lib/launchDir";

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "terax.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "terax.sidebar.view";

export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 320;
export const RIGHT_SIDEBAR_MIN_WIDTH = 240;
export const RIGHT_SIDEBAR_MAX_WIDTH = 560;
const RIGHT_SIDEBAR_WIDTH_STORAGE_KEY = "terax.right-sidebar.width";
const RIGHT_SIDEBAR_VIEW_STORAGE_KEY = "terax.right-sidebar.view";

function readSidebarWidth(): number {
  // The left sidebar always starts at its minimum width on launch; the user can
  // drag it wider during the session (and that live value still persists), but
  // each new window begins compact rather than restoring the stored width.
  return SIDEBAR_MIN_WIDTH;
}

function readSidebarView(): SidebarViewId {
  // Windows opened for a project (carrying `?dir=`) always start on the file
  // explorer, regardless of the cross-window persisted view.
  try {
    if (new URLSearchParams(window.location.search).get("dir")) {
      return "explorer";
    }
  } catch {
    // ignore
  }
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (
      stored === "explorer" ||
      stored === "source-control" ||
      stored === "ssh-remote" ||
      stored === "docker" ||
      stored === "projects"
    )
      return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

function clampRightSidebarWidth(width: number): number {
  return Math.min(
    RIGHT_SIDEBAR_MAX_WIDTH,
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function readRightSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(RIGHT_SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampRightSidebarWidth(parsed)
      : RIGHT_SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return RIGHT_SIDEBAR_DEFAULT_WIDTH;
  }
}

function readRightSidebarView(): RightSidebarViewId {
  try {
    const stored = window.localStorage.getItem(RIGHT_SIDEBAR_VIEW_STORAGE_KEY);
    if (
      stored === "ai" ||
      stored === "agents" ||
      stored === "tasks" ||
      stored === "actions"
    )
      return stored;
  } catch {
    // ignore
  }
  return "ai";
}

type UseSidebarStateArgs = {
  /** App-owned explorer handle; `toggleExplorerFocus` drives focus through it. */
  explorerRef: React.RefObject<FileExplorerHandle | null>;
};

/**
 * Owns both sidebar rails: panel refs, persisted view + width, and the
 * expand/collapse/cycle behavior. Width and view persist to localStorage
 * (per-window read, cross-window-tolerant). The refs are returned so App's
 * ResizablePanel JSX can wire `panelRef`/`defaultSize`.
 */
export function useSidebarState({ explorerRef }: UseSidebarStateArgs) {
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);

  // Collapse/expand smoothing. `react-resizable-panels` sets panel `flexGrow`
  // imperatively — a CSS transition on it would also rubber-band live drags,
  // and this version exposes no "is dragging" DOM attribute to scope it off.
  // So we gate the transition on a `data-animating` flag that ONLY the
  // programmatic collapse/expand paths set (never a drag). `animatingTimerRef`
  // clears it shortly after the animation window so a subsequent drag is crisp.
  const [sidebarsAnimating, setSidebarsAnimating] = useState(false);
  const animatingTimerRef = useRef(0);
  const beginSidebarAnim = useCallback(() => {
    setSidebarsAnimating(true);
    if (animatingTimerRef.current) window.clearTimeout(animatingTimerRef.current);
    animatingTimerRef.current = window.setTimeout(() => {
      animatingTimerRef.current = 0;
      setSidebarsAnimating(false);
    }, 240);
  }, []);
  useEffect(() => {
    return () => {
      if (animatingTimerRef.current) window.clearTimeout(animatingTimerRef.current);
    };
  }, []);

  // On a plain launch (no project dir) both sidebars start collapsed so the
  // projects dashboard owns the full window. A dir-launched project window
  // keeps its normal sidebars. Read once at construction so re-renders keep the
  // panels' `defaultSize` stable.
  const startSidebarsCollapsedRef = useRef(!hasExplicitLaunchDir());

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);

  const rightSidebarRef = useRef<PanelImperativeHandle | null>(null);
  const rightSidebarWidthRef = useRef(readRightSidebarWidth());
  const rightSidebarWidthWriteTimerRef = useRef(0);
  const [rightSidebarView, setRightSidebarViewState] =
    useState<RightSidebarViewId>(readRightSidebarView);

  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    beginSidebarAnim();
    // `.resize()` (not `.expand()`) so the rail reopens at the stored width even
    // on the first toggle.
    if (p.getSize().asPercentage <= 0) p.resize(`${sidebarWidthRef.current}px`);
    else p.collapse();
  }, [beginSidebarAnim]);

  const toggleRightSidebar = useCallback(() => {
    const p = rightSidebarRef.current;
    if (!p) return;
    beginSidebarAnim();
    if (p.getSize().asPercentage <= 0)
      p.resize(`${rightSidebarWidthRef.current}px`);
    else p.collapse();
  }, [beginSidebarAnim]);

  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        beginSidebarAnim();
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        beginSidebarAnim();
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [beginSidebarAnim, persistSidebarView, sidebarView],
  );

  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const persistRightSidebarView = useCallback((view: RightSidebarViewId) => {
    setRightSidebarViewState(view);
    try {
      window.localStorage.setItem(RIGHT_SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);

  // Selecting the active view again collapses the panel; selecting a different
  // view (while collapsed) re-expands it. Mirrors the left rail's behavior.
  const selectRightSidebarView = useCallback(
    (view: RightSidebarViewId) => {
      const panel = rightSidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        beginSidebarAnim();
        if (panel) panel.resize(`${rightSidebarWidthRef.current}px`);
        if (view !== rightSidebarView) persistRightSidebarView(view);
        return;
      }
      if (view === rightSidebarView) {
        beginSidebarAnim();
        panel?.collapse();
        return;
      }
      persistRightSidebarView(view);
    },
    [beginSidebarAnim, persistRightSidebarView, rightSidebarView],
  );

  // From the global background-tasks indicator: always reveal the Tasks panel
  // (expand the right sidebar if collapsed, switch its view) and select the
  // task so its output is shown. Unlike `selectRightSidebarView` this never
  // toggles closed — it's an explicit "show me this task" action.
  const openTaskInSidebar = useCallback(
    (id: string) => {
      const panel = rightSidebarRef.current;
      if (panel && panel.getSize().asPercentage <= 0) {
        beginSidebarAnim();
        panel.resize(`${rightSidebarWidthRef.current}px`);
      }
      if (rightSidebarView !== "tasks") persistRightSidebarView("tasks");
      useTaskRunnerStore.getState().select(id);
    },
    [beginSidebarAnim, persistRightSidebarView, rightSidebarView],
  );

  const persistRightSidebarWidth = useCallback((next: number) => {
    rightSidebarWidthRef.current = next;
    if (rightSidebarWidthWriteTimerRef.current) {
      window.clearTimeout(rightSidebarWidthWriteTimerRef.current);
    }
    rightSidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      rightSidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(
          RIGHT_SIDEBAR_WIDTH_STORAGE_KEY,
          String(next),
        );
      } catch {
        // ignore
      }
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (rightSidebarWidthWriteTimerRef.current) {
        window.clearTimeout(rightSidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) {
        beginSidebarAnim();
        panel.resize(`${sidebarWidthRef.current}px`);
      }
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [beginSidebarAnim, explorerRef, persistSidebarView, sidebarView]);

  return {
    startSidebarsCollapsedRef,
    // True for ~240ms after a programmatic collapse/expand; App keys the
    // panel-group's `data-animating` (→ flex-grow transition) off it. Never set
    // by a drag, so live resizes stay instant.
    sidebarsAnimating,
    // left
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    persistSidebarView,
    persistSidebarWidth,
    toggleSidebar,
    cycleSidebarView,
    toggleExplorerFocus,
    // right
    rightSidebarRef,
    rightSidebarWidthRef,
    rightSidebarView,
    persistRightSidebarView,
    persistRightSidebarWidth,
    toggleRightSidebar,
    selectRightSidebarView,
    openTaskInSidebar,
  };
}
