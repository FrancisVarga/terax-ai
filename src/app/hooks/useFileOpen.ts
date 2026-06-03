import { useCallback, useState } from "react";
import type { Tab } from "@/modules/tabs";
import { dataFormatForPath } from "@/modules/data";
import { isRemote } from "@/modules/explorer/lib/remote";

// `dataFormatForPath` returns `DataTab["format"] | null`; the non-null half is
// exactly what `newDataTab` accepts. Derive it rather than re-importing.
type DataFormat = NonNullable<ReturnType<typeof dataFormatForPath>>;

// File-extension routing for the smart open handler. Raster + vector images go
// to the image viewer; `.log` files go to the colorized log viewer.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const LOG_RE = /\.log$/i;
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;

type UseFileOpenArgs = {
  tabs: Tab[];
  openFileTab: (path: string, pin: boolean) => void;
  newDataTab: (path: string, format: DataFormat) => void;
  newImageTab: (path: string) => void;
  newLogTab: (path: string) => void;
  newMarkdownTab: (path: string) => void;
  updateTab: (id: number, patch: { path?: string; title?: string }) => void;
  /** Close a tab and prune its app-owned handles. */
  disposeTab: (id: number) => void;
};

/**
 * Smart file-open routing plus path rename/delete reconciliation across open
 * tabs. Extracted from App.tsx; owns the `pendingDeleteTabs` confirm state for
 * the "deleted-but-dirty" dialog (App renders the dialog from the returned
 * state). See the inline comments for per-extension routing rationale.
 */
export function useFileOpen({
  tabs,
  openFileTab,
  newDataTab,
  newImageTab,
  newLogTab,
  newMarkdownTab,
  updateTab,
  disposeTab,
}: UseFileOpenArgs) {
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Remote (`ssh://`) files open in the text editor, which reads/writes
      // over SFTP via useDocument. The specialized viewers (data grid, image,
      // log, markdown preview) read the local filesystem only, so remote files
      // skip them and open as editable text — the common case for SSH editing.
      if (isRemote(path)) {
        openFileTab(path, pin ?? false);
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

  // Context-menu "Preview Data" — same destination as a click on a data file,
  // exposed explicitly so the action is discoverable.
  const openDataPreview = useCallback(
    (path: string) => {
      const format = dataFormatForPath(path);
      if (format) newDataTab(path, format);
    },
    [newDataTab],
  );

  const openMarkdownPreview = useCallback(
    (path: string) => {
      newMarkdownTab(path);
    },
    [newMarkdownTab],
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

  return {
    handleOpenFile,
    openDataPreview,
    openMarkdownPreview,
    handlePathRenamed,
    handlePathDeleted,
    pendingDeleteTabs,
    confirmDeleteClose,
    cancelDeleteClose,
  };
}
