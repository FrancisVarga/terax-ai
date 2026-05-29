import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { EDITOR_THEME_EXT } from "@/modules/editor/lib/themes";
import { useDocument } from "@/modules/editor/lib/useDocument";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { markdown } from "@codemirror/lang-markdown";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  path: string;
  visible: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * Split markdown view: editable source on the left, live-rendered preview on
 * the right. Both halves share a single `useDocument` buffer so the preview
 * tracks the editor as the user types. Mod-S saves.
 *
 * This is a deliberately lean editor (markdown highlight + save) rather than the
 * full `EditorPane`, because sharing one buffer across editor and preview is
 * what keeps the preview live — two `useDocument` instances on the same path
 * would not stay in sync.
 */
export function MarkdownSplitPane({ path, visible, onDirtyChange }: Props) {
  const { doc, onChange, save } = useDocument({ path, onDirtyChange });
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const themeExt = EDITOR_THEME_EXT[editorThemeId] ?? EDITOR_THEME_EXT.atomone;

  const saveRef = useRef(save);
  saveRef.current = save;

  const extensions = useMemo(
    () => [
      markdown(),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void saveRef.current();
            return true;
          },
        },
      ]),
    ],
    [],
  );

  const content = doc.status === "ready" ? doc.content : "";

  return (
    <div
      className={cn("h-full w-full", !visible && "pointer-events-none")}
    >
      <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
        <ResizablePanel defaultSize={50} minSize={20}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/60 bg-background">
            {doc.status === "loading" && (
              <p className="px-4 py-3 text-[12px] text-muted-foreground">
                Loading…
              </p>
            )}
            {doc.status === "error" && (
              <p className="px-4 py-3 text-[12px] text-destructive">
                {doc.message}
              </p>
            )}
            {doc.status === "ready" && (
              <CodeMirror
                value={doc.content}
                onChange={onChange}
                theme={themeExt}
                extensions={extensions}
                height="100%"
                className="flex-1 min-h-0 overflow-hidden"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  bracketMatching: true,
                  searchKeymap: true,
                }}
              />
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50} minSize={20}>
          <MarkdownPreviewPane
            path={path}
            visible={visible}
            content={content}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
