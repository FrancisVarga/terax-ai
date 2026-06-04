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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  Alert02Icon,
  Cancel01Icon,
  Delete02Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Link01Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Refresh01Icon,
  ServerStack02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import type { Session } from "./lib/rmux-client";
import {
  activeWindow,
  displayName,
  paneCount,
  useSessionsStore,
} from "./lib/sessions";

type Props = {
  /**
   * Attach a session into a live rmux terminal tab. The caller owns tab
   * creation + mounting the RmuxTerminalStack and wiring reattachSession; this
   * panel only knows the session and its active window's first pane id. Optional
   * so the panel renders without an attach target (the action then hides).
   */
  onAttach?: (session: Session, daemonPaneId: number) => void;
};

/**
 * The rmux SessionSwitcher: lists the daemon's named sessions and drives their
 * lifecycle (create / rename / kill / new window / split / attach). Mount only
 * when the rmux daemon flag is on — with the flag off `rmux_session_list`
 * returns [], so this safely renders its empty state and issues no further
 * calls until the user acts. See modules/terminal-rmux/index.ts for the gate.
 */
export function SessionSwitcher({ onAttach }: Props) {
  const sessions = useSessionsStore((s) => s.sessions);
  const loading = useSessionsStore((s) => s.loading);
  const loaded = useSessionsStore((s) => s.loaded);
  const error = useSessionsStore((s) => s.error);
  const optimisticNames = useSessionsStore((s) => s.optimisticNames);
  const refresh = useSessionsStore((s) => s.refresh);
  const create = useSessionsStore((s) => s.create);
  const rename = useSessionsStore((s) => s.rename);
  const kill = useSessionsStore((s) => s.kill);
  const newWindow = useSessionsStore((s) => s.newWindow);
  const split = useSessionsStore((s) => s.split);

  // Session pending a kill confirmation (null = no dialog open).
  const [confirmKill, setConfirmKill] = useState<Session | null>(null);
  // True while a "new session" name is being entered inline.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    setCreateBusy(true);
    try {
      await create(name);
      setNewName("");
      setCreating(false);
    } catch (e) {
      toast.error(`Could not create session`, { description: String(e) });
    } finally {
      setCreateBusy(false);
    }
  }, [newName, create]);

  const onConfirmKill = useCallback(async () => {
    const target = confirmKill;
    setConfirmKill(null);
    if (!target) return;
    try {
      await kill(target.session_id);
    } catch (e) {
      toast.error(`Could not kill session`, { description: String(e) });
    }
  }, [confirmKill, kill]);

  const showEmpty = loaded && !error && sessions.length === 0 && !creating;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          rmux Sessions
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="New session"
            onClick={() => {
              setCreating(true);
              setNewName("");
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Refresh sessions"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              size={14}
              strokeWidth={1.75}
              className={cn(loading && "animate-spin")}
            />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {creating ? (
          <NewSessionRow
            value={newName}
            busy={createBusy}
            onChange={setNewName}
            onSubmit={() => void submitCreate()}
            onCancel={() => {
              setCreating(false);
              setNewName("");
            }}
          />
        ) : null}

        {!loaded && loading ? (
          <div className="flex flex-col gap-1 px-1 pt-1">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-full rounded-md" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-2 py-3 text-[12px] text-destructive">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={14}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
            />
            <span className="break-words">{error}</span>
          </div>
        ) : showEmpty ? (
          <Empty className="border-0 p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon
                  icon={ServerStack02Icon}
                  size={20}
                  strokeWidth={1.75}
                />
              </EmptyMedia>
              <EmptyTitle>No rmux sessions</EmptyTitle>
              <EmptyDescription>
                Create a session to keep shells running in the daemon, ready to
                reattach later.
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" onClick={() => setCreating(true)}>
              <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
              New session
            </Button>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            <AnimatePresence initial={false}>
              {sessions.map((session) => (
                <motion.li
                  key={session.session_id}
                  layout
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                  <SessionRow
                    session={session}
                    name={displayName(session, optimisticNames)}
                    canAttach={onAttach !== undefined}
                    onAttach={() => {
                      const win = activeWindow(session);
                      const pane = win?.panes[0];
                      if (!pane) {
                        toast.error("Session has no pane to attach");
                        return;
                      }
                      onAttach?.(session, pane.pane_id);
                    }}
                    onRename={async (next) => {
                      try {
                        await rename(session.session_id, next);
                      } catch (e) {
                        toast.error("Rename failed", {
                          description: String(e),
                        });
                      }
                    }}
                    onNewWindow={async () => {
                      try {
                        await newWindow(session.session_id);
                      } catch (e) {
                        toast.error("Could not add window", {
                          description: String(e),
                        });
                      }
                    }}
                    onSplit={async (dir) => {
                      const win = activeWindow(session);
                      if (!win) return;
                      try {
                        await split(win.window_id, dir);
                      } catch (e) {
                        toast.error("Could not split window", {
                          description: String(e),
                        });
                      }
                    }}
                    onKill={() => setConfirmKill(session)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <AlertDialog
        open={confirmKill !== null}
        onOpenChange={(open) => !open && setConfirmKill(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill session</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmKill
                ? `Kill "${displayName(
                    confirmKill,
                    optimisticNames,
                  )}" and all of its windows and panes? Running shells are terminated. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onConfirmKill()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Kill session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NewSessionRow({
  value,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <HugeiconsIcon
        icon={ServerStack02Icon}
        size={15}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <Input
        ref={ref}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={onSubmit}
        placeholder="Session name"
        spellCheck={false}
        className="h-7 text-[12.5px]"
      />
      {busy ? <Spinner className="size-3.5 shrink-0" /> : null}
    </div>
  );
}

function SessionRow({
  session,
  name,
  canAttach,
  onAttach,
  onRename,
  onNewWindow,
  onSplit,
  onKill,
}: {
  session: Session;
  name: string;
  canAttach: boolean;
  onAttach: () => void;
  onRename: (next: string) => void;
  onNewWindow: () => void;
  onSplit: (dir: "row" | "col") => void;
  onKill: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  const beginEdit = useCallback(() => {
    setDraft(name);
    setEditing(true);
  }, [name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) onRename(next);
  }, [draft, name, onRename]);

  const windows = session.windows.length;
  const panes = paneCount(session);
  const attached = false; // Attach-state tracking lands with the tab wiring.

  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
        "hover:bg-foreground/[0.055]",
      )}
    >
      <span
        aria-hidden
        title={attached ? "Attached" : "Detached"}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          attached ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        {editing ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            spellCheck={false}
            className="h-6 px-1.5 text-[12.5px]"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={beginEdit}
            onClick={canAttach ? onAttach : undefined}
            title={
              canAttach
                ? `Attach "${name}" (double-click to rename)`
                : "Double-click to rename"
            }
            className="cursor-pointer truncate text-left text-[12.5px] font-medium text-foreground outline-none focus-visible:underline"
          >
            {name}
          </button>
        )}
        <span className="truncate text-[11px] text-muted-foreground">
          {windows} {windows === 1 ? "window" : "windows"} · {panes}{" "}
          {panes === 1 ? "pane" : "panes"}
        </span>
      </span>

      {canAttach && !editing ? (
        <button
          type="button"
          aria-label="Attach session"
          onClick={onAttach}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-all hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100"
        >
          <HugeiconsIcon icon={Link01Icon} size={14} strokeWidth={1.75} />
        </button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Session actions"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-all hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <HugeiconsIcon icon={MoreVerticalIcon} size={15} strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {canAttach ? (
            <DropdownMenuItem onSelect={onAttach}>
              <HugeiconsIcon icon={Link01Icon} size={14} strokeWidth={1.75} />
              Attach
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={beginEdit}>
            <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewWindow}>
            <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} />
            New window
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplit("row")}>
            <HugeiconsIcon
              icon={LayoutTwoColumnIcon}
              size={14}
              strokeWidth={1.75}
            />
            Split right
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplit("col")}>
            <HugeiconsIcon icon={LayoutTwoRowIcon} size={14} strokeWidth={1.75} />
            Split down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onKill}
            className="text-destructive focus:text-destructive"
          >
            <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
            Kill session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? (
        <button
          type="button"
          aria-label="Cancel rename"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditing(false)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
