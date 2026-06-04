import { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { Tab } from "@/modules/tabs";
import type { EditorPaneHandle } from "@/modules/editor";
import type { SearchInlineHandle } from "@/modules/header";
import { clearFocusedTerminal } from "@/modules/terminal";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  useGlobalShortcuts,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";

type SidebarView = "projects" | "source-control";

type UseAppShortcutsArgs = {
  activeId: number;
  activeTab: Tab | undefined;
  editorRefs: React.RefObject<Map<number, EditorPaneHandle>>;
  searchInlineRef: React.RefObject<SearchInlineHandle | null>;
  captureActiveSelection: () => string | null;

  // Tab/pane actions
  openNewTab: () => void;
  openNewPrivateTab: () => void;
  openPreviewTab: (url: string) => number;
  handleCloseTabOrPane: () => void;
  cycleTab: (delta: 1 | -1) => void;
  selectByIndex: (index: number) => void;
  splitActivePaneInActiveTab: (dir: "row" | "col") => void;
  focusNextPaneInTab: (tabId: number, delta: 1 | -1) => void;

  // AI / source-control / agents
  toggleSourceControl: () => void;
  togglePanelAndFocus: () => void;
  askFromSelection: () => void;
  openClaudeNewTab: () => void;
  openClaudeSplitRight: () => void;
  openClaudeGoldenDuo: () => void;
  openClaudeTeam: () => void;

  // Sidebar / view / zoom
  cycleSidebarView: (view: SidebarView) => void;
  // S3, Docker, and SSH are main-editor tabs now (moved out of the sidebar),
  // opened via these singleton tab-openers.
  openS3Tab: () => void;
  openDockerTab: () => void;
  openSshTab: () => void;
  addCurrentFolderToProjects: () => void;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleExplorerFocus: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // Dialog/popup open setters
  setNewEditorOpen: (open: boolean) => void;
  setCommandPopupOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

/**
 * Builds the global keyboard-shortcut handler map (also handed to the command
 * palette) and the per-shortcut disabled predicate, then registers them via
 * `useGlobalShortcuts`. This is the integration hub wiring every action cluster
 * to its key binding — extracted from App.tsx. Returns the handler map so the
 * command palette can drive the same actions.
 */
export function useAppShortcuts({
  activeId,
  activeTab,
  editorRefs,
  searchInlineRef,
  captureActiveSelection,
  openNewTab,
  openNewPrivateTab,
  openPreviewTab,
  handleCloseTabOrPane,
  cycleTab,
  selectByIndex,
  splitActivePaneInActiveTab,
  focusNextPaneInTab,
  toggleSourceControl,
  togglePanelAndFocus,
  askFromSelection,
  openClaudeNewTab,
  openClaudeSplitRight,
  openClaudeGoldenDuo,
  openClaudeTeam,
  cycleSidebarView,
  addCurrentFolderToProjects,
  openS3Tab,
  openDockerTab,
  openSshTab,
  toggleSidebar,
  toggleRightSidebar,
  toggleExplorerFocus,
  zoomIn,
  zoomOut,
  zoomReset,
  setNewEditorOpen,
  setCommandPopupOpen,
  setShortcutsOpen,
}: UseAppShortcutsArgs): ShortcutHandlers {
  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "search.focus": () => searchInlineRef.current?.focus(),
      "ai.toggle": togglePanelAndFocus,
      "ai.askSelection": askFromSelection,
      "claude.newTab": openClaudeNewTab,
      "claude.splitRight": openClaudeSplitRight,
      "claude.goldenDuo": openClaudeGoldenDuo,
      "claude.team": openClaudeTeam,
      "window.new": () => void invoke("open_main_window"),
      "commandPopup.open": () => setCommandPopupOpen((v) => !v),
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "rightSidebar.toggle": toggleRightSidebar,
      "view.sshRemote": openSshTab,
      "view.docker": openDockerTab,
      "view.s3": openS3Tab,
      "view.projects": () => cycleSidebarView("projects"),
      "projects.addCurrent": addCurrentFolderToProjects,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.format": () => {
        const handle = editorRefs.current.get(activeId);
        if (!handle) return;
        // Show a loading toast only if the format hasn't resolved within a
        // frame — small files finish instantly and shouldn't flash a spinner.
        // Large files run in a background Web Worker (see formatAsync.ts) and
        // this toast reports the in-progress work + final outcome.
        let toastId: string | number | undefined;
        const slow = setTimeout(() => {
          toastId = toast.loading("Formatting…");
        }, 150);
        void handle
          .format()
          .then((res) => {
            clearTimeout(slow);
            if (!res.ok) {
              toast.error(`Format failed: ${res.message}`, { id: toastId });
              return;
            }
            // Success feedback so the command never feels like a no-op — a file
            // that's already formatted otherwise gives zero signal. Distinguish
            // the engine: Prettier (full reformat) vs CodeMirror reindent
            // (fallback for languages Prettier can't parse).
            toast.success(
              res.engine === "prettier"
                ? "Formatted with Prettier"
                : "Reindented",
              { id: toastId },
            );
          })
          .catch((e: unknown) => {
            clearTimeout(slow);
            toast.error(
              `Format failed: ${e instanceof Error ? e.message : String(e)}`,
              { id: toastId },
            );
          });
      },
    }),
    [
      activeId,
      cycleTab,
      handleCloseTabOrPane,
      openNewTab,
      openNewPrivateTab,
      openPreviewTab,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      toggleSourceControl,
      togglePanelAndFocus,
      askFromSelection,
      openClaudeNewTab,
      openClaudeSplitRight,
      openClaudeGoldenDuo,
      openClaudeTeam,
      cycleSidebarView,
      openS3Tab,
      openDockerTab,
      openSshTab,
      addCurrentFolderToProjects,
      toggleSidebar,
      toggleRightSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
      editorRefs,
      searchInlineRef,
      setNewEditorOpen,
      setCommandPopupOpen,
      setShortcutsOpen,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.format"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      return false;
    },
    [activeTab, captureActiveSelection],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  return shortcutHandlers;
}
