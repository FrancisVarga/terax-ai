import { native } from "@/modules/ai/lib/native";
import { useEffect, useRef, useState } from "react";
import {
  buildGitDecoration,
  emptyGitDecoration,
  sameGitDecoration,
  type GitDecoration,
} from "./gitDecoration";
import { isRemote } from "./remote";
import { listenFsChanged } from "./watch";

// Quiet-gap before a refresh fires. The Rust watcher already debounces 150ms;
// this coalesces back-to-back batches into a single `git status`.
const REFRESH_DEBOUNCE_MS = 150;
// Hard cap so a long stream of saves still repaints within ~1s.
const MAX_REFRESH_WINDOW_MS = 1000;

type IdleHandle = number;

function scheduleIdle(fn: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(fn, { timeout: 500 });
  }
  return window.setTimeout(fn, 0) as unknown as IdleHandle;
}

function cancelIdle(handle: IdleHandle): void {
  if (typeof window.cancelIdleCallback === "function") {
    try {
      window.cancelIdleCallback(handle);
      return;
    } catch {
      /* fall through to clearTimeout */
    }
  }
  window.clearTimeout(handle);
}

/**
 * Live git-status decoration for the explorer tree. Resolves the repo for the
 * current root once, then re-runs `git status` whenever the existing fs watcher
 * reports a change under that root. Returns an empty decoration for non-git or
 * remote roots so the tree renders unchanged.
 *
 * Performance contract (every change here is deliberate):
 * - The `git status` subprocess runs in Rust `spawn_blocking`, so it never
 *   touches the UI thread. This hook only awaits the IPC promise.
 * - Refreshes are coalesced (150ms quiet-gap, 1s hard cap) AND single-flight:
 *   while one status is in-flight, new fs events set a "dirty" flag instead of
 *   stacking overlapping subprocesses; one more refresh fires when it returns.
 * - Work is deferred to `requestIdleCallback`, so status never competes with
 *   typing/scrolling for a frame.
 * - The result is structurally compared: an unchanged status keeps the SAME
 *   object reference, so React/`useMemo` skip the whole tree re-render when a
 *   save didn't actually change any file's git state.
 */
export function useGitDecoration(rootPath: string | null): GitDecoration {
  const [decoration, setDecoration] = useState<GitDecoration>(
    emptyGitDecoration,
  );
  const repoRootRef = useRef<string | null>(null);
  const decorationRef = useRef<GitDecoration>(emptyGitDecoration());

  useEffect(() => {
    repoRootRef.current = null;
    decorationRef.current = emptyGitDecoration();
    setDecoration(decorationRef.current);

    if (!rootPath || isRemote(rootPath)) return;

    let alive = true;
    let unlisten: (() => void) | undefined;
    let inFlight = false;
    let dirty = false; // a change arrived while a status was running
    let debounceTimer = 0;
    let windowStart = 0;
    let idleHandle: IdleHandle | null = null;

    const apply = (next: GitDecoration) => {
      if (sameGitDecoration(decorationRef.current, next)) return;
      decorationRef.current = next;
      setDecoration(next);
    };

    const runStatus = async () => {
      if (!alive) return;
      inFlight = true;
      dirty = false;
      try {
        const snapshot = await native.gitPanelSnapshot(rootPath);
        if (!alive) return;
        repoRootRef.current = snapshot.repo?.repoRoot ?? null;
        apply(buildGitDecoration(snapshot.status ?? null));
      } catch {
        if (!alive) return;
        repoRootRef.current = null;
        apply(emptyGitDecoration());
      } finally {
        inFlight = false;
        // A change landed mid-flight: fold it into one trailing refresh.
        if (alive && dirty) scheduleRefresh();
      }
    };

    const fire = () => {
      debounceTimer = 0;
      windowStart = 0;
      if (idleHandle !== null) cancelIdle(idleHandle);
      idleHandle = scheduleIdle(() => {
        idleHandle = null;
        void runStatus();
      });
    };

    const scheduleRefresh = () => {
      // Single-flight: never overlap two `git status` calls. Mark dirty and let
      // the in-flight one re-trigger on completion.
      if (inFlight) {
        dirty = true;
        return;
      }
      const now = performance.now();
      if (!windowStart) windowStart = now;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      // Cap latency: if the burst has run past the window, fire now.
      if (now - windowStart >= MAX_REFRESH_WINDOW_MS) {
        fire();
        return;
      }
      debounceTimer = window.setTimeout(fire, REFRESH_DEBOUNCE_MS);
    };

    // Initial paint: resolve repo + status immediately (still off-thread + idle).
    fire();

    void listenFsChanged((paths) => {
      if (!alive) return;
      const repoRoot = repoRootRef.current;
      // Before the repo resolves, any change is a candidate. After, only
      // changes under the repo root matter — everything else is ignored for
      // free (the watcher's SKIP_DIRS already pruned node_modules etc.).
      if (!repoRoot) {
        scheduleRefresh();
        return;
      }
      for (const p of paths) {
        if (p === repoRoot || p.startsWith(`${repoRoot}/`)) {
          scheduleRefresh();
          return;
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });

    return () => {
      alive = false;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      if (idleHandle !== null) cancelIdle(idleHandle);
      unlisten?.();
    };
  }, [rootPath]);

  return decoration;
}
