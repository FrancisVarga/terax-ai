import { cn } from "@/lib/utils";
import type { SshTab, Tab } from "@/modules/tabs";
import { SshRemotePanel } from "./SshRemotePanel";
import type { SshHost } from "./lib/useSshHosts";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Open a terminal tab and `ssh` into the chosen host alias. */
  onConnect: (host: SshHost) => void;
};

/**
 * Hosts the SSH remote-host list tab body — the host browser that used to live
 * in the left sidebar (`SshRemotePanel`), now a singleton main-content tab.
 * Mirrors `S3Stack`: keeps the tab mounted and toggles visibility so the host
 * list's fetch state survives tab switches. Selecting a host connects (opening
 * a terminal tab), exactly as the sidebar panel did.
 */
export function SshStack({ tabs, activeId, onConnect }: Props) {
  const ssh = tabs.filter((t) => t.kind === "ssh") as SshTab[];
  if (ssh.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {ssh.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <SshRemotePanel onConnect={onConnect} />
          </div>
        );
      })}
    </div>
  );
}
