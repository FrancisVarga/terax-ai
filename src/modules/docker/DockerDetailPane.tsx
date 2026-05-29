import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  Copy01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { DockerStatsGraphs } from "./DockerStatsGraphs";
import { dockerLogs, inspectContainer } from "./lib/useDockerContainers";

type Props = {
  containerId: string;
  containerName: string;
  /** SSH alias for a remote daemon; `null` = local. */
  host: string | null;
};

/** Subset of `docker inspect` we surface in friendly cards. Everything else is
 * still shown verbatim under "Raw inspect". */
type InspectData = {
  Id?: string;
  Name?: string;
  Created?: string;
  Path?: string;
  Args?: string[];
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    FinishedAt?: string;
    ExitCode?: number;
    Error?: string;
    Pid?: number;
  };
  Config?: {
    Image?: string;
    Hostname?: string;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    Labels?: Record<string, string> | null;
  };
  Image?: string;
  RestartCount?: number;
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
  }>;
  NetworkSettings?: {
    IPAddress?: string;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    Networks?: Record<string, { IPAddress?: string; Gateway?: string }>;
  };
  [key: string]: unknown;
};

const TAIL_OPTIONS = [200, 1000, 5000] as const;

/**
 * Full-surface Docker container detail view, rendered in a main-editor tab.
 * Inspects the container for config/state/env/ports/mounts/network, shows the
 * raw inspect JSON, and fetches logs independently (tail selector + refresh).
 */
export function DockerDetailPane({ containerId, containerName, host }: Props) {
  const [data, setData] = useState<InspectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reloadInspect = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = (await inspectContainer(containerId, host)) as InspectData;
      setData(raw);
    } catch (e) {
      setData(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [containerId, host]);

  useEffect(() => {
    void reloadInspect();
  }, [reloadInspect]);

  const state = data?.State ?? {};
  const running = state.Running === true;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-4 py-2.5">
        <span
          aria-hidden
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            running ? "bg-emerald-500" : "bg-muted-foreground/50",
          )}
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {containerName}
          </span>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {host ? `${host} · ` : ""}
            {containerId.slice(0, 12)}
          </span>
        </div>
        <span className="ml-auto rounded bg-foreground/[0.06] px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          {state.Status ?? "unknown"}
        </span>
        <button
          type="button"
          aria-label="Reload"
          onClick={() => void reloadInspect()}
          disabled={loading}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={15} strokeWidth={1.75} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Inspecting {containerId.slice(0, 12)}…</span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 py-4 text-[12px] text-destructive">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={14}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0"
            />
            <span className="break-words">{error}</span>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-4">
            <Card title="Resources (live)">
              <DockerStatsGraphs
                containerId={containerId}
                host={host}
                running={running}
              />
            </Card>
            <DetailCards data={data} />
            <LogsSection
              containerId={containerId}
              host={host}
              key={`${host ?? "local"}:${containerId}`}
            />
            <RawInspect data={data} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailCards({ data }: { data: InspectData }) {
  const config = data.Config ?? {};
  const state = data.State ?? {};
  const net = data.NetworkSettings ?? {};
  const env = (config.Env ?? []).filter(Boolean);
  const labels = config.Labels ?? {};
  const mounts = data.Mounts ?? [];

  const ports = Object.entries(net.Ports ?? {})
    .map(([containerPort, bindings]) => {
      if (!bindings || bindings.length === 0) return `${containerPort} (exposed)`;
      return bindings
        .map((b) => `${b.HostIp || "0.0.0.0"}:${b.HostPort} → ${containerPort}`)
        .join(", ");
    })
    .filter(Boolean);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card title="State">
        <KeyVal label="Status" value={state.Status ?? "—"} />
        {state.StartedAt ? (
          <KeyVal label="Started" value={state.StartedAt} mono />
        ) : null}
        {state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z" ? (
          <KeyVal label="Finished" value={state.FinishedAt} mono />
        ) : null}
        {typeof state.ExitCode === "number" ? (
          <KeyVal label="Exit code" value={String(state.ExitCode)} />
        ) : null}
        {typeof state.Pid === "number" && state.Pid > 0 ? (
          <KeyVal label="PID" value={String(state.Pid)} />
        ) : null}
        {state.Error ? (
          <KeyVal label="Error" value={state.Error} />
        ) : null}
        {typeof data.RestartCount === "number" ? (
          <KeyVal label="Restarts" value={String(data.RestartCount)} />
        ) : null}
      </Card>

      <Card title="Config">
        <KeyVal label="Image" value={config.Image ?? "—"} mono />
        {config.Hostname ? (
          <KeyVal label="Hostname" value={config.Hostname} mono />
        ) : null}
        {data.Created ? (
          <KeyVal label="Created" value={data.Created} mono />
        ) : null}
        {config.WorkingDir ? (
          <KeyVal label="WorkingDir" value={config.WorkingDir} mono />
        ) : null}
        {config.Entrypoint?.length ? (
          <KeyVal label="Entrypoint" value={config.Entrypoint.join(" ")} mono />
        ) : null}
        {config.Cmd?.length ? (
          <KeyVal label="Cmd" value={config.Cmd.join(" ")} mono />
        ) : null}
      </Card>

      <Card title={`Environment (${env.length})`}>
        {env.length === 0 ? (
          <Empty>No environment variables.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {env.map((line) => {
              const eq = line.indexOf("=");
              const k = eq === -1 ? line : line.slice(0, eq);
              const v = eq === -1 ? "" : line.slice(eq + 1);
              return (
                <div key={line} className="flex flex-col gap-0.5">
                  <span className="break-all font-mono text-[11px] font-medium text-foreground">
                    {k}
                  </span>
                  {v ? (
                    <span className="break-all font-mono text-[11px] text-muted-foreground">
                      {v}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Network & Ports">
        {net.IPAddress ? (
          <KeyVal label="IP" value={net.IPAddress} mono />
        ) : null}
        {Object.entries(net.Networks ?? {}).map(([name, n]) => (
          <KeyVal
            key={name}
            label={name}
            value={n.IPAddress ? `${n.IPAddress}${n.Gateway ? ` (gw ${n.Gateway})` : ""}` : "—"}
            mono
          />
        ))}
        {ports.length > 0 ? (
          <KeyVal label="Ports" value={ports.join("\n")} mono />
        ) : (
          <Empty>No published ports.</Empty>
        )}
      </Card>

      {mounts.length > 0 ? (
        <Card title={`Mounts (${mounts.length})`}>
          <div className="flex flex-col gap-1.5">
            {mounts.map((m, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span className="break-all font-mono text-[11px] text-foreground">
                  {(m.Source ?? "?") + " → " + (m.Destination ?? "?")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {[m.Type, m.RW ? "rw" : "ro", m.Mode].filter(Boolean).join(" · ")}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {Object.keys(labels).length > 0 ? (
        <Card title={`Labels (${Object.keys(labels).length})`}>
          {Object.entries(labels).map(([k, v]) => (
            <KeyVal key={k} label={k} value={v} mono />
          ))}
        </Card>
      ) : null}
    </div>
  );
}

function LogsSection({
  containerId,
  host,
}: {
  containerId: string;
  host: string | null;
}) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState<(typeof TAIL_OPTIONS)[number]>(1000);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await dockerLogs(containerId, host, tail);
      setLogs(text);
    } catch (e) {
      setLogs("");
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [containerId, host, tail]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card
      title="Logs"
      action={
        <div className="flex items-center gap-1.5">
          <select
            value={tail}
            onChange={(e) =>
              setTail(Number(e.target.value) as (typeof TAIL_OPTIONS)[number])
            }
            className="rounded border border-border/60 bg-transparent px-1.5 py-0.5 text-[10.5px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Log tail size"
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                last {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Copy logs"
            onClick={() => void navigator.clipboard.writeText(logs)}
            disabled={!logs}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40"
          >
            <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Reload logs"
            onClick={() => void reload()}
            disabled={loading}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-[11.5px] text-muted-foreground">
          <Spinner className="size-3.5" />
          <span>Fetching logs…</span>
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 py-2 text-[11.5px] text-destructive">
          <HugeiconsIcon
            icon={Alert02Icon}
            size={13}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          <span className="break-words">{error}</span>
        </div>
      ) : logs.trim() === "" ? (
        <Empty>No log output.</Empty>
      ) : (
        <pre className="max-h-[420px] overflow-auto rounded-md bg-foreground/[0.04] p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
          {logs}
        </pre>
      )}
    </Card>
  );
}

function RawInspect({ data }: { data: InspectData }) {
  const text = JSON.stringify(data, null, 2);
  return (
    <Card
      title="Raw inspect"
      action={
        <button
          type="button"
          aria-label="Copy raw inspect"
          onClick={() => void navigator.clipboard.writeText(text)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.75} />
        </button>
      }
    >
      <pre className="max-h-[480px] overflow-auto rounded-md bg-foreground/[0.04] p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
        {text}
      </pre>
    </Card>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          {title}
        </h3>
        {action}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

function KeyVal({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground/70">{label}</span>
      <span
        className={cn(
          "whitespace-pre-wrap break-all text-[11.5px] text-foreground",
          mono && "font-mono text-[11px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}
