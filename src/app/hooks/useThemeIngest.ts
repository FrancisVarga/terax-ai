import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Tab } from "@/modules/tabs";
import { setThemeId as persistThemeId } from "@/modules/settings/store";
import { listCustomThemes, saveCustomTheme } from "@/modules/theme/customThemes";
import {
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "@/modules/theme/themeFiles";
import { currentWorkspaceEnv } from "@/modules/workspace";

type UseThemeIngestArgs = {
  /** Live ref to the open tabs, read to detect whether a theme file is already open. */
  tabsRef: React.RefObject<Tab[]>;
  /** Opens (or focuses) an editor tab for the given file path. */
  openFileTab: (path: string) => void;
};

/**
 * Wires the two-way bridge between the theme store and the code editor:
 *
 * - When the user saves an edited theme file, re-ingest it into the custom-theme
 *   store so the change applies live.
 * - When something requests editing a theme (`onThemeEdit`), materialize the
 *   theme file on disk and open it in the editor.
 */
export function useThemeIngest({ tabsRef, openFileTab }: UseThemeIngestArgs) {
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written",
      (event) => {
        if (event.payload.source !== "editor") return;
        if (!isThemeFilePath(event.payload.path)) return;
        void (async () => {
          try {
            const res = await invoke<{ kind: string; content?: string }>(
              "fs_read_file",
              { path: event.payload.path, workspace: currentWorkspaceEnv() },
            );
            if (res.kind !== "text" || typeof res.content !== "string") return;
            const parsed = parseThemeFile(res.content);
            if (!parsed.ok) {
              console.warn("[terax] theme not applied:", parsed.error);
              return;
            }
            await saveCustomTheme(parsed.theme);
          } catch (e) {
            console.warn("[terax] theme ingest failed:", e);
          }
        })();
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    void onThemeEdit(async (req) => {
      const theme =
        req.action === "create"
          ? starterTheme()
          : (await listCustomThemes()).find((t) => t.id === req.id);
      if (!theme) return;
      if (req.action === "create") await saveCustomTheme(theme);
      const path = await themeFilePath(theme.id);
      const open = tabsRef.current.some(
        (t) => t.kind === "editor" && t.path === path,
      );
      if (!open) await writeThemeFile(theme);
      void persistThemeId(theme.id);
      openFileTab(path);
      void getCurrentWebviewWindow().setFocus();
    }).then((fn) => {
      if (alive) unsub = fn;
      else fn();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [tabsRef, openFileTab]);
}
