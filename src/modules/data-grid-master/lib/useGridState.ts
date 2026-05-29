import { useCallback, useState } from "react";

/** User-toggleable grid features surfaced in the control bar. Each maps to a
 *  grid option applied in the pane, so the showcase is interactive rather than
 *  a static config dump. */
export type GridFeatures = {
  pagination: boolean;
  floatingFilters: boolean;
  fullRowEdit: boolean;
  /** External filter: only rows with performance >= 50. */
  highPerformersOnly: boolean;
  animateRows: boolean;
};

export const DEFAULT_FEATURES: GridFeatures = {
  pagination: false,
  floatingFilters: true,
  fullRowEdit: false,
  highPerformersOnly: false,
  animateRows: true,
};

/** Live counters shown in the custom status footer (Community has no StatusBar
 *  module, so we drive our own from grid events). */
export type GridCounters = {
  total: number | null;
  displayed: number;
  selected: number;
};

export function useGridState() {
  const [features, setFeatures] = useState<GridFeatures>(DEFAULT_FEATURES);
  const [counters, setCounters] = useState<GridCounters>({
    total: null,
    displayed: 0,
    selected: 0,
  });

  const toggle = useCallback((key: keyof GridFeatures) => {
    setFeatures((f) => ({ ...f, [key]: !f[key] }));
  }, []);

  const setCount = useCallback((patch: Partial<GridCounters>) => {
    setCounters((c) => ({ ...c, ...patch }));
  }, []);

  return { features, toggle, counters, setCount };
}
