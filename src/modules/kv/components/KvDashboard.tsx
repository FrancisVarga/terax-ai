import { useEffect } from "react";
import { AlertCircleIcon, Database02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { usePreferencesStore } from "@/modules/settings/preferences";
import { setKvEnabled } from "@/modules/settings/store";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";

import { useKvStatus } from "../hooks/useKvStatus";
import { useKvData } from "../hooks/useKvData";
import { useKvPubSub } from "../hooks/useKvPubSub";
import { kvNative } from "../lib/native";
import { KvToolbar } from "./KvToolbar";
import { KvKeyList } from "./KvKeyList";
import { KvValueEditor } from "./KvValueEditor";
import { KvNewKeyDialog } from "./KvNewKeyDialog";
import { KvPubSubConsole } from "./KvPubSubConsole";
import { LogView } from "./LogView";

/**
 * Dashboard for the embedded KV (Redis-compatible) server. Header shows status,
 * port, and a copyable URL; the Data tab pairs the key list with a value editor
 * and a "new key" affordance; the Pub/Sub tab subscribes + publishes; the Logs
 * tab tails the server output.
 */
export function KvDashboard({ className }: { className?: string }) {
  const enabled = usePreferencesStore((s) => s.kvEnabled);
  const hydrated = usePreferencesStore((s) => s.hydrated);

  const kv = useKvStatus();
  const running = kv.status?.running ?? false;
  const data = useKvData(running);
  const pubsub = useKvPubSub();

  // Recover the server whenever the dashboard mounts (webview reload, crash),
  // gated on the opt-in pref so opening this never resurrects a disabled server.
  useEffect(() => {
    if (!enabled) return;
    void kvNative.ensure().catch(() => {});
  }, [enabled]);

  // Wait for hydration so we don't flash the disabled state before the pref loads.
  if (hydrated && !enabled) {
    return <DisabledState className={className} onEnable={kv.enable} />;
  }

  if (!kv.status) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col gap-3 p-4", className)}>
      <KvToolbar
        status={kv.status}
        dbsize={data.dbsize}
        busy={kv.busy}
        onRefresh={() => void data.reload()}
        onFlushAll={data.flushAll}
        onRestart={() => void kv.restart()}
      />

      {kv.error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.75} />
          <span className="truncate">{kv.error}</span>
        </div>
      ) : null}

      <Tabs defaultValue="data" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="pubsub">Pub/Sub</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="data" className="min-h-0 flex-1">
          {running ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="flex justify-end">
                <KvNewKeyDialog disabled={!running} onCreate={data.save} />
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(220px,340px)_1fr]">
                <KvKeyList
                  keys={data.keys}
                  loading={data.loading}
                  hasMore={data.hasMore}
                  pattern={data.pattern}
                  selectedKey={data.selectedKey}
                  onPatternChange={data.setPattern}
                  onLoadMore={() => void data.loadMore()}
                  onSelect={(k) => void data.select(k)}
                />
                <div className="min-h-0 rounded-xl border border-border/60 p-3">
                  <KvValueEditor
                    selectedKey={data.selectedKey}
                    value={data.selectedValue}
                    loading={data.valueLoading}
                    onSave={data.save}
                    onSetTtl={data.setTtl}
                    onDelete={(k) => data.remove([k])}
                  />
                </div>
              </div>
            </div>
          ) : (
            <StoppedState onRestart={() => void kv.restart()} busy={kv.busy} />
          )}
        </TabsContent>

        <TabsContent value="pubsub" className="min-h-0 flex-1">
          <KvPubSubConsole pubsub={pubsub} disabled={!running} />
        </TabsContent>

        <TabsContent value="logs" className="min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                {kv.dropped > 0
                  ? `tailing, ${kv.dropped.toLocaleString()} bytes dropped`
                  : "tailing stdout + stderr"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={kv.clearLogs}
                disabled={!kv.logs}
              >
                Clear
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <LogView text={kv.logs} />
            </div>
            {kv.status.command ? (
              <p
                className="truncate font-mono text-[10px] text-muted-foreground"
                title={kv.status.command}
              >
                {kv.status.command}
              </p>
            ) : null}
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              data: {kv.status.data_path ?? "in-memory"}
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Shown when the server is disabled (opt-in). Enabling persists the pref and
 *  tells the backend to spawn + ensure the server. */
function DisabledState({
  className,
  onEnable,
}: {
  className?: string;
  onEnable: () => Promise<void>;
}) {
  const enable = async () => {
    try {
      await setKvEnabled(true);
      await onEnable();
    } catch (e) {
      toast.error(`Enable failed: ${String(e)}`);
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
        <h2 className="text-sm font-semibold">Key-Value store is disabled</h2>
        <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
          The embedded Redis-compatible cache is off by default. Enable it to
          browse keys, edit values, and use pub/sub. It binds to loopback only.
          Configure the port and password in Settings.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void enable()}>
          Enable KV server
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openSettingsWindow("kv")}
        >
          Open settings
        </Button>
      </div>
    </div>
  );
}

/** Server enabled but not currently running (exited/booting). */
function StoppedState({
  onRestart,
  busy,
}: {
  onRestart: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted/40">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={24}
          strokeWidth={1.5}
          className="text-muted-foreground"
        />
      </div>
      <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
        The KV server is enabled but not running right now. It may be starting up
        or have exited. Try restarting it.
      </p>
      <Button size="sm" onClick={onRestart} disabled={busy}>
        {busy ? <Spinner className="size-3.5" /> : null}
        Restart server
      </Button>
    </div>
  );
}
