import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  Clock01Icon,
  Coins01Icon,
  ComputerTerminal02Icon,
  ContainerIcon,
  CloudIcon,
  Database02Icon,
  DatabaseIcon,
  FolderLibraryIcon,
  GitBranchIcon,
  GitCompareIcon,
  GithubIcon,
  ServerStack02Icon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  SatelliteIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
} from "react";
import type { EditorTab, Tab } from "./lib/useTabs";

// Native HTML5 drag-and-drop handler set for a tab button. Declared explicitly
// so the per-tab `dndProps` object stays fully typed even though it's later
// spread through a cast (motion.create narrows the drag props — see usage).
type DragEventHandlers = {
  draggable: boolean;
  onDragStart: DragEventHandler<HTMLButtonElement>;
  onDragOver: DragEventHandler<HTMLButtonElement>;
  onDragLeave: DragEventHandler<HTMLButtonElement>;
  onDrop: DragEventHandler<HTMLButtonElement>;
  onDragEnd: DragEventHandler<HTMLButtonElement>;
};

// House easing — same curve the AI input bar uses in App.tsx so tab motion
// feels of-a-piece with the rest of the shell. A motion-wrapped Radix
// TabsTrigger still forwards `value`/`data-state` and the native drag props,
// so animation rides on top of selection + reorder without breaking either.
const EASE = [0.16, 1, 0.3, 1] as const;
const MotionTabsTrigger = motion.create(TabsTrigger);

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onOpenClaude: () => void;
  onOpenGemini: () => void;
  onOpenBunqueue: () => void;
  onOpenAnalytics: () => void;
  onOpenOtel: () => void;
  onOpenKv: () => void;
  onOpenCcusage: () => void;
  onOpenGithubFeed: () => void;
  onClose: (id: number) => void;
  /** Close every tab except `id` (right-click → Close others). */
  onCloseOthers: (id: number) => void;
  /** Close all tabs but the surviving home tab (right-click → Close all). */
  onCloseAll: (id: number) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Drag-reorder: move tab `fromId` into the slot of `toId`. */
  onReorder: (fromId: number, toId: number) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onOpenClaude,
  onOpenGemini,
  onOpenBunqueue,
  onOpenAnalytics,
  onOpenOtel,
  onOpenKv,
  onOpenCcusage,
  onOpenGithubFeed,
  onClose,
  onCloseOthers,
  onCloseAll,
  onPin,
  onReorder,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  // Tab id currently being dragged, and the id of the tab it's hovering over.
  // dragOverId drives the drop-indicator styling; both reset on drag end.
  const dragIdRef = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  // True when the strip can't fit every tab, so some scroll off-screen. The
  // scrollbar is hidden by design, so without this we'd leave overflow tabs
  // unreachable; it gates the "all tabs" overflow dropdown into view.
  const [isOverflowing, setIsOverflowing] = useState(false);
  // Right-click tab context menu: the tab id it targets and where to anchor it.
  // A single shared menu (rather than one per tab) keeps the per-tab
  // `MotionTabsTrigger` as AnimatePresence's direct child — wrapping each tab in
  // a Radix ContextMenu broke both tab selection and the menu's own actions.
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(
    null,
  );

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Track overflow so the jump-to-tab dropdown only appears when it's needed.
  // ResizeObserver on the scroll container catches both window resizes and the
  // content growing/shrinking as tabs open and close.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setIsOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [tabs.length]);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            <AnimatePresence initial={false}>
            {tabs.map((t) => {
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;
              // Native HTML5 drag-reorder handlers. Kept in a plain object and
              // spread through `dndPropsAsMotion` because `motion.create` narrows
              // onDragStart/onDragEnd to its PAN-gesture signature (PanInfo),
              // which structurally clashes with React's DragEvent. Isolating the
              // cast here keeps the native DnD types intact at the call sites.
              const dndProps: DragEventHandlers = {
                draggable: true,
                onDragStart: (e) => {
                  dragIdRef.current = t.id;
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox requires data to be set for the drag to start.
                  e.dataTransfer.setData("text/plain", String(t.id));
                },
                onDragOver: (e) => {
                  // preventDefault is mandatory — without it the element is
                  // not a valid drop target and onDrop never fires.
                  if (dragIdRef.current === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (t.id !== dragOverId) setDragOverId(t.id);
                },
                onDragLeave: () => {
                  if (t.id === dragOverId) setDragOverId(null);
                },
                onDrop: (e) => {
                  e.preventDefault();
                  const from = dragIdRef.current;
                  if (from !== null && from !== t.id) onReorder(from, t.id);
                  dragIdRef.current = null;
                  setDragOverId(null);
                },
                onDragEnd: () => {
                  dragIdRef.current = null;
                  setDragOverId(null);
                },
              };
              return (
                <MotionTabsTrigger
                  key={t.id}
                  value={String(t.id)}
                  data-tab-id={t.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ id: t.id, x: e.clientX, y: e.clientY });
                  }}
                  // Enter: fade + grow from a hair narrower so a freshly opened
                  // tab eases in instead of snapping. Exit: collapse width to 0
                  // so the surviving tabs slide left to fill the gap. Reduced
                  // motion skips it all (duration 0). `layout` is intentionally
                  // OFF — it would fight HTML5 drag-reorder's own transform.
                  initial={reduceMotion ? false : { opacity: 0, scaleX: 0.85 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, scaleX: 0.6, marginInline: 0, width: 0, paddingLeft: 0, paddingRight: 0 }
                  }
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE }}
                  style={{ originX: 0 }}
                  // Carve this tab OUT of the parent Tauri window-drag region —
                  // otherwise Tauri hijacks the pointerdown to move the OS
                  // window and the HTML5 `dragstart` never fires. Must be the
                  // STRING "false": React drops a boolean-`false` attribute
                  // entirely, which would leave the tab inside the drag region.
                  data-tauri-drag-region="false"
                  {...(dndProps as Record<string, unknown>)}
                  onDoubleClick={() => isPreview && onPin(t.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && tabs.length > 1) {
                      e.preventDefault();
                      e.stopPropagation();
                      onClose(t.id);
                    }
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  className={cn(
                    "group relative h-7 shrink-0 gap-1.5 rounded-md text-xs text-muted-foreground transition-all justify-between overflow-hidden",
                    // Metallic glass base: translucent gradient + blur + edge highlight.
                    "border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]",
                    "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:bg-gradient-to-b before:from-white/[0.10] before:to-transparent before:opacity-60",
                    "hover:text-foreground/80 hover:from-white/[0.10] hover:to-white/[0.03] hover:border-white/15",
                    // Active: brighter sheen, stronger top highlight, glow ring.
                    "data-[state=active]:text-foreground data-[state=active]:from-white/[0.16] data-[state=active]:to-white/[0.05] data-[state=active]:border-white/25 data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.20),0_2px_8px_-2px_rgba(0,0,0,0.5)] data-[state=active]:before:opacity-100",
                    compact
                      ? "px-1.5!"
                      : tabs.length === 1
                        ? "px-2!"
                        : "ps-2! pe-1!",
                    // Drop indicator: highlight the tab being hovered during a
                    // drag-reorder (skip when it's the dragged tab itself).
                    dragOverId === t.id &&
                      dragIdRef.current !== t.id &&
                      "ring-1 ring-primary/60 ring-inset",
                  )}
                >
                  <span
                    className={cn(
                      "relative z-10 flex items-center gap-1.5 truncate",
                      compact ? "max-w-48" : "max-w-80",
                    )}
                  >
                    <TabIcon tab={t} />
                    {/* Preview tabs use italic to signal the transient state,
                        matching the visual convention from VSCode. */}
                    <span className={cn("truncate", isPreview && "italic")}>
                      {labelFor(t)}
                    </span>
                    {t.kind === "editor" && t.dirty ? (
                      <span
                        aria-label="Unsaved changes"
                        className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                      />
                    ) : null}
                  </span>
                  {tabs.length > 1 && (
                    <span
                      role="button"
                      aria-label="Close tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(t.id);
                      }}
                      className="relative z-10 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </span>
                  )}
                </MotionTabsTrigger>
              );
            })}
            </AnimatePresence>
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New tab"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Privacy</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "R")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Preview</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "P")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewGitGraph()}>
              <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Git Graph</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenBunqueue()}>
              <HugeiconsIcon
                icon={Database02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">bunqueue</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenAnalytics()}>
              <HugeiconsIcon
                icon={ChartLineData01Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Agentlytics</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenOtel()}>
              <HugeiconsIcon icon={SatelliteIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Observability</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenKv()}>
              <HugeiconsIcon icon={DatabaseIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Key-Value Store</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenCcusage()}>
              <HugeiconsIcon icon={Coins01Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">ccusage</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenGithubFeed()}>
              <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">GitHub Feed</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Agents</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onOpenClaude()}>
              <HugeiconsIcon icon={AiBrain01Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Claude Code</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenGemini()}>
              <HugeiconsIcon icon={SparklesIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Gemini</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Jump-to-tab overflow menu. Only mounts when the strip overflows —
            the scrollbar is hidden, so this is the discoverable path to tabs
            that have scrolled off-screen. Lists every tab; selecting one
            activates it and scrolls it back into view. */}
        {isOverflowing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title="All tabs"
              >
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={14}
                  strokeWidth={2}
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto">
              <DropdownMenuLabel>Tabs ({tabs.length})</DropdownMenuLabel>
              {tabs.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={() => {
                    onSelect(t.id);
                    // Defer until the selection re-render lands so the target
                    // tab exists at its final position before scrolling.
                    requestAnimationFrame(() => {
                      scrollRef.current
                        ?.querySelector<HTMLElement>(`[data-tab-id="${t.id}"]`)
                        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
                    });
                  }}
                  className={cn(
                    t.id === activeId && "bg-accent/60 font-medium",
                  )}
                >
                  <TabIcon tab={t} />
                  <span className="flex-1 truncate">{labelFor(t)}</span>
                  {tabs.length > 1 && (
                    <span
                      role="button"
                      aria-label="Close tab"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose(t.id);
                      }}
                      className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/* Shared right-click tab menu. Rendered once and anchored to the cursor
          via a zero-size fixed trigger, so the per-tab triggers stay simple
          (just an onContextMenu that sets `menu`). Controlled open state closes
          it on action or outside-click. */}
      <DropdownMenu
        open={menu !== null}
        onOpenChange={(o) => {
          if (!o) setMenu(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed"
            style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-44"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuItem
            onSelect={() => {
              if (menu) onClose(menu.id);
            }}
          >
            Close
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={tabs.length <= 1}
            onSelect={() => {
              if (menu) onCloseOthers(menu.id);
            }}
          >
            Close others
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={tabs.length <= 1}
            onSelect={() => {
              if (menu) onCloseAll(menu.id);
            }}
          >
            Close all
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (
    tab.kind === "editor" ||
    tab.kind === "markdown" ||
    tab.kind === "image" ||
    tab.kind === "log"
  ) {
    const url = fileIconUrl(tab.title);
    return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "bunqueue") {
    return (
      <HugeiconsIcon
        icon={Database02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "docker-detail") {
    return (
      <HugeiconsIcon
        icon={ContainerIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "s3") {
    return (
      <HugeiconsIcon
        icon={CloudIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "docker") {
    return (
      <HugeiconsIcon
        icon={ContainerIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ssh") {
    return (
      <HugeiconsIcon
        icon={ServerStack02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "agentlytics") {
    return (
      <HugeiconsIcon
        icon={ChartLineData01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "otel") {
    return (
      <HugeiconsIcon
        icon={SatelliteIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ccusage") {
    return (
      <HugeiconsIcon
        icon={Coins01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "github-feed") {
    return (
      <HugeiconsIcon
        icon={GithubIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "projects" || tab.kind === "project-detail") {
    return (
      <HugeiconsIcon
        icon={FolderLibraryIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "image") return t.title;
  if (t.kind === "log") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.kind === "bunqueue") return t.title;
  if (t.kind === "docker-detail") return t.title;
  if (t.kind === "agentlytics") return t.title;
  if (t.kind === "otel") return t.title;
  if (t.kind === "kv") return t.title;
  if (t.kind === "ccusage") return t.title;
  if (t.kind === "github-feed") return t.title;
  if (t.kind === "projects") return t.title;
  if (t.kind === "project-detail") return t.title;
  if (t.kind === "data") return t.title;
  if (t.kind === "s3") return t.title;
  if (t.kind === "docker") return t.title;
  if (t.kind === "ssh") return t.title;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
