/**
 * Synthetic row shape for the data-grid-master showcase. The columns are chosen
 * to exercise every AG Grid Community cell behaviour: text/number/date/boolean
 * data types, a value-getter target (`fullName`), a formatted currency, an
 * enum rendered as a badge, a 0..100 progress value, and a small numeric series
 * rendered as an inline SVG sparkline.
 */
export type GridRow = {
  id: number;
  firstName: string;
  lastName: string;
  /** Derived via a value getter from first + last; never stored. */
  email: string;
  department: Department;
  status: Status;
  salary: number;
  /** ISO date string (yyyy-mm-dd) so the date column filter parses it. */
  hireDate: string;
  active: boolean;
  performance: number; // 0..100
  /** 12-point series for the inline sparkline cell. */
  trend: number[];
  notes: string;
};

export type Department =
  | "Engineering"
  | "Sales"
  | "Marketing"
  | "Support"
  | "Finance"
  | "Operations";

export type Status = "active" | "onboarding" | "leave" | "alumni";

export const DEPARTMENTS: readonly Department[] = [
  "Engineering",
  "Sales",
  "Marketing",
  "Support",
  "Finance",
  "Operations",
];

export const STATUSES: readonly Status[] = [
  "active",
  "onboarding",
  "leave",
  "alumni",
];

/** Total synthetic rows the generator can produce. Large enough to make the
 *  infinite row model + virtualization the only viable rendering path. */
export const SYNTHETIC_ROW_COUNT = 200_000;

/** Request sent to the generator worker: produce rows in [startRow, endRow). */
export type WorkerRequest = {
  type: "rows";
  /** Echoed back so an out-of-order response can be matched to its request. */
  requestId: number;
  startRow: number;
  endRow: number;
};

/** Response from the generator worker for one block. */
export type WorkerResponse = {
  type: "rows";
  requestId: number;
  startRow: number;
  rows: GridRow[];
  /** Definitive total so the grid stops paging at the end. */
  total: number;
};
