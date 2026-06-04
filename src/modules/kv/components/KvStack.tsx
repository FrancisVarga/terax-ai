import { Suspense } from "react";
import type { Tab } from "@/modules/tabs";
import { Spinner } from "@/components/ui/spinner";
import { KvDashboard } from "../index";

/**
 * Renders the KV dashboard when a `kv` tab exists. Unlike the bunqueue/otel
 * stacks (which unmount when inactive), this stays mounted while the tab exists
 * and relies on the parent TabLayer's visibility toggle, so the pub/sub
 * subscription and pollers survive tab switches. It unmounts only when the tab
 * is closed.
 *
 * The server is a singleton, so there is at most one kv tab and the dashboard
 * needs no per-tab props.
 */
export function KvStack({
  tabs,
}: {
  tabs: Tab[];
  /** Accepted for parity with sibling stacks; the dashboard stays mounted while
   *  the tab exists so its pub/sub subscription survives tab switches. */
  activeId: number;
}) {
  const hasKvTab = tabs.some((t) => t.kind === "kv");
  if (!hasKvTab) return null;

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <KvDashboard className="h-full" />
    </Suspense>
  );
}
