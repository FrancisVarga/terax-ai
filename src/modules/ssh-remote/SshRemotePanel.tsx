import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  CloudServerIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  describeHost,
  useSshHosts,
  type SshHost,
} from "./lib/useSshHosts";

type Props = {
  /** Open a terminal tab and `ssh` into the given host alias. */
  onConnect: (host: SshHost) => void;
};

export function SshRemotePanel({ onConnect }: Props) {
  const { hosts, loading, error, reload } = useSshHosts();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
          SSH Remotes
        </span>
        <button
          type="button"
          aria-label="Reload SSH config"
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
            <span>Reading ~/.ssh/config…</span>
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
        ) : hosts.length === 0 ? (
          <div className="px-2 py-3 text-[12px] leading-relaxed text-muted-foreground">
            No hosts found in <code className="text-[11px]">~/.ssh/config</code>
            . Add a <code className="text-[11px]">Host</code> entry to see it
            here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {hosts.map((host, i) => (
              <SshHostRow
                // alias can repeat across Include files; pair with index.
                key={`${host.alias}:${i}`}
                host={host}
                onConnect={() => onConnect(host)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SshHostRow({
  host,
  onConnect,
}: {
  host: SshHost;
  onConnect: () => void;
}) {
  const subtitle = describeHost(host);
  return (
    <li>
      <button
        type="button"
        onClick={onConnect}
        title={`Connect: ssh ${host.alias}`}
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
          "hover:bg-foreground/[0.055] focus-visible:ring-2 focus-visible:ring-primary/40",
        )}
      >
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={15}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground group-hover:text-foreground"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {host.alias}
          </span>
          {subtitle ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
