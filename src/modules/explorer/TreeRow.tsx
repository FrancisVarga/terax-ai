import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useState } from "react";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import type { useFileTree } from "./lib/useFileTree";

type Tree = ReturnType<typeof useFileTree>;

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  rootPath: string;
  tree: Tree;
  isSelected: boolean;
  isRenaming: boolean;
  /** Git-ignored: the row is dimmed to de-emphasize untracked/ignored paths. */
  ignored: boolean;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onOpenMarkdownPreview?: (path: string) => void;
  onOpenDataPreview?: (path: string) => void;
  onAddToProjects?: (path: string) => void;
};

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function isDataPath(path: string): boolean {
  return /\.(sqlite|sqlite3|db|csv|parquet|pq)$/i.test(path);
}

function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    rootPath,
    tree,
    isSelected,
    isRenaming,
    ignored,
    onOpenFile,
    onSelectPath,
    onRevealInTerminal,
    onAttachToAgent,
    onOpenMarkdownPreview,
    onOpenDataPreview,
    onAddToProjects,
  } = props;

  const [isConfirming, setIsConfirming] = useState(false);
  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  // Folders render at 24px; files at half that (12px) so the colored folder art
  // stays prominent while file-type glyphs read as secondary. The glyph column
  // width stays 24px (centered) so icon centers align down the tree.
  const iconSize = "size-6";
  const glyphSize = isDir ? "size-6" : "size-[17px]";
  const createTarget = isDir ? path : path.slice(0, path.lastIndexOf("/")) || rootPath;
  const paddingLeft = 6 + depth * 12;

  const handleClick = () => {
    if (tree.renaming) return;
    onSelectPath(path);
    if (isDir) tree.toggle(path);
    else onOpenFile(path);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {isRenaming ? (
          <div
            className="flex h-8 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
            style={{ paddingLeft }}
          >
            <span className="size-4 shrink-0" />
            {iconUrl ? (
              <span className={cn(iconSize, "flex shrink-0 items-center justify-center")}>
                <img src={iconUrl} alt="" className={cn(glyphSize, "object-contain")} />
              </span>
            ) : (
              <span className="size-6 shrink-0" />
            )}
            <InlineInput
              initial={name}
              onCommit={tree.commitRename}
              onCancel={tree.cancelRename}
            />
          </div>
        ) : (
          <button
            type="button"
            data-fs-path={path}
            onClick={handleClick}
            onDoubleClick={() => !isDir && tree.beginRename(path)}
            className={cn(
              "group flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground/85 outline-none transition-colors hover:bg-accent/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
              isSelected && "bg-accent text-foreground",
              // Dim git-ignored entries (text + icon). Hover restores legibility.
              ignored && "opacity-45 hover:opacity-100",
            )}
            style={{ paddingLeft }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              {isDir ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={16}
                  strokeWidth={2.25}
                  className={cn(
                    "transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            <span className={cn(iconSize, "flex shrink-0 items-center justify-center")}>
              {iconUrl ? (
                <img src={iconUrl} alt="" className={cn(glyphSize, "object-contain")} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={COMPACT_CONTENT}
        onCloseAutoFocus={(e) => {
          if (tree.renaming || tree.pendingCreate) e.preventDefault();
        }}
      >
        {!isDir && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(path, true)}
          >
            Open
          </ContextMenuItem>
        )}
        {!isDir && isMarkdownPath(path) && onOpenMarkdownPreview && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenMarkdownPreview(path)}
          >
            Open Preview
          </ContextMenuItem>
        )}
        {!isDir && isDataPath(path) && onOpenDataPreview && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenDataPreview(path)}
          >
            Preview Data
          </ContextMenuItem>
        )}
        {isDir && onAddToProjects && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onAddToProjects(path)}
          >
            Add to Projects
          </ContextMenuItem>
        )}
        {isDir && onRevealInTerminal && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onRevealInTerminal(path)}
          >
            Open in Terminal
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void revealInFinder(path)}
        >
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "file")}
        >
          New File
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "dir")}
        >
          New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(path)}
        >
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(relativePath(rootPath, path))}
        >
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => onAttachToAgent?.(path)}
        >
          Attach to Agent
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          variant="destructive"
          onSelect={(e) => {
            e.preventDefault();
            if (isConfirming) {
              void tree.deletePath(path);
            } else {
              setIsConfirming(true);
            }
          }}
          onMouseLeave={() => setTimeout(() => setIsConfirming(false), 1500)}
        >
          {isConfirming ? "Click again to confirm" : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({ depth, kind, onCommit, onCancel }: PendingRowProps) {
  return (
    <div
      className="flex h-8 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-6 shrink-0" />
      <span className="flex size-6 shrink-0 items-center justify-center">
        <img
          src={kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")}
          alt=""
          className={cn(kind === "dir" ? "size-6" : "size-[17px]", "object-contain opacity-70")}
        />
      </span>
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
