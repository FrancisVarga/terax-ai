import type { Tab } from "@/modules/tabs";
import {
  PaneTreeView,
  hasSession,
  leafIds,
  markDeferredLeaf,
  markRmuxLeaf,
  reattachSession,
  unmarkDeferredLeaf,
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
  /**
   * Fired once a tab's `pendingAttach` daemon pane has been wired into its leaf
   * (success or failure — either way the pending intent is consumed). The parent
   * clears the tab's `pendingAttach` field so a re-render never re-triggers it.
   */
  onAttached?: (tabId: number, leafId: number) => void;
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
      onAttached,
    },
    ref,
  ) {
  const terminals = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  // Leaves awaiting a daemon-pane reattach: leafId -> { tabId, daemonPaneId }.
  // Built from the tabs that still carry a `pendingAttach`; the target leaf is
  // the tab's active leaf (an rmux attach tab opens single-leaf). getBundle reads
  // this to DEFER the leaf's eager pty open BEFORE the pane mounts (so
  // reattachSession can win the race), and an effect below performs the reattach.
  const pending = useMemo(() => {
    const m = new Map<number, { tabId: number; daemonPaneId: number }>();
    for (const t of terminals) {
      if (t.rmux && t.pendingAttach !== undefined) {
        m.set(t.activeLeafId, { tabId: t.id, daemonPaneId: t.pendingAttach });
      }
    }
    return m;
  }, [terminals]);

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  const attachedRef = useRef(onAttached);
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
  useEffect(() => {
    attachedRef.current = onAttached;
  }, [onAttached]);

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
      // If this leaf is attach-destined, ALSO suppress its eager pty open here —
      // before the pane mounts — so the reattach below wins the race instead of
      // a fresh local shell. getBundle runs during render (ahead of child mount),
      // which is the only window where this can land before openPtyEagerly fires.
      // The reattach effect lifts the deferral (via reattachSession).
      if (pending.has(leafId)) markDeferredLeaf(leafId);
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

  // Drive the pending reattaches. For each leaf whose tab still carries a
  // pendingAttach, wire the daemon pane in once the leaf has mounted, then notify
  // the parent to clear the field. `attempted` dedupes: the effect re-runs on
  // every tabs change (cwd at keystroke rate), but each leaf is reattached once.
  //
  // We do NOT gate on whenSessionReady here: a deferred leaf has no pty, so its
  // OSC 133;B prompt marker never fires and that wait would only resolve on the
  // 4s timeout. reattachSession needs only the session OBJECT (created the moment
  // the pane mounts), so we retry on a rAF until it exists, then attach. The
  // deferral (set in getBundle) keeps the local eager-open suppressed meanwhile.
  const attempted = useRef(new Set<number>());
  useEffect(() => {
    for (const [leafId, { tabId, daemonPaneId }] of pending) {
      if (attempted.current.has(leafId)) continue;
      attempted.current.add(leafId);
      let tries = 0;
      const tryAttach = () => {
        void (async () => {
          // reattachSession resolves false when the session isn't there yet
          // (pane not mounted) OR on a genuine failure; only the "not mounted"
          // case is retryable, bounded so a never-mounting leaf can't spin.
          const ok = await reattachSession(leafId, daemonPaneId);
          // Retry ONLY while the pane hasn't mounted yet (no session object);
          // once it exists, reattachSession has either attached or fallen back to
          // a local shell, so we stop and clear the pending field.
          if (!ok && tries < 60 && !hasSession(leafId)) {
            tries++;
            requestAnimationFrame(tryAttach);
            return;
          }
          // Consumed (attached, failed-with-fallback, or gave up): clear the
          // tab's pendingAttach so a re-render never re-enters this path.
          attachedRef.current?.(tabId, leafId);
        })();
      };
      tryAttach();
    }
  }, [pending]);

  // Drop every rmux mark this stack owns when it unmounts, so a leaf id reused
  // by the in-process TerminalStack later does not inherit detach-on-close.
  useEffect(() => {
    const map = bundles.current;
    return () => {
      for (const id of map.keys()) {
        unmarkRmuxLeaf(id);
        // A leaf still mid-defer (its attach never completed) must not leave the
        // shared deferral set dirty, or a reused leaf id would stay blank.
        unmarkDeferredLeaf(id);
      }
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
