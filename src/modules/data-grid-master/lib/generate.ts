import {
  DEPARTMENTS,
  STATUSES,
  SYNTHETIC_ROW_COUNT,
  type GridRow,
} from "./types";

/**
 * Deterministic synthetic-row generator. Pure and seeded by row index, so the
 * same row index always yields the same row regardless of which block requested
 * it. This is what lets the infinite row model refetch a block (after a sort or
 * cache eviction) and get stable data, and it makes the generator unit-testable
 * without a Worker.
 *
 * `mulberry32` is a tiny, fast 32-bit PRNG; seeding it per-row keeps generation
 * O(1) per row with no shared mutable state.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Ada", "Bjarne", "Caro", "Dennis", "Edsger", "Frances", "Grace", "Hedy",
  "Ivan", "June", "Ken", "Linus", "Margaret", "Niklaus", "Olga", "Peter",
  "Quinn", "Radia", "Sophie", "Tim", "Ursula", "Vint", "Wendy", "Ximena",
  "Yann", "Zara",
];

const LAST_NAMES = [
  "Lovelace", "Stroustrup", "Diaz", "Ritchie", "Dijkstra", "Allen", "Hopper",
  "Lamarr", "Sutherland", "Almeida", "Thompson", "Torvalds", "Hamilton",
  "Wirth", "Volkov", "Norvig", "Park", "Perlman", "Wilson", "Berners-Lee",
  "Franklin", "Cerf", "Hall", "Reyes", "LeCun", "Khan",
];

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/** Build a single row deterministically from its absolute index. */
export function generateRow(index: number): GridRow {
  const rnd = mulberry32(index * 2654435761 + 1);
  const firstName = pick(FIRST_NAMES, rnd);
  const lastName = pick(LAST_NAMES, rnd);
  const department = pick(DEPARTMENTS, rnd);
  const status = pick(STATUSES, rnd);
  const salary = 45_000 + Math.floor(rnd() * 205_000);
  const performance = Math.floor(rnd() * 101);

  // Hire date: spread across ~15 years, derived from the index so it is stable
  // and the date filter has a meaningful range to work with.
  const dayOffset = Math.floor(rnd() * 5475); // up to 15y of days
  const base = Date.UTC(2010, 0, 1) + dayOffset * 86_400_000;
  const d = new Date(base);
  const hireDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  const trend = Array.from({ length: 12 }, () => Math.floor(rnd() * 100));

  return {
    id: index + 1,
    firstName,
    lastName,
    email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, "") +
      "@terax.dev",
    department,
    status,
    salary,
    hireDate,
    active: status === "active" || status === "onboarding",
    performance,
    trend,
    notes: `Row ${index + 1} — ${department} / ${status}`,
  };
}

/**
 * Generate the half-open block [startRow, endRow), clamped to the dataset size.
 * Returns the rows plus the definitive total so the caller can tell the grid
 * where the data ends.
 */
export function generateBlock(
  startRow: number,
  endRow: number,
  total: number = SYNTHETIC_ROW_COUNT,
): { rows: GridRow[]; total: number } {
  const start = Math.max(0, startRow);
  const end = Math.min(total, Math.max(start, endRow));
  const rows: GridRow[] = [];
  for (let i = start; i < end; i++) rows.push(generateRow(i));
  return { rows, total };
}
