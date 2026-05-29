import { Suspense } from "react";
import type { Tab } from "@/modules/tabs";
import { Spinner } from "@/components/ui/spinner";
import { BunqueueDashboard } from "../index";

/**
 * Renders the bunqueue dashboard when a `bunqueue` tab is active. Mirrors the
 * other tab "Stack" components: it mounts only while relevant so the polling
 * hooks inside the dashboard don't run when the tab is hidden.
 *
 * The server is a singleton, so there is at most one bunqueue tab and the
 * dashboard needs no per-tab props.
 */
export function BunqueueStack({
  tabs,
  activeId,
}: {
  tabs: Tab[];
  activeId: number;
}) {
  const active = tabs.find((t) => t.id === activeId);
  if (active?.kind !== "bunqueue") return null;

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <BunqueueDashboard className="h-full" />
    </Suspense>
  );
}
