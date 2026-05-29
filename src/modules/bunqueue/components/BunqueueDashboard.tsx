import { useEffect, useState } from "react";
import {
  ArrowReloadHorizontalIcon,
  CheckmarkCircle02Icon,
  AlertCircleIcon,
  CircleIcon,
  Database02Icon,
  GlobalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { usePreferencesStore } from "@/modules/settings/preferences";
import { setBunqueueEnabled } from "@/modules/settings/store";

import { useBunqueue } from "../hooks/useBunqueue";
import { useBunqueueData } from "../hooks/useBunqueueData";
import { bunqueueNative, type BunqueueStatus } from "../lib/native";
import { enqueueFetchOwnIp } from "../lib/api";
import { get } from "../lib/client";
import { Stat, formatDuration } from "./parts";
import { OverviewSection } from "./sections/OverviewSection";
import { WorkersSection } from "./sections/WorkersSection";
import { QueuesSection } from "./sections/QueuesSection";
import { JobsSection } from "./sections/JobsSection";
import { SchemaSection } from "./sections/SchemaSection";
import { LogView } from "./LogView";

/**
 * Dashboard for the embedded bunqueue server. Header shows process status,
 * ports, uptime, and a restart control. Tabs expose deep stats/resources,
 * workers, queues + jobs, and the raw server log tail.
 */
export function BunqueueDashboard({ className }: { className?: string }) {
  const enabled = usePreferencesStore((s) => s.bunqueueEnabled);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const { status, logs, dropped, restarting, error, restart, clearLogs } =
    useBunqueue();
  const data = useBunqueueData(status?.running ?? true);

  // Single 1s clock drives all relative-time renders (uptime, worker age).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Ensure the server is up whenever the dashboard mounts — recovers from a
  // webview reload after a failed boot, or a server that died. Gated on the
  // opt-in pref so opening the dashboard never resurrects a disabled server
  // (the backend `bunqueue_ensure` is a no-op while disabled too, but skipping
  // the call avoids a pointless round-trip).
  useEffect(() => {
    if (!enabled) return;
    void bunqueueNative.ensure().catch(() => {});
  }, [enabled]);

  // Disabled (opt-in): show an enable affordance instead of the live dashboard.
  // Wait for hydration so we don't flash this state before the pref loads.
  if (hydrated && !enabled) {
    return <DisabledState className={className} />;
  }

  const [fetchingIp, setFetchingIp] = useState(false);
  const fetchOwnIp = async () => {
    setFetchingIp(true);
    const t = toast.loading("Fetching public IP…");
    try {
      const { id } = await enqueueFetchOwnIp();
      if (!id) throw new Error("no job id");
      // Poll the job result until the http-request worker completes it.
      const ip = await pollIp(id);
      toast.success(ip ? `Public IP: ${ip}` : "IP fetched", { id: t });
    } catch (e) {
      toast.error(`Fetch IP failed: ${String(e)}`, { id: t });
    } finally {
      setFetchingIp(false);
    }
  };

  return (
    <div className={cn("flex h-full flex-col gap-3 p-4", className)}>
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={Database02Icon}
            size={18}
            strokeWidth={1.75}
            className="text-muted-foreground"
          />
          <h2 className="text-sm font-semibold">bunqueue</h2>
          <StatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchOwnIp()}
            disabled={fetchingIp || !status?.running}
            title="Enqueue a job that fetches this machine's public IP"
          >
            {fetchingIp ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon icon={GlobalIcon} size={14} strokeWidth={1.75} />
            )}
            Fetch IP
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void restart()}
            disabled={restarting}
          >
            {restarting ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon
                icon={ArrowReloadHorizontalIcon}
                size={14}
                strokeWidth={1.75}
              />
            )}
            Restart
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.75} />
          <span className="truncate">{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="HTTP API" value={portLabel(status?.http_port)} />
        <Stat label="TCP" value={portLabel(status?.tcp_port)} />
        <Stat
          label="Uptime"
          value={
            status?.started_at_ms != null
              ? formatDuration(now - status.started_at_ms)
              : "—"
          }
        />
        <Stat
          label="Workers"
          value={data.procWorkers.filter((w) => w.running).length}
        />
      </div>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workers">Workers</TabsTrigger>
          <TabsTrigger value="queues">Queues</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1">
          <OverviewSection overview={data.overview} />
        </TabsContent>
        <TabsContent value="workers" className="min-h-0 flex-1">
          <WorkersSection
            procWorkers={data.procWorkers}
            serverWorkers={data.serverWorkers}
            now={now}
          />
        </TabsContent>
        <TabsContent value="queues" className="min-h-0 flex-1">
          <QueuesSection queues={data.queues} />
        </TabsContent>
        <TabsContent value="jobs" className="min-h-0 flex-1">
          <JobsSection queues={data.queues} />
        </TabsContent>
        <TabsContent value="schema" className="min-h-0 flex-1">
          <SchemaSection queues={data.queues} />
        </TabsContent>
        <TabsContent value="logs" className="min-h-0 flex-1">
          <LogsTab
            logs={logs}
            dropped={dropped}
            onClear={clearLogs}
            command={status?.command ?? null}
            dataPath={status?.data_path ?? null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Shown when the server is disabled (opt-in). One click enables it: persist
 *  the pref and tell the backend to spawn the server. */
function DisabledState({ className }: { className?: string }) {
  const [enabling, setEnabling] = useState(false);
  const enable = async () => {
    setEnabling(true);
    try {
      await setBunqueueEnabled(true);
      await bunqueueNative.setEnabled(true);
    } catch (e) {
      toast.error(`Enable failed: ${String(e)}`);
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-4 p-8 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted/40">
        <HugeiconsIcon
          icon={Database02Icon}
          size={24}
          strokeWidth={1.5}
          className="text-muted-foreground"
        />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Bunqueue is disabled</h2>
        <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
          The embedded job-queue server is off by default. Enable it to schedule
          and run background jobs. It binds to loopback only — see Settings →
          Bunqueue for details.
        </p>
      </div>
      <Button size="sm" onClick={() => void enable()} disabled={enabling}>
        {enabling ? <Spinner className="size-3.5" /> : null}
        Enable server
      </Button>
    </div>
  );
}

function StatusBadge({ status }: { status: BunqueueStatus | null }) {
  if (!status) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Spinner className="size-3" />
        loading
      </Badge>
    );
  }
  if (status.running) {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={2} />
        running
      </Badge>
    );
  }
  if (status.exited) {
    return (
      <Badge variant="destructive" className="gap-1">
        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={2} />
        exited
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <HugeiconsIcon icon={CircleIcon} size={12} strokeWidth={2} />
      not started
    </Badge>
  );
}

function portLabel(port: number | null | undefined): string {
  return port == null ? "—" : String(port);
}

function LogsTab({
  logs,
  dropped,
  onClear,
  command,
  dataPath,
}: {
  logs: string;
  dropped: number;
  onClear: () => void;
  command: string | null;
  dataPath: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {dropped > 0
            ? `tailing — ${dropped.toLocaleString()} bytes dropped`
            : "tailing stdout + stderr"}
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={!logs}>
          Clear
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <LogView text={logs} />
      </div>
      {command ? (
        <p
          className="truncate font-mono text-[10px] text-muted-foreground"
          title={command}
        >
          {command}
        </p>
      ) : null}
      <p className="truncate font-mono text-[10px] text-muted-foreground">
        data: {dataPath ?? "in-memory"}
      </p>
    </div>
  );
}

/**
 * Poll a job's result until the http-request worker completes it, then pull the
 * public IP out of the response. Gives up after ~10s.
 */
async function pollIp(jobId: string): Promise<string | null> {
  type JobResultEnvelope = {
    result: {
      json?: { ip?: string };
      body?: string;
    } | null;
  };
  for (let i = 0; i < 20; i++) {
    const res = await get<JobResultEnvelope>(`/jobs/${jobId}/result`).catch(
      () => null,
    );
    const r = res?.result;
    if (r) {
      if (r.json?.ip) return r.json.ip;
      if (r.body) {
        try {
          const parsed = JSON.parse(r.body) as { ip?: string };
          if (parsed.ip) return parsed.ip;
        } catch {
          return r.body.trim();
        }
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for IP");
}
