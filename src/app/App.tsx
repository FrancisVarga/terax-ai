import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFsWatchReload } from "./hooks/useFsWatchReload";
import { useLaunchFile } from "./hooks/useLaunchFile";
import { useLiveBridge } from "./hooks/useLiveBridge";
import { useThemeIngest } from "./hooks/useThemeIngest";
import {
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarState,
} from "./hooks/useSidebarState";
import { TabStackRouter } from "./TabStackRouter";
import { AgentNotificationsBridge } from "@/modules/agents";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
  AgentRunBridge,
  AiInputBar,
  AiInputBarConnect,
  AiMiniWindow,
  getAllKeys,
  hasAnyKey,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useChatStore,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import { NewEditorDialog, type EditorPaneHandle } from "@/modules/editor";
import { type GitHistorySearchHandle } from "@/modules/git-history";
import { getLaunchDir, hasExplicitLaunchDir } from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import {
  connectRemote,
  disconnectRemote,
  isRemote,
  parseRemote,
  remoteUri,
} from "@/modules/explorer/lib/remote";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { CommandPopup } from "@/modules/command-popup";
import { dataFormatForPath } from "@/modules/data";
import { S3Panel } from "@/modules/s3";
import { type PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import {
  ShortcutsDialog,
  useGlobalShortcuts,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";
import { DockerPanel } from "@/modules/docker";
import {
  AddProjectDialog,
  ProjectsPanel,
  useProjectsStore,
  type Project,
} from "@/modules/projects";
import { SidebarRail } from "@/modules/sidebar";
import {
  AgentsPanel,
  AiPanel,
  PreviewPanel,
  RightSidebarRail,
  SessionHistoryPanel,
} from "@/modules/right-sidebar";
import { TaskRunnerPanel } from "@/modules/task-runner";
import {
  SourceControlPanel,
  useSourceControl,
} from "@/modules/source-control";
import {
  SshRemotePanel,
  sshCommandFor,
  type SshHost,
} from "@/modules/ssh-remote";
import { StatusBar } from "@/modules/statusbar";
import { MAX_PANES_PER_TAB, useTabs, useWorkspaceCwd } from "@/modules/tabs";
import {
  bindRemoteCwd,
  buildRemoteCwdHookCommand,
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafIds,
  newRemoteCwdNonce,
  respawnSession,
  unbindRemoteCwd,
  whenSessionReady,
  writeToSession,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

// File-extension routing for the smart open handler. Raster + vector images go
// to the image viewer; `.log` files go to the colorized log viewer.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const LOG_RE = /\.log$/i;
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;

export default function App() {
  const {
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
    openAnalyticsTab,
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
  } = useSidebarState({ explorerRef });

  // When set (`ssh://alias/path`), the explorer browses a remote SFTP root
  // instead of the local workspace. Cleared by switching workspace or
  // disconnecting.
  const [remoteRoot, setRemoteRoot] = useState<string | null>(null);
  // Leaf id of the ssh terminal currently driving remote cwd tracking, so we
  // can unbind it on disconnect / shell exit. One active remote browse at a time.
  const remoteCwdLeafRef = useRef<number | null>(null);
  // Active SSH alias (from the remote root) so the Docker panel targets that
  // server's daemon. `null` when browsing locally → local Docker daemon.
  const remoteAlias = useMemo(
    () => (remoteRoot ? (parseRemote(remoteRoot)?.alias ?? null) : null),
    [remoteRoot],
  );
  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
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
    [workspaceEnv, setWorkspaceEnv, resetWorkspace],
  );
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

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

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

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<string>("terax:ai-attach-file", { detail: path }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      const el = e.target as HTMLElement | null;
      const inContentArea = el?.closest?.(".xterm, .cm-editor");
      if (!inContentArea) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setAskPopup({ x: e.clientX, y: e.clientY });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  // Wait for a PTY leaf to be ready, then run `claude`. Shared by the
  // new-tab and split-pane launchers. Enabling hooks mirrors the managed-agent
  // spawn path so notifications work for an interactively-started session too.
  const launchClaudeInLeaf = useCallback((leafId: number) => {
    const hooksReady = invoke("agent_enable_claude_hooks").catch(() => {});
    void (async () => {
      await Promise.all([whenSessionReady(leafId), hooksReady]);
      writeToSession(leafId, "claude\r");
    })();
  }, []);

  // Claude commands always launch at the current project/workspace root, not
  // the active pane's cwd — so "open claude" is predictable regardless of where
  // the user has cd'd inside a shell.
  const projectCwd = useCallback(
    () => explorerRoot ?? launchCwd ?? home ?? undefined,
    [explorerRoot, launchCwd, home],
  );

  const openClaudeNewTab = useCallback(() => {
    const { leafId } = newAgentTab(projectCwd(), "claude");
    launchClaudeInLeaf(leafId);
  }, [newAgentTab, projectCwd, launchClaudeInLeaf]);

  const openClaudeSplitRight = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    // Split only works inside a terminal tab; fall back to a fresh tab so the
    // command always does something useful.
    if (!t || t.kind !== "terminal") {
      openClaudeNewTab();
      return;
    }
    const leafId = splitActivePane(activeId, "row", projectCwd());
    if (leafId === null) {
      // Pane cap hit — open in a new tab instead of a silent no-op.
      openClaudeNewTab();
      return;
    }
    launchClaudeInLeaf(leafId);
  }, [activeId, splitActivePane, projectCwd, launchClaudeInLeaf, openClaudeNewTab]);

  // Create a "Claude team": one tab split into a 2x2 grid, each pane running
  // claude at the project root.
  const openClaudeTeam = useCallback(() => {
    const { leafIds: gridLeaves } = newGridTab(projectCwd(), "claude team");
    for (const leafId of gridLeaves) launchClaudeInLeaf(leafId);
  }, [newGridTab, projectCwd, launchClaudeInLeaf]);

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

  // Open a project in a fresh window rooted at its folder. The dir is passed
  // to the new window (via `?dir=`) so its default tab + explorer start there.
  const openProject = useCallback((project: Project) => {
    void invoke("open_main_window", { dir: project.path });
  }, []);

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

  // Open a fresh terminal tab and run `ssh <alias>`. We wait for the PTY
  // session to be ready (same handshake the managed-agent spawn uses) before
  // writing the command, otherwise the bytes race the shell's first prompt and
  // get swallowed.
  const connectSsh = useCallback(
    (host: SshHost, targetPath?: string) => {
      // 1. Open an interactive ssh terminal tab.
      const { leafId } = newAgentTab(undefined, `ssh · ${host.alias}`);

      // Bind this leaf for remote cwd tracking BEFORE the ssh handshake: a
      // per-leaf nonce gates the OSC 7704 hook output so only the hook we inject
      // (carrying this nonce) can move the explorer. The callback re-points the
      // remote root, so a `cd` on the server follows in the tree.
      const nonce = newRemoteCwdNonce();
      remoteCwdLeafRef.current = leafId;
      bindRemoteCwd(leafId, {
        alias: host.alias,
        nonce,
        onRemoteCwd: (uri) => setRemoteRoot(uri),
      });

      void (async () => {
        await whenSessionReady(leafId);
        // Settle the prompt before typing the ssh command. On a cold local
        // shell (notably Windows PowerShell + PSReadLine) the FIRST keystroke
        // after the prompt renders is sometimes swallowed, turning `ssh` into
        // `sh` — the connection then never opens and the follow-up hook/cd run
        // locally. A throwaway Enter + a short pause lets PSReadLine finish its
        // async init so the real command's first byte isn't lost.
        writeToSession(leafId, "\r");
        await new Promise((r) => setTimeout(r, 250));
        // Open the interactive remote shell. We type `cd` as a follow-up command
        // (rather than `ssh -t … 'cd … && exec $SHELL'`) because the remote may
        // be PowerShell, fish, etc. — a bare `cd <path>` is understood by every
        // common shell, whereas a POSIX `exec "$SHELL" -l` wrapper breaks on
        // PowerShell. `cd` runs inside whatever login shell ssh launched.
        writeToSession(leafId, `${sshCommandFor(host)}\r`);
        // Install the remote precmd hook after the ssh session is up. We can't
        // detect the remote prompt precisely (no remote integration), so wait a
        // beat past the local handshake before typing the one-liner. If remote
        // cwd sync never installs (unknown shell, slow/auth-prompting login),
        // the explorer simply stays put and the user browses manually.
        const hook = buildRemoteCwdHookCommand(nonce);
        setTimeout(() => {
          if (remoteCwdLeafRef.current === leafId) {
            writeToSession(leafId, `${hook}\r`);
            if (targetPath && targetPath !== "/") {
              writeToSession(leafId, `cd ${quoteShellArg(targetPath)}\r`);
            }
          }
        }, 1200);
      })();

      // 2. In parallel, bring up an SFTP session and point the explorer at the
      //    project path (when opening a project) or the remote home dir.
      void (async () => {
        try {
          const home = await connectRemote(host.alias);
          setRemoteRoot(
            remoteUri(host.alias, targetPath && targetPath !== "/" ? targetPath : home),
          );
          persistSidebarView("explorer");
        } catch (e) {
          console.error("[terax] SFTP connect failed:", e);
          toast.error(`SFTP: could not browse ${host.alias}`, {
            description: String(e),
          });
        }
      })();
    },
    [newAgentTab, persistSidebarView],
  );

  // Auto-connect SSH when the window was launched for a remote project
  // (`?dir=ssh://alias/path`). The local terminal can't be a remote cwd, so we
  // open an interactive `ssh <alias>` tab and cd into the project path instead.
  // Fires once on mount.
  const remoteAutoConnectedRef = useRef(false);
  useEffect(() => {
    if (remoteAutoConnectedRef.current) return;
    const launch = getLaunchDir();
    if (!launch || !isRemote(launch)) return;
    const ref = parseRemote(launch);
    if (!ref) return;
    remoteAutoConnectedRef.current = true;
    connectSsh(
      {
        alias: ref.alias,
        hostname: null,
        user: null,
        port: null,
        source: "launch",
      },
      ref.path,
    );
  }, [connectSsh]);

  const openNewTab = useCallback(() => {
    // While browsing a remote workspace, a new tab should be an ssh session on
    // that host (cd'd into the current remote dir), not a local shell.
    const ref = remoteRoot ? parseRemote(remoteRoot) : null;
    if (ref) {
      connectSsh(
        {
          alias: ref.alias,
          hostname: null,
          user: null,
          port: null,
          source: "launch",
        },
        ref.path,
      );
      return;
    }
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab, remoteRoot, connectSsh]);

  // Leave the remote view: drop the SFTP session, unbind remote cwd tracking,
  // and restore the local root.
  const exitRemote = useCallback(() => {
    if (remoteCwdLeafRef.current !== null) {
      unbindRemoteCwd(remoteCwdLeafRef.current);
      remoteCwdLeafRef.current = null;
    }
    setRemoteRoot((curr) => {
      const ref = curr ? parseRemote(curr) : null;
      if (ref) void disconnectRemote(ref.alias);
      return null;
    });
  }, []);

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Remote files can't open in the editor yet (the editor reads the local
      // filesystem). Browsing the remote tree works; opening a file is a
      // follow-on once SFTP file read/write is wired into the editor.
      if (isRemote(path)) {
        toast.info("Remote file editing isn't supported yet", {
          description: "Use the ssh terminal to view or edit remote files.",
        });
        return;
      }
      // Tabular files (sqlite/csv/parquet) open in the data-grid viewer
      // instead of the text editor. The data tab is keyed by path, so a repeat
      // click just refocuses it.
      const dataFormat = dataFormatForPath(path);
      if (dataFormat) {
        newDataTab(path, dataFormat);
        return;
      }
      // Images open in the image viewer rather than the (text) editor.
      if (IMAGE_RE.test(path)) {
        newImageTab(path);
        return;
      }
      // `.log` files open in the colorized log viewer.
      if (LOG_RE.test(path)) {
        newLogTab(path);
        return;
      }
      // Markdown opens split: editable source on the left, live preview right.
      if (MARKDOWN_RE.test(path)) {
        newMarkdownTab(path);
        return;
      }
      // Explorer defaults to preview (pin=false); explicit actions like
      // context-menu "Open" pass pin=true for a persistent tab.
      openFileTab(path, pin ?? false);
    },
    [openFileTab, newDataTab, newImageTab, newLogTab, newMarkdownTab],
  );

  useLaunchFile(handleOpenFile);

  // Context-menu "Preview Data" — same destination as a click on a data file,
  // exposed explicitly so the action is discoverable.
  const openDataPreview = useCallback(
    (path: string) => {
      const format = dataFormatForPath(path);
      if (format) newDataTab(path, format);
    },
    [newDataTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor" && t.kind !== "data") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        // Data tabs are read-only previews — close them outright on delete.
        if (t.kind === "data") {
          if (t.path === path || t.path.startsWith(`${path}/`)) {
            disposeTab(t.id);
          }
          continue;
        }
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

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
  // Stable per-session path so switching tabs / cd-ing in a shell does NOT
  // re-fire git IPC for the badge. The active panel resolves the current
  // context path on its own when the user actually opens git.
  const badgeContextPath = workspaceFallbackPath;
  const sourceControlPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  const sourceControl = useSourceControl(sourceControlPath, true);

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!sourceControlContextPath) return;
    try {
      const repo = await native.gitResolveRepo(sourceControlContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    sourceControlContextPath,
  ]);

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

  const openMarkdownPreview = useCallback(
    (path: string) => {
      newMarkdownTab(path);
    },
    [newMarkdownTab],
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
      "claude.team": openClaudeTeam,
      "window.new": () => void invoke("open_main_window"),
      "commandPopup.open": () => setCommandPopupOpen((v) => !v),
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "rightSidebar.toggle": toggleRightSidebar,
      "view.sshRemote": () => cycleSidebarView("ssh-remote"),
      "view.docker": () => cycleSidebarView("docker"),
      "view.projects": () => cycleSidebarView("projects"),
      "projects.addCurrent": addCurrentFolderToProjects,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
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
      openClaudeTeam,
      cycleSidebarView,
      addCurrentFolderToProjects,
      toggleSidebar,
      toggleRightSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (id === "editor.undo" || id === "editor.redo") {
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
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

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
      if (remoteCwdLeafRef.current === leafId) {
        unbindRemoteCwd(leafId);
        remoteCwdLeafRef.current = null;
      }
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
    [closePaneByLeaf],
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
            onOpenBunqueue={() => openBunqueueTab()}
            onOpenAnalytics={() => openAnalyticsTab()}
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

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  startSidebarsCollapsedRef.current
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div className="min-h-0 flex-1">
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={remoteRoot ?? explorerRoot}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onAttachToAgent={handleAttachFileToAgent}
                        onOpenMarkdownPreview={openMarkdownPreview}
                        onOpenDataPreview={openDataPreview}
                        onAddToProjects={handleAddToProjects}
                        onExitRemote={remoteRoot ? exitRemote : undefined}
                      />
                    ) : sidebarView === "ssh-remote" ? (
                      <SshRemotePanel onConnect={connectSsh} />
                    ) : sidebarView === "docker" ? (
                      <DockerPanel
                        host={remoteAlias}
                        onOpenContainer={openDockerDetailTab}
                      />
                    ) : sidebarView === "projects" ? (
                      <ProjectsPanel onOpenProject={openProject} />
                    ) : sidebarView === "s3" ? (
                      <S3Panel onOpenBrowser={() => openS3Tab()} />
                    ) : (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                      />
                    )}
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="60%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    {workspaceSurface}
                  </div>

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
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="right-sidebar"
                panelRef={rightSidebarRef}
                // Right sidebar always starts collapsed (regardless of launch
                // mode). The user opens it on demand via the rail/shortcut; it
                // reopens to the stored width. Left sidebar still follows the
                // launch heuristic.
                defaultSize="0px"
                minSize={`${RIGHT_SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${RIGHT_SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0)
                    persistRightSidebarWidth(size.inPixels);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card">
                  <div className="min-h-0 flex-1">
                    {rightSidebarView === "ai" ? (
                      <AiPanel
                        hasComposer={hasComposer}
                        onConnect={() => void openSettingsWindow("models")}
                      />
                    ) : rightSidebarView === "agents" ? (
                      <AgentsPanel
                        onActivate={onActivateAgent}
                        onActivateLocal={onActivateLocalAgent}
                      />
                    ) : rightSidebarView === "tasks" ? (
                      <TaskRunnerPanel />
                    ) : rightSidebarView === "history" ? (
                      <SessionHistoryPanel onActivate={onActivateAgent} />
                    ) : (
                      <PreviewPanel
                        tabs={tabs}
                        activeId={activeId}
                        onActivate={setActiveId}
                      />
                    )}
                  </div>
                  <RightSidebarRail
                    activeView={rightSidebarView}
                    onSelectView={selectRightSidebarView}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

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
          />

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <Toaster position="bottom-right" />

          {hasComposer ? (
            <>
              <AgentRunBridge
                openAiDiffTab={openAiDiffTab}
                closeAiDiffTab={closeAiDiffTab}
              />
              <LocalAgentNotificationsBridge />
            </>
          ) : null}

          <AnimatePresence>
            {miniOpen && hasComposer ? <AiMiniWindow key="ai-mini" /> : null}
            {askPopup ? (
              <SelectionAskAi
                key="ask-ai-popup"
                x={askPopup.x}
                y={askPopup.y}
                onAsk={onAskFromSelection}
                onDismiss={() => setAskPopup(null)}
              />
            ) : null}
          </AnimatePresence>

          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
          />

          <CommandPopup
            open={commandPopupOpen}
            onOpenChange={setCommandPopupOpen}
            handlers={shortcutHandlers}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <AddProjectDialog
            open={addProjectPath !== null}
            onOpenChange={(open) => !open && setAddProjectPath(null)}
            path={addProjectPath}
            onSubmit={(project) => {
              useProjectsStore.getState().upsert(project);
              openProject(project);
            }}
          />

          <UpdaterDialog />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDeleteTabs !== null}
            onOpenChange={(open) => !open && cancelDeleteClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeleteTabs?.length === 1
                    ? (() => {
                        const title = tabs.find(
                          (t) => t.id === pendingDeleteTabs[0],
                        )?.title;
                        return title
                          ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                          : "This file has unsaved changes. The file has been deleted. Close anyway?";
                      })()
                    : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelDeleteClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}
