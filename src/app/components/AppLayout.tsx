import type { ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "../hooks/useSidebarState";

type AppLayoutProps = {
  /** Opts the panels into a flex-grow transition during sidebar collapse/expand. */
  sidebarsAnimating: boolean;

  sidebarRef: React.RefObject<PanelImperativeHandle | null>;
  /** True when the left sidebar should mount collapsed (launch heuristic). */
  startSidebarCollapsed: boolean;
  /** Persisted left sidebar width in px (used as the expanded default size). */
  sidebarWidth: number;
  onSidebarResize: (widthPx: number) => void;

  rightSidebarRef: React.RefObject<PanelImperativeHandle | null>;
  onRightSidebarResize: (widthPx: number) => void;

  /** Left sidebar content (AppSidebar). */
  sidebar: ReactNode;
  /** Center workspace content (tab surface + AI input bar). */
  workspace: ReactNode;
  /** Right sidebar content (AppRightSidebar). */
  rightSidebar: ReactNode;
};

/**
 * The three-panel resizable frame: left sidebar | workspace | right sidebar.
 * Owns only the layout chrome (sizing, collapse, resize persistence); the panel
 * contents are passed in as slots so this component stays data-agnostic.
 * Extracted from App.tsx.
 */
export function AppLayout({
  sidebarsAnimating,
  sidebarRef,
  startSidebarCollapsed,
  sidebarWidth,
  onSidebarResize,
  rightSidebarRef,
  onRightSidebarResize,
  sidebar,
  workspace,
  rightSidebar,
}: AppLayoutProps) {
  return (
    <main className="zoom-content flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        // While a sidebar collapse/expand is in flight, opt the panels into a
        // flex-grow transition (see globals.css). Cleared right after the
        // animation so handle-drags stay instant.
        data-animating={sidebarsAnimating ? "true" : undefined}
      >
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarRef}
          defaultSize={startSidebarCollapsed ? "0px" : `${sidebarWidth}px`}
          minSize={`${SIDEBAR_MIN_WIDTH}px`}
          maxSize={`${SIDEBAR_MAX_WIDTH}px`}
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            // Only persist genuine user widths. During a collapse animation the
            // panel passes through tiny non-zero widths (e.g. 1px); those used
            // to slip past a `> 0` guard and poison the stored width, so the
            // next toggle re-opened to 1px (clamped back to collapsed → "won't
            // open"). Anything below the min is never a real width.
            if (size.inPixels >= SIDEBAR_MIN_WIDTH) onSidebarResize(size.inPixels);
          }}
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="workspace" defaultSize="60%" minSize="30%">
          {workspace}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="right-sidebar"
          panelRef={rightSidebarRef}
          // Right sidebar always starts collapsed (regardless of launch mode).
          // The user opens it on demand via the rail/shortcut; it reopens to the
          // stored width. Left sidebar still follows the launch heuristic.
          defaultSize="0px"
          minSize={`${RIGHT_SIDEBAR_MIN_WIDTH}px`}
          maxSize={`${RIGHT_SIDEBAR_MAX_WIDTH}px`}
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            // See the left sidebar's onResize: ignore sub-min widths emitted
            // mid-collapse so the stored/reopen width never decays below the min.
            if (size.inPixels >= RIGHT_SIDEBAR_MIN_WIDTH)
              onRightSidebarResize(size.inPixels);
          }}
        >
          {rightSidebar}
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
