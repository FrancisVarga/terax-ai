import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Tab } from "@/modules/tabs";
import { CommandPopup } from "@/modules/command-popup";
import { NewEditorDialog } from "@/modules/editor";
import { AddProjectDialog, type Project } from "@/modules/projects";
import { ShortcutsDialog, type ShortcutHandlers } from "@/modules/shortcuts";
import { UpdaterDialog } from "@/modules/updater";

type AppDialogsProps = {
  tabs: Tab[];

  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;

  commandPopupOpen: boolean;
  onCommandPopupOpenChange: (open: boolean) => void;
  shortcutHandlers: ShortcutHandlers;

  newEditorOpen: boolean;
  onNewEditorOpenChange: (open: boolean) => void;
  newEditorRootPath: string | null;
  onEditorCreated: (path: string) => void;

  addProjectPath: string | null;
  onAddProjectOpenChange: (open: boolean) => void;
  onAddProjectSubmit: (project: Project) => void;

  /** Editor tab pending an unsaved-changes close confirmation (null = closed). */
  pendingCloseTab: number | null;
  onConfirmClose: () => void;
  onCancelClose: () => void;

  /** Deleted-on-disk dirty tabs pending a close-anyway confirmation. */
  pendingDeleteTabs: number[] | null;
  onConfirmDeleteClose: () => void;
  onCancelDeleteClose: () => void;
};

/**
 * All modal surfaces of the app: shortcuts help, command palette, new-editor and
 * add-project dialogs, the auto-updater dialog, and the two unsaved-changes alert
 * dialogs (close + deleted-on-disk). Extracted from App.tsx.
 */
export function AppDialogs({
  tabs,
  shortcutsOpen,
  onShortcutsOpenChange,
  commandPopupOpen,
  onCommandPopupOpenChange,
  shortcutHandlers,
  newEditorOpen,
  onNewEditorOpenChange,
  newEditorRootPath,
  onEditorCreated,
  addProjectPath,
  onAddProjectOpenChange,
  onAddProjectSubmit,
  pendingCloseTab,
  onConfirmClose,
  onCancelClose,
  pendingDeleteTabs,
  onConfirmDeleteClose,
  onCancelDeleteClose,
}: AppDialogsProps) {
  return (
    <>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={onShortcutsOpenChange} />

      <CommandPopup
        open={commandPopupOpen}
        onOpenChange={onCommandPopupOpenChange}
        handlers={shortcutHandlers}
      />

      <NewEditorDialog
        open={newEditorOpen}
        onOpenChange={onNewEditorOpenChange}
        rootPath={newEditorRootPath}
        onCreated={onEditorCreated}
      />

      <AddProjectDialog
        open={addProjectPath !== null}
        onOpenChange={onAddProjectOpenChange}
        path={addProjectPath}
        onSubmit={onAddProjectSubmit}
      />

      <UpdaterDialog />

      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => !open && onCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {tabs.find((t) => t.id === pendingCloseTab)?.title
                ? `"${
                    tabs.find((t) => t.id === pendingCloseTab)?.title
                  }" has unsaved changes. Close anyway?`
                : "This file has unsaved changes. Close anyway?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteTabs !== null}
        onOpenChange={(open) => !open && onCancelDeleteClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTabs?.length === 1
                ? (() => {
                    const title = tabs.find(
                      (t) => t.id === pendingDeleteTabs[0],
                    )?.title;
                    return title
                      ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                      : "This file has unsaved changes. The file has been deleted. Close anyway?";
                  })()
                : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelDeleteClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
