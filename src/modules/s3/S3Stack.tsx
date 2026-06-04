import { cn } from "@/lib/utils";
import type { Tab } from "@/modules/tabs";
import { S3Browser } from "./S3Browser";

/**
 * The S3 tab shape. The `"s3"` kind is being added to the shared `Tab` union by
 * another developer concurrently; until that lands we keep a local definition
 * and narrow `Tab` through a `{ kind: string }` view so this compiles against
 * the current union without editing `useTabs.ts`. Once `"s3"` is in `Tab`, this
 * keeps working unchanged.
 */
export type S3Tab = { id: number; kind: "s3"; title: string };

type Props = {
  tabs: Tab[];
  activeId: number;
  /** This window's project root — the data root for the per-project local S3
   * server. Passed through to the browser so its mutations target the right
   * server. `null` when no project is open. */
  projectDir: string | null;
};

/**
 * Keeps every open S3 tab mounted and toggles visibility, mirroring the other
 * `*Stack` components. The tree's lazy-load cache and the preview viewers hold
 * fetch state, so unmounting on tab switch would discard it — visibility-only
 * switching preserves it. In practice there is usually a single S3 tab.
 *
 * `Tab` doesn't yet include the `"s3"` kind (another developer is adding it
 * concurrently), so a `t is S3Tab` type guard against `Tab` would fail the
 * predicate-assignability rule. Instead we filter on a `{ kind: string }` view
 * and map the survivors to `S3Tab`, which compiles now and keeps working once
 * `"s3"` lands in the union.
 */
export function S3Stack({ tabs, activeId, projectDir }: Props) {
  const s3 = tabs.filter(
    (t) => (t as { kind: string }).kind === "s3",
  ) as unknown as S3Tab[];
  if (s3.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {s3.map((t) => {
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
            <S3Browser visible={visible} projectDir={projectDir} />
          </div>
        );
      })}
    </div>
  );
}
