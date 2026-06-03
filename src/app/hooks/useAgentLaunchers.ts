import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "@/modules/tabs";
import { injectCommand } from "@/modules/terminal";

type NewAgentTab = (
  cwd: string | undefined,
  title: string,
) => { leafId: number };
type NewGridTab = (
  cwd: string | undefined,
  title: string,
) => { leafIds: readonly number[] };
type NewDuoTab = NewGridTab;
type SplitActivePane = (
  tabId: number,
  dir: "row" | "col",
  cwd?: string | undefined,
) => number | null;

type UseAgentLaunchersArgs = {
  /** Live ref to the open tabs; read to decide split-vs-new-tab. */
  tabsRef: React.RefObject<Tab[]>;
  activeId: number;
  newAgentTab: NewAgentTab;
  newGridTab: NewGridTab;
  newDuoTab: NewDuoTab;
  splitActivePane: SplitActivePane;
  /** Resolves the project/workspace root agents should launch in. */
  projectCwd: () => string | undefined;
};

/**
 * Claude/Gemini terminal launchers. Each opens an agent terminal at the project
 * root and types the CLI command once the PTY session is ready. Extracted from
 * App.tsx — see the original inline comments for the per-launcher rationale.
 */
export function useAgentLaunchers({
  tabsRef,
  activeId,
  newAgentTab,
  newGridTab,
  newDuoTab,
  splitActivePane,
  projectCwd,
}: UseAgentLaunchersArgs) {
  // Wait for a PTY leaf to be ready, then run `claude`. Shared by the
  // new-tab and split-pane launchers. Enabling hooks mirrors the managed-agent
  // spawn path so notifications work for an interactively-started session too.
  const launchClaudeInLeaf = useCallback((leafId: number) => {
    const hooksReady = invoke("agent_enable_claude_hooks").catch(() => {});
    void (async () => {
      // hooks must be installed before claude reads them; injectCommand also
      // waits for session readiness, but we still gate on hooksReady here.
      await hooksReady;
      // injectCommand sends a throwaway Enter + pause first so the cold-shell
      // first-byte drop (claude -> laude on a fresh Ctrl+Shift+T panel) can't
      // eat the leading `c`. See injectCommand for the PSReadLine rationale.
      void injectCommand(leafId, "claude");
    })();
  }, []);

  const openClaudeNewTab = useCallback(() => {
    const { leafId } = newAgentTab(projectCwd(), "claude");
    launchClaudeInLeaf(leafId);
  }, [newAgentTab, projectCwd, launchClaudeInLeaf]);

  // Gemini CLI has no managed-hook integration (unlike Claude), so its launcher
  // just opens an agent terminal at the project root and runs `gemini`.
  const launchGeminiInLeaf = useCallback((leafId: number) => {
    // Same cold-shell first-byte race as claude — injectCommand's throwaway
    // Enter + pause keeps `gemini` from losing its leading byte.
    void injectCommand(leafId, "gemini");
  }, []);

  const openGeminiNewTab = useCallback(() => {
    const { leafId } = newAgentTab(projectCwd(), "gemini");
    launchGeminiInLeaf(leafId);
  }, [newAgentTab, projectCwd, launchGeminiInLeaf]);

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
  }, [
    tabsRef,
    activeId,
    splitActivePane,
    projectCwd,
    launchClaudeInLeaf,
    openClaudeNewTab,
  ]);

  // Create a "Claude team": one tab split into a 2x2 grid, each pane running
  // claude at the project root.
  const openClaudeTeam = useCallback(() => {
    const { leafIds: gridLeaves } = newGridTab(projectCwd(), "claude team");
    for (const leafId of gridLeaves) launchClaudeInLeaf(leafId);
  }, [newGridTab, projectCwd, launchClaudeInLeaf]);

  // Claude Golden Duo: a fresh tab split into two side-by-side panes, each
  // running claude at the project root. Always opens a clean duo regardless of
  // the active tab (unlike claude.splitRight, which splits the current pane).
  const openClaudeGoldenDuo = useCallback(() => {
    const { leafIds: duoLeaves } = newDuoTab(projectCwd(), "claude duo");
    for (const leafId of duoLeaves) launchClaudeInLeaf(leafId);
  }, [newDuoTab, projectCwd, launchClaudeInLeaf]);

  return {
    launchClaudeInLeaf,
    launchGeminiInLeaf,
    openClaudeNewTab,
    openGeminiNewTab,
    openClaudeSplitRight,
    openClaudeTeam,
    openClaudeGoldenDuo,
  };
}
