import { cn } from "@/lib/utils";
import type { DockerTab, Tab } from "@/modules/tabs";
import { DockerPanel } from "./DockerPanel";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** SSH alias for a remote daemon; `null` lists the local daemon. */
  host: string | null;
  /** Open a container's deep-detail tab (a `docker-detail` tab). */
  onOpenContainer: (input: {
    containerId: string;
    containerName: string;
    host: string | null;
  }) => void;
};

/**
 * Hosts the Docker container-list tab body — the browser that used to live in
 * the left sidebar (`DockerPanel`), now a singleton main-content tab. Mirrors
 * `S3Stack`: keeps the tab mounted and toggles visibility so the container
 * list's fetch state survives tab switches. Rows open a `docker-detail` tab.
 */
export function DockerStack({ tabs, activeId, host, onOpenContainer }: Props) {
  const docker = tabs.filter((t) => t.kind === "docker") as DockerTab[];
  if (docker.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {docker.map((t) => {
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
            <DockerPanel host={host} onOpenContainer={onOpenContainer} />
          </div>
        );
      })}
    </div>
  );
}
