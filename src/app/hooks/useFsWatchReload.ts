import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Tab } from "@/modules/tabs";
import type { EditorPaneHandle } from "@/modules/editor";
import { listenFsChanged, parentDir, watchAdd, watchRemove } from "@/modules/explorer/lib/watch";

type UseFsWatchReloadArgs = {
  tabs: Tab[];
  /** Live ref to the open tabs, read by the event listeners (which capture once). */
  tabsRef: React.RefObject<Tab[]>;
  /** App-owned editor handle map; `.reload()` is called on external file change. */
  editorRefs: React.RefObject<Map<number, EditorPaneHandle>>;
};

/**
 * Keeps open editor tabs in sync with on-disk changes made outside the editor:
 *
 * - `fs:file-written` (non-editor source) → reload the matching editor tab.
 * - Maintains directory watches for every open editor's parent dir.
 * - `listenFsChanged` (watcher events) → reload editor tabs whose file changed.
 *
 * Saves from the editor itself tag `source: "editor"` and are ignored here to
 * avoid a reload echo. Paths are normalized to forward slashes before compare
 * (Windows emits backslashes).
 */
export function useFsWatchReload({
  tabs,
  tabsRef,
  editorRefs,
}: UseFsWatchReloadArgs) {
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written",
      (event) => {
        if (event.payload.source === "editor") return;
        const normalizedPath = event.payload.path.replace(/\\/g, "/");
        const currentTabs = tabsRef.current;
        for (const t of currentTabs) {
          if (t.kind !== "editor") continue;
          if (t.path.replace(/\\/g, "/") === normalizedPath) {
            editorRefs.current.get(t.id)?.reload();
          }
        }
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tabsRef, editorRefs]);
}
