import { useEffect, useState } from "react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  clampKvPort,
  KV_PORT_DEFAULT,
  KV_PORT_MAX,
  KV_PORT_MIN,
  setKvEnabled,
  setKvPort,
  setKvRequirePass,
} from "@/modules/settings/store";
import { kvNative } from "@/modules/kv";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

/**
 * Key-Value store (embedded Redis-compatible cache) settings. Opt-in (off by
 * default) because it binds a loopback server with no auth unless a password is
 * set. The enable toggle and port flip the live process; the password is read by
 * the backend at boot, so changing it asks for an app restart.
 */
export function KvSection() {
  const enabled = usePreferencesStore((s) => s.kvEnabled);
  const port = usePreferencesStore((s) => s.kvPort);
  const requirePass = usePreferencesStore((s) => s.kvRequirePass);

  const [portInput, setPortInput] = useState(String(port));
  const [passInput, setPassInput] = useState(requirePass);

  // Track external pref changes (e.g. enabling from the dashboard).
  useEffect(() => setPortInput(String(port)), [port]);
  useEffect(() => setPassInput(requirePass), [requirePass]);

  const onToggle = async (next: boolean) => {
    await setKvEnabled(next);
    try {
      await kvNative.setEnabled(next);
    } catch (e) {
      console.error("kv toggle failed", e);
    }
  };

  const commitPort = async () => {
    const next = clampKvPort(Number(portInput));
    setPortInput(String(next));
    if (next === port) return;
    await setKvPort(next);
    try {
      await kvNative.setPort(next);
    } catch (e) {
      toast.error(`Set port failed: ${String(e)}`);
    }
  };

  const commitPass = async () => {
    if (passInput === requirePass) return;
    await setKvRequirePass(passInput);
    try {
      // The backend reads requirepass at boot; restart so the change applies on
      // the next launch and inform the user a full restart is needed.
      await kvNative.restart();
    } catch (e) {
      console.error("kv restart failed", e);
    }
    toast.message("Restart Terax to apply the new password", {
      description: "The KV server reads its password when the app starts.",
    });
  };

  const connString = requirePass
    ? `redis://:${requirePass}@127.0.0.1:${port}`
    : `redis://127.0.0.1:${port}`;

  const copyConn = async () => {
    try {
      await navigator.clipboard.writeText(connString);
      toast.success("Connection string copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Key-Value Store"
        description="Embedded Redis-compatible cache for fast key-value storage and pub/sub."
      />

      <div className="flex flex-col gap-2">
        <Label>Server</Label>
        <SettingRow
          title="Run the KV cache server"
          description="Spawns a local Redis-compatible server (loopback only) for keys, TTLs, and pub/sub. Off by default; enable it to use the Key-Value Store dashboard."
        >
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void onToggle(v)}
          />
        </SettingRow>

        <SettingRow
          title="Port"
          description={`Listen port (${KV_PORT_MIN}-${KV_PORT_MAX}). Default ${KV_PORT_DEFAULT}.`}
        >
          <Input
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onBlur={() => void commitPort()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitPort();
            }}
            inputMode="numeric"
            className="h-8 w-24 text-xs"
          />
        </SettingRow>

        <SettingRow
          title="Password"
          description="Optional requirepass. Leave empty for no auth. Applied on the next app restart."
        >
          <Input
            value={passInput}
            onChange={(e) => setPassInput(e.target.value)}
            onBlur={() => void commitPass()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitPass();
            }}
            type="password"
            placeholder="(none)"
            className="h-8 w-48 text-xs"
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Connection</Label>
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {connString}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyConn()}
            title="Copy connection string"
          >
            <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.75} />
            Copy
          </Button>
        </div>
        <p className="px-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          The server binds to 127.0.0.1 with a per-user trust boundary: any
          process running as your user on this machine can reach it while it is
          enabled. Set a password for stricter isolation. Leave it off unless you
          use the cache.
        </p>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
