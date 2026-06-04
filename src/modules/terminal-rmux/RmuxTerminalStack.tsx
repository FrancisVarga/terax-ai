import type { Tab } from "@/modules/tabs";
import {
  PaneTreeView,
  leafIds,
  markRmuxLeaf,
  reattachSession,
  unmarkRmuxLeaf,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { DaemonPaneId } from "./lib/rmux-client";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Close a single split pane by its leaf id. */
  onClosePane: (leafId: number) => void;
};

export type RmuxTerminalStackHandle = {
  // Wire a known daemon pane (from a prior detach, or the session switcher)
  // into a mounted leaf. The leaf streams the pane's replayed ring then live
  // output. Resolves false if the leaf is gone or already attached.
  reattach: (leafId: number, daemonPaneId: DaemonPaneId) => Promise<boolean>;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onExit: (code: number) => void;
};

// Thin rmux variant of TerminalStack. It reuses every terminal primitive
// (PaneTreeView -> TerminalPane -> useTerminalSession) verbatim; the ONLY
// behavioral difference is that each leaf it owns is marked rmux on first
// appearance, so its session close() detaches the daemon pane (leaving the
// shell running) instead of killing it. A reattach handle lets the caller wire
// a known daemon pane id back into a leaf.
//
// MUST be flag-gated by the caller: only mount this when the rmux daemon is
// enabled (backend TERAX_RMUX_DAEMON=1). With the flag off, pty_open is not
// daemon-backed, so pty_detach falls through to a kill and the detach intent is
// silently lost. See modules/terminal-rmux/index.ts.
export const RmuxTerminalStack = forwardRef<RmuxTerminalStackHandle, Props>(
  function RmuxTerminalStack(
    {
      tabs,
      activeId,
      registerHandle,
      onSearchReady,
      onCwd,
      onExit,
      onFocusLeaf,
      onClosePane,
    },
    ref,
  ) {
  const terminals = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  useImperativeHandle(
    ref,
    () => ({
      reattach: (leafId: number, daemonPaneId: DaemonPaneId) =>
        reattachSession(leafId, daemonPaneId),
    }),
    [],
  );

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      // First time we see this leaf: opt it into detach-on-close BEFORE its
      // TerminalPane mounts and eagerly opens the pty, so openPtyForSession
      // reads the rmux mark and picks detach mode for that pane's close().
      markRmuxLeaf(leafId);
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onSearch: (addon) => searchReadyRef.current(leafId, addon),
        onCwd: (cwd) => cwdRef.current(leafId, cwd),
        onExit: (code) => exitRef.current(leafId, code),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals) for (const id of leafIds(t.paneTree)) live.add(id);
    const map = bundles.current;
    for (const id of map.keys()) {
      if (!live.has(id)) {
        map.delete(id);
        unmarkRmuxLeaf(id);
      }
    }
  }, [terminals]);

  // Drop every rmux mark this stack owns when it unmounts, so a leaf id reused
  // by the in-process TerminalStack later does not inherit detach-on-close.
  useEffect(() => {
    const map = bundles.current;
    return () => {
      for (const id of map.keys()) unmarkRmuxLeaf(id);
      map.clear();
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      {terminals.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{
              visibility: tabVisible ? "visible" : "hidden",
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              onClosePane={onClosePane}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
  },
);
