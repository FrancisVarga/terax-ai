import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  ContainerIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  displayName,
  isRunning,
  useDockerContainers,
  type DockerContainer,
} from "./lib/useDockerContainers";

type Props = {
  /**
   * SSH config alias to target a remote daemon (`docker -H ssh://<alias>`).
   * `null`/omitted lists the local daemon. Driven by the active SSH connection.
   */
  host?: string | null;
  /**
   * Open a deep-detail tab (config / env / network / mounts / logs / raw
   * inspect) in the main editor for the clicked container.
   */
  onOpenContainer: (input: {
    containerId: string;
    containerName: string;
    host: string | null;
  }) => void;
};

/**
 * Sidebar panel listing Docker containers. Clicking a row opens a full detail
 * tab in the main editor (config / environment / network / mounts / logs / raw
 * inspect).
 *
 * When `host` is set the list reflects that remote server's containers; the
 * header shows the alias so the user knows which daemon they're looking at.
 */
export function DockerPanel({ host, onOpenContainer }: Props) {
  const { containers, loading, error, reload } = useDockerContainers(host);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          <span>Docker</span>
          {host ? (
            <span
              title={`Remote daemon: ${host}`}
              className="truncate rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[9.5px] font-medium normal-case tracking-normal text-muted-foreground"
            >
              {host}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label="Reload containers"
          onClick={() => void reload()}
          disabled={loading}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={14} strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Listing containers…</span>
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
        ) : containers.length === 0 ? (
          <div className="px-2 py-3 text-[12px] leading-relaxed text-muted-foreground">
            No containers found. Start one with{" "}
            <code className="text-[11px]">docker run</code> to see it here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {containers.map((c) => (
              <DockerContainerRow
                key={c.id}
                container={c}
                onSelect={() =>
                  onOpenContainer({
                    containerId: c.id,
                    containerName: displayName(c),
                    host: host ?? null,
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DockerContainerRow({
  container,
  onSelect,
}: {
  container: DockerContainer;
  onSelect: () => void;
}) {
  const running = isRunning(container);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        title={container.status}
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
          "hover:bg-foreground/[0.055] focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        <span className="relative shrink-0">
          <HugeiconsIcon
            icon={ContainerIcon}
            size={15}
            strokeWidth={1.75}
            className="text-muted-foreground group-hover:text-foreground"
          />
          <span
            aria-hidden
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-card",
              running ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {displayName(container)}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {container.image}
          </span>
        </span>
      </button>
    </li>
  );
}
