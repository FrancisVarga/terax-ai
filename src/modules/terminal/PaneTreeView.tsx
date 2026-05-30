import { Fragment } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { SearchAddon } from "@xterm/addon-search";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { leafIds, paneTitle, type PaneNode } from "./lib/panes";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onExit: (code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  /** Close a single pane by its leaf id. Only offered when the tab is split. */
  onClosePane: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
  /**
   * Tab is split into more than one pane. Set once at the root; when true each
   * leaf gets a title bar so panes are individually identifiable. A single-pane
   * tab stays chromeless.
   */
  split?: boolean;
};

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  onClosePane,
  getBundle,
  split,
}: Props) {
  // Root call: derive split-ness once and recurse with it fixed.
  const isSplit = split ?? leafIds(node).length > 1;

  const reduceMotion = useReducedMotion();

  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <motion.div
        // A freshly split pane fades + lifts in on mount. We deliberately do
        // NOT animate the pane's WIDTH/HEIGHT: xterm's fit addon refits on every
        // container resize, so a width animation would trigger a reflow storm on
        // each frame. The Resizable layout snaps to final size instantly (no
        // refit thrash) while only the pane's opacity/translate animate — the
        // terminal canvas already sits at its final dimensions. Existing panes
        // are already mounted, so only the new leaf runs this enter.
        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown — keeps activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative flex h-full w-full flex-col"
      >
        {isSplit && (
          <div
            data-pane-titlebar={node.id}
            className={
              "group/pane-titlebar flex h-6 shrink-0 select-none items-center gap-1 border-b pl-2 pr-1 text-xs " +
              (focused
                ? "border-border bg-accent text-accent-foreground"
                : "border-border/50 bg-muted text-muted-foreground")
            }
            title={node.cwd}
          >
            <span className="min-w-0 flex-1 truncate">
              {paneTitle(node.id, node.cwd)}
            </span>
            <button
              type="button"
              aria-label="Close pane"
              title="Close pane"
              // Stop the titlebar's mousedown-capture focus handler from firing
              // (no point focusing a pane we're about to close), then close.
              onMouseDownCapture={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClosePane(node.id);
              }}
              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/pane-titlebar:opacity-100"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <TerminalPane
            leafId={node.id}
            visible={tabVisible}
            focused={focused}
            initialCwd={node.cwd}
            ref={b.setRef}
            onSearchReady={(_id, addon) => b.onSearch(addon)}
            onCwd={(_id, cwd) => b.onCwd(cwd)}
            onExit={(_id, code) => b.onExit(code)}
          />
        </div>
      </motion.div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <ResizableHandle />}
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneTreeView
              node={child}
              tabVisible={tabVisible}
              activeLeafId={activeLeafId}
              onFocusLeaf={onFocusLeaf}
              onClosePane={onClosePane}
              getBundle={getBundle}
              split={isSplit}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
