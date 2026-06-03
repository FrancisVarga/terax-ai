import { useCallback, useEffect, useState } from "react";
import type { Tab } from "@/modules/tabs";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { EditorPaneHandle } from "@/modules/editor";
import { useChatStore } from "@/modules/ai";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";

type UseAiActionsArgs = {
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  terminalRefs: React.RefObject<Map<number, TerminalPaneHandle>>;
  editorRefs: React.RefObject<Map<number, EditorPaneHandle>>;
  /** Whether any AI provider (api key or local model) is configured. */
  hasComposer: boolean;
};

/**
 * AI-composer interactions: capturing the active terminal/editor selection,
 * toggling the composer panel, attaching files/selections to the agent, and the
 * floating "Ask AI" popup that appears on a content-area text selection.
 * Extracted from App.tsx. Returns `captureActiveSelection` so App can reuse it
 * in the shortcut-disabled predicate.
 */
export function useAiActions({
  tabs,
  activeId,
  activeTab,
  terminalRefs,
  editorRefs,
  hasComposer,
}: UseAiActionsArgs) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openPanel = useChatStore((s) => s.openPanel);
  const focusInput = useChatStore((s) => s.focusInput);
  const attachSelection = useChatStore((s) => s.attachSelection);

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
  }, [tabs, activeId, terminalRefs, editorRefs]);

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

  return {
    captureActiveSelection,
    togglePanelAndFocus,
    handleAttachFileToAgent,
    askFromSelection,
    askPopup,
    setAskPopup,
    onAskFromSelection,
  };
}
