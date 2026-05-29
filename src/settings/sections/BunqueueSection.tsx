import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setBunqueueEnabled } from "@/modules/settings/store";
import { bunqueueNative } from "@/modules/bunqueue";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

/**
 * Bunqueue (embedded job-queue server) settings. The server is opt-in — off by
 * default — because it spawns a Bun child process bound to loopback with no
 * authentication (see src-tauri/src/modules/bunqueue.rs). Toggling here both
 * persists the `bunqueueEnabled` pref and tells the backend to start/stop the
 * live process via `bunqueue_set_enabled`.
 */
export function BunqueueSection() {
  const enabled = usePreferencesStore((s) => s.bunqueueEnabled);

  const onToggle = async (next: boolean) => {
    // Persist first so a crash mid-toggle leaves the pref authoritative on the
    // next boot, then flip the live process state.
    await setBunqueueEnabled(next);
    try {
      await bunqueueNative.setEnabled(next);
    } catch (e) {
      console.error("bunqueue toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Bunqueue"
        description="Embedded job-queue server for background tasks and AI agent workflows."
      />

      <div className="flex flex-col gap-2">
        <Label>Server</Label>
        <SettingRow
          title="Run the job-queue server"
          description="Spawns a local Bun server (loopback only) that schedules and runs queued jobs. Off by default — enable it to use the Bunqueue dashboard and workers."
        >
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void onToggle(v)}
          />
        </SettingRow>
        <p className="px-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          The server binds to 127.0.0.1 with no authentication — any process
          running as your user on this machine can drive the queue while it is
          enabled. Leave it off unless you use the job queue.
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
