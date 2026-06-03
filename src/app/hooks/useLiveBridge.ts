import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  injectCommand,
  writeToSession,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { redactSensitive } from "@/modules/ai/lib/redact";
import type { Live } from "@/modules/ai/store/chatStore";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";

type TuiWaitResult = "ready" | "gone" | "timeout";

async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 8000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    if (buf.includes("shortcuts") || buf.includes("? for")) return "ready";
    await new Promise((r) => setTimeout(r, 120));
  }
  return "timeout";
}

type UseLiveBridgeArgs = {
  tabs: Tab[];
  activeId: number;
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  /** App-owned terminal handle map (shared with the dispose invariant). */
  terminalRefs: React.RefObject<Map<number, TerminalPaneHandle>>;
  openPreviewTab: (url: string) => void;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  setLive: (live: Live) => void;
};

/**
 * Wires the chatStore `live` service-locator bridge: a set of closures the AI
 * runtime calls to reach the current cwd, active terminal buffer, PTY injection,
 * and the managed-agent spawn path. Re-published whenever `tabs`/`activeId` or
 * the cwd inputs change. The terminal handle map stays App-owned and is passed
 * in (it is also pruned by the dispose invariant), never relocated here.
 */
export function useLiveBridge({
  tabs,
  activeId,
  explorerRoot,
  launchCwd,
  home,
  terminalRefs,
  openPreviewTab,
  newAgentTab,
  setLive,
}: UseLiveBridgeArgs) {
  useEffect(() => {
    const findCwd = () => {
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return (
          findLeafCwd(active.paneTree, active.activeLeafId) ??
          active.cwd ??
          null
        );
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text: string) => {
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => explorerRoot ?? launchCwd ?? home ?? null,
      getActiveFile: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openPreview: (url: string) => {
        openPreviewTab(url);
        return true;
      },
      spawnManagedAgent: (prompt: string, sessionId: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd();
        const short =
          oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        const { tabId, leafId } = newAgentTab(
          cwd ?? undefined,
          `claude · ${short}`,
        );
        useManagedAgentsStore
          .getState()
          .register({ leafId, tabId, sessionId, task: oneLine, cwd });
        const hooksReady = invoke("agent_enable_claude_hooks").catch(() => {});
        void (async () => {
          await hooksReady;
          // injectCommand sends a throwaway Enter + pause before `claude` so the
          // cold-shell first-byte drop (claude -> laude) can't eat the leading
          // `c` on a freshly spawned panel. See injectCommand.
          if (!(await injectCommand(leafId, "claude"))) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                "[terax] Claude TUI did not appear in time; aborting prompt send",
              );
            }
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          setTimeout(() => writeToSession(leafId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(leafId, "working");
        })();
        return { tabId, leafId };
      },
      readLeafBuffer: (leafId: number) => {
        const buf = terminalRefs.current.get(leafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
    });
  }, [
    setLive,
    activeId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    terminalRefs,
    openPreviewTab,
    newAgentTab,
  ]);
}
