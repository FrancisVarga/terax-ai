import { TooltipProvider } from "@/components/ui/tooltip";
import { AppBridges } from "./components/AppBridges";
import { AppDialogs } from "./components/AppDialogs";
import { AppLayout } from "./components/AppLayout";
import { AppRightSidebar } from "./components/AppRightSidebar";
import { AppSidebar } from "./components/AppSidebar";
import { useAgentLaunchers } from "./hooks/useAgentLaunchers";
import { useAiActions } from "./hooks/useAiActions";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useFileOpen } from "./hooks/useFileOpen";
import { useFsWatchReload } from "./hooks/useFsWatchReload";
import { useRemoteSession } from "./hooks/useRemoteSession";
import { useSourceControlActions } from "./hooks/useSourceControlActions";
import { useLaunchFile } from "./hooks/useLaunchFile";
import { useLiveBridge } from "./hooks/useLiveBridge";
import { useThemeIngest } from "./hooks/useThemeIngest";
import { useSidebarState } from "./hooks/useSidebarState";
import { TabStackRouter } from "./TabStackRouter";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import {
  AiInputBar,
  AiInputBarConnect,
  getAllKeys,
  hasAnyKey,
  useChatStore,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { type EditorPaneHandle } from "@/modules/editor";
import { type GitHistorySearchHandle } from "@/modules/git-history";
import { getLaunchDir, hasExplicitLaunchDir } from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { type FileExplorerHandle } from "@/modules/explorer";
import { isRemote } from "@/modules/explorer/lib/remote";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { type PreviewPaneHandle } from "@/modules/preview";
import { useActionsStore } from "@/modules/github-actions";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { useProjectsStore, type Project } from "@/modules/projects";
import { useSourceControl } from "@/modules/source-control";
import { StatusBar } from "@/modules/statusbar";
import {
  MAX_PANES_PER_TAB,
  useStableTabSlice,
  useTabs,
  useWorkspaceCwd,
  type GitCommitFileDiffTab,
  type GitDiffTab,
} from "@/modules/tabs";
import {
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafIds,
  respawnSession,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SearchAddon } from "@xterm/addon-search";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newAgentTab,
    newGridTab,
    newDuoTab,
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
    openAnalyticsTab,
    openOtelTab,
    openCcusageTab,
    openProjectDetailTab,
    openDockerDetailTab,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    reorderTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(
    // A remote (`ssh://…`) launch dir is not a valid LOCAL pty cwd — seeding it
    // would make `pty_open`'s cwd authorization reject and the shell never
    // spawn (every inherited tab then breaks too). Only seed a local cwd; the
    // pty falls back to home for remote/empty.
    getLaunchDir() && !isRemote(getLaunchDir() as string)
      ? { cwd: getLaunchDir() }
      : undefined,
    {
      focusTerminalOnLaunch: hasExplicitLaunchDir(),
    },
  );

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  // Referentially-stable per-kind slices. The single `tabs` array changes on
  // every tab mutation — including `setLeafCwd`, which fires at keystroke rate —
  // so passing `tabs` straight to each content Stack re-renders all of them on
  // any change. These slices keep their reference when their own kind is
  // unchanged, so the (now `React.memo`-wrapped) Stacks bail out: a cwd change
  // on a terminal tab no longer reconciles the markdown / log / data / git
  // subtrees. The terminal slice itself legitimately changes (it carries
  // paneTree/cwd), so TerminalStack still re-renders — that's correct.
  const editorTabs = useStableTabSlice(tabs, "editor");
  const previewTabs = useStableTabSlice(tabs, "preview");
  const markdownTabs = useStableTabSlice(tabs, "markdown");
  const imageTabs = useStableTabSlice(tabs, "image");
  const logTabs = useStableTabSlice(tabs, "log");
  const dataTabs = useStableTabSlice(tabs, "data");
  const aiDiffTabs = useStableTabSlice(tabs, "ai-diff");
  const gitHistoryTabs = useStableTabSlice(tabs, "git-history");
  const dockerDetailTabs = useStableTabSlice(tabs, "docker-detail");
  // GitDiffStack renders two kinds; combine their stable slices into one stable
  // array (recomputed only when either slice's reference actually changed).
  const gitDiffWorkingTabs = useStableTabSlice(tabs, "git-diff");
  const gitCommitFileTabs = useStableTabSlice(tabs, "git-commit-file");
  const gitDiffTabs = useMemo<(GitDiffTab | GitCommitFileDiffTab)[]>(
    () => [...gitDiffWorkingTabs, ...gitCommitFileTabs],
    [gitDiffWorkingTabs, gitCommitFileTabs],
  );

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  const explorerRef = useRef<FileExplorerHandle>(null);

  const {
    startSidebarsCollapsedRef,
    sidebarsAnimating,
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    persistSidebarView,
    persistSidebarWidth,
    toggleSidebar,
    cycleSidebarView,
    toggleExplorerFocus,
    rightSidebarRef,
    rightSidebarView,
    persistRightSidebarWidth,
    toggleRightSidebar,
    selectRightSidebarView,
    openTaskInSidebar,
  } = useSidebarState({ explorerRef });

  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  // Folder path pending an "Add to Projects" confirmation dialog (null = closed).
  const [addProjectPath, setAddProjectPath] = useState<string | null>(null);
  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  useEffect(() => {
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);


  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandPopupOpen, setCommandPopupOpen] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const miniOpen = useChatStore((s) => s.mini.open);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const openMini = useChatStore((s) => s.openMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  useEffect(() => {
    if (activeSessionId) firePendingReviewForSession(activeSessionId);
  }, [activeSessionId]);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (ollamaBaseURL.trim().length > 0 && ollamaModelId.trim().length > 0) ||
    (openaiCompatibleBaseURL.trim().length > 0 &&
      openaiCompatibleModelId.trim().length > 0);
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel;

  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModelId(prefDefaultModel);
  }, [prefsHydrated, prefDefaultModel, setSelectedModelId]);

  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
    void useProjectsStore.getState().hydrate();
  }, [hydrateSessions]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs]);

  useFsWatchReload({ tabs, tabsRef, editorRefs });

  // Theme editing: a custom theme is materialized to a real file and edited in
  // the code editor. Saving it re-ingests into the runtime store + applies live.
  useThemeIngest({ tabsRef, openFileTab });

  // A window is "pinned to a project" when the explorer root is locked to a
  // chosen folder and a `cd` inside a shell no longer drags the file tree off
  // it. Two ways this gets set:
  //   1. Launch-time: a project window opened via `?dir=` (seeded below).
  //   2. Runtime: opening a project in THIS window (see `openProject`), which
  //      previously only `cd`-ed a terminal and let the tree mirror the cwd.
  // A `ssh://…` dir is remote — the local explorer can't pin to it, so it
  // never becomes a pin. The pin is `/`-normalized to match launchDir.ts.
  const [pinnedExplorerRoot, setPinnedExplorerRoot] = useState<string | null>(
    () => {
      if (!hasExplicitLaunchDir()) return null;
      const dir = getLaunchDir();
      return dir && !isRemote(dir) ? dir : null;
    },
  );

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
    pinnedExplorerRoot,
  );

  // True when this window is dedicated to a project (explorer root pinned to a
  // local folder). Drives the "Files" rail highlight and the fixed file tree.
  const isProjectWindow = pinnedExplorerRoot !== null;

  // Reflect the active project (the explorer root's folder name) in the OS
  // window title so taskbar/alt-tab entries are distinguishable per project.
  // explorerRoot is `/`-normalized (see launchDir.ts), so the basename is the
  // last non-empty path segment. Falls back to "Terax" with no project root.
  // The Rust setup adds a one-time " Dev" suffix; that gets overwritten here,
  // so reproduce it via import.meta.env.DEV to keep dev windows distinct.
  useEffect(() => {
    const segments = (explorerRoot ?? "").split("/").filter(Boolean);
    const name = segments.length > 0 ? segments[segments.length - 1] : "Terax";
    const title = import.meta.env.DEV ? `${name} Dev` : name;
    void getCurrentWebviewWindow().setTitle(title);
  }, [explorerRoot]);

  // Report this window's current project dir to the backend so the on-quit
  // snapshot restores the same set of project windows on next launch. Keyed by
  // window label; an empty/remote root reports null (restored at default cwd).
  useEffect(() => {
    const dir = explorerRoot && !isRemote(explorerRoot) ? explorerRoot : null;
    void invoke("report_window_dir", {
      label: getCurrentWebviewWindow().label,
      dir,
    }).catch(() => {});
  }, [explorerRoot]);

  // Watch GitHub Actions for the active project repo in the background, so a run
  // started by a push/PR (or that fails) notifies even when the Actions sidebar
  // tab is closed. Mounted here rather than in the panel because the panel only
  // renders while its tab is active. The disposer stops the old watcher when the
  // project root changes; the store no-ops for remote/empty roots.
  useEffect(() => {
    if (!explorerRoot || isRemote(explorerRoot)) return;
    return useActionsStore.getState().watchActions(explorerRoot);
  }, [explorerRoot]);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null ? (searchAddons.current.get(activeLeafId) ?? null) : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const {
    captureActiveSelection,
    togglePanelAndFocus,
    handleAttachFileToAgent,
    askFromSelection,
    askPopup,
    setAskPopup,
    onAskFromSelection,
  } = useAiActions({
    tabs,
    activeId,
    activeTab,
    terminalRefs,
    editorRefs,
    hasComposer,
  });

  // Claude commands always launch at the current project/workspace root, not
  // the active pane's cwd — so "open claude" is predictable regardless of where
  // the user has cd'd inside a shell.
  const projectCwd = useCallback(
    () => explorerRoot ?? launchCwd ?? home ?? undefined,
    [explorerRoot, launchCwd, home],
  );

  const {
    openClaudeNewTab,
    openGeminiNewTab,
    openClaudeSplitRight,
    openClaudeTeam,
    openClaudeGoldenDuo,
  } = useAgentLaunchers({
    tabsRef,
    activeId,
    newAgentTab,
    newGridTab,
    newDuoTab,
    splitActivePane,
    projectCwd,
  });

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  // Open a project in the current window: pin the explorer to the project
  // folder (so the file tree stays put even when a shell `cd`s elsewhere) and
  // spawn a terminal tab rooted there. The pin — not the active terminal's cwd
  // — now governs the explorer root (see useWorkspaceCwd), which is what keeps
  // the left sidebar fixed on the project.
  const openProject = useCallback(
    (project: Project) => {
      if (!isRemote(project.path)) {
        setPinnedExplorerRoot(project.path.replace(/\\/g, "/"));
      }
      cdInNewTab(project.path);
    },
    [cdInNewTab],
  );

  // Open a project's detail page in a main-area tab (focuses an existing one).
  const openProjectDetail = useCallback(
    (project: Project) => {
      openProjectDetailTab({ projectId: project.id, title: project.name });
    },
    [openProjectDetailTab],
  );

  // Folder right-click → "Add to Projects". If the folder is already a project,
  // focus its detail tab instead of re-adding; otherwise open the add dialog.
  const handleAddToProjects = useCallback(
    (path: string) => {
      const store = useProjectsStore.getState();
      const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const existing = store.projects.find(
        (p) => p.path.replace(/\\/g, "/").replace(/\/+$/, "") === norm,
      );
      if (existing) {
        openProject(existing);
        return;
      }
      setAddProjectPath(path);
    },
    [openProject],
  );

  const {
    remoteRoot,
    remoteAlias,
    connectSsh,
    openNewTab,
    exitRemote,
    unbindRemoteLeaf,
  } = useRemoteSession({
    newAgentTab,
    newTab,
    inheritedCwdForNewTab,
    persistSidebarView,
  });

  // Switching to a different local/WSL workspace tears down all live sessions,
  // drops any remote browse, and re-roots the explorer at the new home.
  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv) => {
      if (
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (workspaceEnv.kind === "wsl" && env.distro === workspaceEnv.distro))
      ) {
        return;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert("Save or close unsaved editor tabs before switching workspace.");
        return;
      }

      let nextHome: string | null = null;
      try {
        if (env.kind === "wsl") {
          nextHome = await getWslHome(env.distro);
        } else {
          nextHome = (await homeDir()).replace(/\\/g, "/");
        }
      } catch (e) {
        window.alert(String(e));
        return;
      }

      for (const id of liveLeavesRef.current) disposeSession(id);
      searchAddons.current.clear();
      terminalRefs.current.clear();
      editorRefs.current.clear();
      previewRefs.current.clear();
      setActiveSearchAddon(null);
      setActiveEditorHandle(null);
      // Leaving for a new workspace drops any active remote-browse session.
      exitRemote();
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      if (nextHome) {
        try {
          await native.workspaceAuthorize(nextHome);
        } catch {
          // Non-fatal — git panel will surface "not authorized" if needed.
        }
      }
      resetWorkspace(nextHome ?? undefined);
    },
    [workspaceEnv, setWorkspaceEnv, resetWorkspace, exitRemote],
  );

  const {
    handleOpenFile,
    openDataPreview,
    openMarkdownPreview,
    handlePathRenamed,
    handlePathDeleted,
    pendingDeleteTabs,
    confirmDeleteClose,
    cancelDeleteClose,
  } = useFileOpen({
    tabs,
    openFileTab,
    newDataTab,
    newImageTab,
    newLogTab,
    newMarkdownTab,
    updateTab,
    disposeTab,
  });

  useLaunchFile(handleOpenFile);

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = (() => {
    if (activeTab?.kind === "terminal") {
      return activeTerminalLeafCwd ?? explorerRoot ?? workspaceFallbackPath;
    }
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    if (activeTab?.kind === "git-history") return activeTab.repoRoot;
    return explorerRoot ?? workspaceFallbackPath;
  })();
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  const sourceControlActive =
    hasOpenGitTab || sidebarView === "source-control";
  // Stable per-window path so switching tabs / cd-ing in a shell does NOT
  // re-fire git IPC for the badge. Prefer the explorer root (the project this
  // window actually shows — matches the breadcrumb/title) over the process
  // launch cwd, which can differ from the open project when a project window
  // is restored at a path other than where the app started. The active panel
  // resolves the current context path on its own when the user opens git.
  const badgeContextPath = explorerRoot ?? workspaceFallbackPath;
  const sourceControlPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  const sourceControl = useSourceControl(sourceControlPath, true);

  const { toggleSourceControl, openGitGraphFromContext } =
    useSourceControlActions({
      sourceControl,
      sourceControlContextPath,
      openCommitHistoryTab,
      cycleSidebarView,
    });

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  // Command-palette action: add the window's current folder (active terminal
  // cwd, else the explorer root) to Projects. No-op when nothing resolves.
  const addCurrentFolderToProjects = useCallback(() => {
    const path = activeTerminalLeafCwd ?? explorerRoot;
    if (path) handleAddToProjects(path);
  }, [activeTerminalLeafCwd, explorerRoot, handleAddToProjects]);

  const shortcutHandlers = useAppShortcuts({
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
    toggleSidebar,
    toggleRightSidebar,
    toggleExplorerFocus,
    zoomIn,
    zoomOut,
    zoomReset,
    setNewEditorOpen,
    setCommandPopupOpen,
    setShortcutsOpen,
  });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(id, h);
      else editorRefs.current.delete(id);
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = useCallback(
    (tabId: number, leafId: number) => {
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );

  const onActivateLocalAgent = useCallback(() => {
    openPanel();
    focusInput(null);
  }, [openPanel, focusInput]);

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      // If the ssh leaf driving remote cwd tracking exits, drop the binding so
      // a stale nonce can't be reused by a later leaf that reuses the id.
      unbindRemoteLeaf(leafId);
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      const isLast =
        leafIds(tab.paneTree).length === 1 &&
        all.filter((t) => t.kind === "terminal").length === 1;
      if (isLast) {
        void respawnSession(leafId, tab.cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf, unbindRemoteLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  useLiveBridge({
    tabs,
    activeId,
    explorerRoot,
    launchCwd,
    home,
    terminalRefs,
    openPreviewTab,
    newAgentTab,
    setLive,
  });

  const workspaceSurface = (
    <TabStackRouter
      tabs={tabs}
      editorTabs={editorTabs}
      previewTabs={previewTabs}
      markdownTabs={markdownTabs}
      imageTabs={imageTabs}
      logTabs={logTabs}
      dataTabs={dataTabs}
      aiDiffTabs={aiDiffTabs}
      gitDiffTabs={gitDiffTabs}
      gitHistoryTabs={gitHistoryTabs}
      dockerDetailTabs={dockerDetailTabs}
      activeId={activeId}
      activeKind={activeTab?.kind}
      registerTerminalHandle={registerTerminalHandle}
      onSearchReady={handleSearchReady}
      onTerminalCwd={handleTerminalCwd}
      onLeafExit={handleLeafExit}
      onFocusLeaf={handleFocusLeaf}
      onClosePane={closePaneByLeaf}
      registerEditorHandle={registerEditorHandle}
      onEditorDirty={handleEditorDirty}
      onCloseEditorTab={disposeTab}
      registerPreviewHandle={registerPreviewHandle}
      onPreviewUrl={handlePreviewUrl}
      onApprovalRespond={respondToApproval}
      onOpenCommitFile={openCommitFileDiffTab}
      onGitHistorySearchHandle={setGitHistoryHandle}
      onOpenProject={openProject}
      onOpenProjectDetail={openProjectDetail}
    />
  );

  const workspacePanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">{workspaceSurface}</div>

      {keysLoaded ? (
        <motion.div
          data-ai-input-bar
          initial={false}
          animate={{
            height: panelOpen ? "auto" : 0,
            opacity: panelOpen ? 1 : 0,
          }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
          aria-hidden={!panelOpen}
        >
          {hasComposer ? (
            <AiInputBar />
          ) : (
            <AiInputBarConnect
              onAdd={() => void openSettingsWindow("models")}
            />
          )}
        </motion.div>
      ) : null}
    </div>
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <Header
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={openNewTab}
            onNewPrivate={openNewPrivateTab}
            onNewPreview={() => openPreviewTab("")}
            onNewEditor={() => setNewEditorOpen(true)}
            onNewGitGraph={openGitGraphFromContext}
            onOpenClaude={openClaudeNewTab}
            onOpenGemini={openGeminiNewTab}
            onOpenBunqueue={() => openBunqueueTab()}
            onOpenAnalytics={() => openAnalyticsTab()}
            onOpenOtel={() => openOtelTab()}
            onOpenCcusage={() => openCcusageTab()}
            onClose={handleClose}
            onPin={pinTab}
            onReorder={reorderTab}
            onToggleSidebar={toggleSidebar}
            onToggleRightSidebar={toggleRightSidebar}
            onSplit={splitActivePaneInActiveTab}
            canSplit={
              activeTerminalTab !== null &&
              leafIds(activeTerminalTab.paneTree).length < MAX_PANES_PER_TAB
            }
            onActivateAgent={onActivateAgent}
            onActivateLocalAgent={onActivateLocalAgent}
            onOpenSettings={() => void openSettingsWindow()}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
          />

          <AppLayout
            sidebarsAnimating={sidebarsAnimating}
            sidebarRef={sidebarRef}
            startSidebarCollapsed={startSidebarsCollapsedRef.current}
            sidebarWidth={sidebarWidthRef.current}
            onSidebarResize={persistSidebarWidth}
            rightSidebarRef={rightSidebarRef}
            onRightSidebarResize={persistRightSidebarWidth}
            sidebar={
              <AppSidebar
                view={sidebarView}
                onSelectView={persistSidebarView}
                explorerRef={explorerRef}
                isProject={isProjectWindow}
                rootPath={remoteRoot ?? explorerRoot}
                remoteActive={remoteRoot !== null}
                remoteAlias={remoteAlias}
                sourceControl={sourceControl}
                onOpenFile={handleOpenFile}
                onPathRenamed={handlePathRenamed}
                onPathDeleted={handlePathDeleted}
                onRevealInTerminal={cdInNewTab}
                onAttachToAgent={handleAttachFileToAgent}
                onOpenMarkdownPreview={openMarkdownPreview}
                onOpenDataPreview={openDataPreview}
                onAddToProjects={handleAddToProjects}
                onExitRemote={exitRemote}
                onConnectSsh={connectSsh}
                onOpenContainer={openDockerDetailTab}
                onOpenProject={openProject}
                onOpenS3Browser={() => openS3Tab()}
                onOpenDiff={openGitDiffTab}
                onOpenGitGraph={openGitGraphFromContext}
              />
            }
            workspace={workspacePanel}
            rightSidebar={
              <AppRightSidebar
                view={rightSidebarView}
                onSelectView={selectRightSidebarView}
                hasComposer={hasComposer}
              />
            }
          />

          <StatusBar
            cwd={activeCwd}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onWorkspaceChange={switchWorkspace}
            onOpenMini={openMini}
            hasComposer={hasComposer}
            privateActive={
              activeTab?.kind === "terminal" && activeTab.private === true
            }
            sourceControl={sourceControl}
            onOpenSourceControl={toggleSourceControl}
            onOpenTask={openTaskInSidebar}
          />

          <AppBridges
            tabs={tabs}
            activeId={activeId}
            onActivateAgent={onActivateAgent}
            hasComposer={hasComposer}
            miniOpen={miniOpen}
            askPopup={askPopup}
            onAskFromSelection={onAskFromSelection}
            onDismissAskPopup={() => setAskPopup(null)}
            openAiDiffTab={openAiDiffTab}
            closeAiDiffTab={closeAiDiffTab}
          />

          <AppDialogs
            tabs={tabs}
            shortcutsOpen={shortcutsOpen}
            onShortcutsOpenChange={setShortcutsOpen}
            commandPopupOpen={commandPopupOpen}
            onCommandPopupOpenChange={setCommandPopupOpen}
            shortcutHandlers={shortcutHandlers}
            newEditorOpen={newEditorOpen}
            onNewEditorOpenChange={setNewEditorOpen}
            newEditorRootPath={explorerRoot ?? home}
            onEditorCreated={(path) => openFileTab(path)}
            addProjectPath={addProjectPath}
            onAddProjectOpenChange={(open) => !open && setAddProjectPath(null)}
            onAddProjectSubmit={(project) => {
              useProjectsStore.getState().upsert(project);
              openProject(project);
            }}
            pendingCloseTab={pendingCloseTab}
            onConfirmClose={confirmClose}
            onCancelClose={cancelClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onConfirmDeleteClose={confirmDeleteClose}
            onCancelDeleteClose={cancelDeleteClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
