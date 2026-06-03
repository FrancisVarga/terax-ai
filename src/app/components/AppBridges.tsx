import { AnimatePresence } from "motion/react";
import type { Tab } from "@/modules/tabs";
import { AgentNotificationsBridge } from "@/modules/agents";
import { Toaster } from "@/components/ui/sonner";
import {
  AgentRunBridge,
  AiMiniWindow,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
} from "@/modules/ai";

type AskPopup = { x: number; y: number } | null;

type AppBridgesProps = {
  tabs: Tab[];
  activeId: number;
  onActivateAgent: (tabId: number, leafId: number) => void;
  hasComposer: boolean;
  miniOpen: boolean;
  askPopup: AskPopup;
  onAskFromSelection: () => void;
  onDismissAskPopup: () => void;
  openAiDiffTab: Parameters<typeof AgentRunBridge>[0]["openAiDiffTab"];
  closeAiDiffTab: Parameters<typeof AgentRunBridge>[0]["closeAiDiffTab"];
};

/**
 * Non-layout app chrome: agent/composer notification bridges, the toast host,
 * and the animated mini-window + "Ask AI" selection popup. Rendered as overlay
 * siblings to the main layout. Extracted from App.tsx.
 */
export function AppBridges({
  tabs,
  activeId,
  onActivateAgent,
  hasComposer,
  miniOpen,
  askPopup,
  onAskFromSelection,
  onDismissAskPopup,
  openAiDiffTab,
  closeAiDiffTab,
}: AppBridgesProps) {
  return (
    <>
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
            onDismiss={onDismissAskPopup}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
