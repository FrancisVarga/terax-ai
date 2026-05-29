import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import {
  basename,
  newProjectId,
  normalizePath,
  parseTags,
  type Project,
} from "./lib/projects";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Folder path being added (new project), forward-slash normalized. */
  path: string | null;
  /** When set, the dialog edits this existing project instead of adding one. */
  editing?: Project | null;
  onSubmit: (project: Project) => void;
};

/**
 * Add/edit form for a project. When `editing` is provided the fields are
 * pre-filled and the same id/createdAt are preserved on submit; otherwise a
 * fresh project is created for `path` with the folder basename as the default
 * name.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
  path,
  editing,
  onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const effectivePath = editing?.path ?? (path ? normalizePath(path) : "");

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setTags(editing.tags.join(", "));
      setNotes(editing.notes);
    } else {
      setName(path ? basename(normalizePath(path)) : "");
      setTags("");
      setNotes("");
    }
    setTimeout(() => {
      const el = nameRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
  }, [open, editing, path]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || !effectivePath) return;
    onSubmit({
      id: editing?.id ?? newProjectId(),
      name: trimmed,
      path: effectivePath,
      tags: parseTags(tags),
      notes: notes.trim(),
      createdAt: editing?.createdAt ?? Date.now(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon
              icon={FolderLibraryIcon}
              size={16}
              strokeWidth={1.75}
            />
            {editing ? "Edit project" : "Add to Projects"}
          </DialogTitle>
          <DialogDescription className="truncate" title={effectivePath}>
            {effectivePath || "—"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="My project"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-tags">Tags</Label>
            <Input
              id="project-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="frontend, rust, wip"
            />
            <span className="text-[11px] text-muted-foreground">
              Comma separated.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-notes">Notes</Label>
            <Textarea
              id="project-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What is this project about?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !effectivePath}>
            {editing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
