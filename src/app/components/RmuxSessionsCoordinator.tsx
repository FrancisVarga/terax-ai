import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  SessionSwitcher,
  useSessionsStore,
  type Session,
} from "@/modules/terminal-rmux";
import { ServerStack02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  /**
   * Attach a session into a real rmux terminal tab. See App.tsx for the
   * (currently minimal) wiring. Optional: when omitted the switcher hides its
   * attach affordance and only manages session lifecycle.
   */
  onAttach?: (session: Session, daemonPaneId: number) => void;
};

/**
 * Self-contained coordinator for the rmux SessionSwitcher. It owns a floating
 * toggle and a dialog hosting the switcher.
 *
 * FLAG GATE: the rmux daemon flag (`TERAX_RMUX_DAEMON=1`) lives in the backend
 * and is not surfaced to the webview by any command, so this gates indirectly:
 * `rmux_session_list` returns [] whenever the daemon is not connected (flag off
 * or sidecar not staged), and a non-empty list can only come from a connected
 * daemon. So the coordinator probes once on mount and renders nothing until at
 * least one session exists. With the flag off this stays invisible and issues
 * no further calls — exactly the no-daemon degrade path. When a real flag-query
 * command lands, replace the `hasSessions` gate with it.
 */
export function RmuxSessionsCoordinator({ onAttach }: Props) {
  const [open, setOpen] = useState(false);
  const sessions = useSessionsStore((s) => s.sessions);
  const refresh = useSessionsStore((s) => s.refresh);

  // One probe on mount so the toggle appears for a connected daemon even before
  // the dialog is opened. The switcher refreshes again on open.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasSessions = sessions.length > 0;
  if (!hasSessions && !open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="rmux sessions"
        title="rmux sessions"
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-9 right-3 z-30 flex h-9 w-9 items-center justify-center rounded-full",
          "border border-border/60 bg-card text-muted-foreground shadow-sm outline-none",
          "transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        <HugeiconsIcon icon={ServerStack02Icon} size={16} strokeWidth={1.75} />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-0 p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>rmux sessions</DialogTitle>
            <DialogDescription>
              Daemon-backed shells that outlive this window. Attach to reattach a
              session into a terminal tab.
            </DialogDescription>
          </DialogHeader>
          <div className="h-[26rem] min-h-0">
            <SessionSwitcher
              onAttach={
                onAttach
                  ? (session, paneId) => {
                      onAttach(session, paneId);
                      setOpen(false);
                    }
                  : undefined
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
