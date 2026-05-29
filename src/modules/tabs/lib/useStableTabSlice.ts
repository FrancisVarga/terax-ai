import { useRef } from "react";
import type { Tab } from "./useTabs";

/**
 * Returns the subset of `tabs` matching `kind` as a **referentially stable**
 * array: when the matching tabs are unchanged (same ids in the same order, and
 * every field shallow-equal) the previous array reference is returned.
 *
 * Why this exists: `App` holds one `tabs` array and feeds it to ~16 content
 * "Stack" components. Any tab mutation — including `setLeafCwd`, which fires at
 * keystroke rate — allocates a new `tabs` array, so a naive
 * `tabs.filter(byKind)` produces a fresh slice on every render and every Stack
 * re-renders even when its own kind didn't change. Pairing this hook with
 * `React.memo` on the Stack lets unaffected Stacks bail out of re-render: a cwd
 * change on a terminal tab leaves the markdown / log / data / git slices
 * reference-identical, so those subtrees never reconcile.
 *
 * The comparison is a shallow per-field equality over the matched tabs. That is
 * exactly the granularity the Stacks care about (they read `id`, `path`,
 * `title`, `url`, … but never deep structures), and it is far cheaper than the
 * React reconciliation it prevents.
 */
export function useStableTabSlice<K extends Tab["kind"]>(
  tabs: Tab[],
  kind: K,
): Extract<Tab, { kind: K }>[] {
  type Slice = Extract<Tab, { kind: K }>;
  const prevRef = useRef<Slice[]>([]);
  const next = tabs.filter((t): t is Slice => t.kind === kind);
  const prev = prevRef.current;

  if (prev.length === next.length && next.every((t, i) => shallowEqual(t, prev[i]))) {
    return prev;
  }
  prevRef.current = next;
  return next;
}

function shallowEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const ak = Object.keys(a) as (keyof typeof a)[];
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== (b as typeof a)[k]) return false;
  }
  return true;
}
