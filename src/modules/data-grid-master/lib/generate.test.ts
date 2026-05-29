import { describe, expect, it } from "vitest";
import { generateBlock, generateRow } from "./generate";
import { SYNTHETIC_ROW_COUNT } from "./types";

describe("generateRow — determinism", () => {
  it("yields the identical row for the same index", () => {
    // The infinite row model refetches blocks after sort/eviction; a row must
    // be stable across calls or the grid shows shifting data.
    expect(generateRow(0)).toEqual(generateRow(0));
    expect(generateRow(12_345)).toEqual(generateRow(12_345));
  });

  it("yields different rows for different indices", () => {
    expect(generateRow(0)).not.toEqual(generateRow(1));
  });

  it("uses a 1-based stable id derived from the index", () => {
    expect(generateRow(0).id).toBe(1);
    expect(generateRow(99).id).toBe(100);
  });

  it("produces a 12-point trend series in range", () => {
    const r = generateRow(7);
    expect(r.trend).toHaveLength(12);
    for (const v of r.trend) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it("keeps performance within 0..100 and a parseable ISO hire date", () => {
    const r = generateRow(500);
    expect(r.performance).toBeGreaterThanOrEqual(0);
    expect(r.performance).toBeLessThanOrEqual(100);
    expect(r.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(r.hireDate))).toBe(false);
  });
});

describe("generateBlock — boundaries", () => {
  it("returns the half-open window [start, end)", () => {
    const { rows } = generateBlock(10, 13);
    expect(rows.map((r) => r.id)).toEqual([11, 12, 13]);
  });

  it("clamps the end to the total so the last block is short", () => {
    const total = 25;
    const { rows } = generateBlock(20, 30, total);
    expect(rows).toHaveLength(5); // rows 20..24
    expect(rows[rows.length - 1].id).toBe(25);
  });

  it("returns an empty block past the end and never exceeds total", () => {
    const total = 25;
    expect(generateBlock(25, 30, total).rows).toHaveLength(0);
    expect(generateBlock(30, 40, total).rows).toHaveLength(0);
  });

  it("reports the dataset total so the grid can stop paging", () => {
    expect(generateBlock(0, 10).total).toBe(SYNTHETIC_ROW_COUNT);
  });

  it("matches generateRow for each index in the block (no off-by-one)", () => {
    const { rows } = generateBlock(100, 103);
    expect(rows[0]).toEqual(generateRow(100));
    expect(rows[2]).toEqual(generateRow(102));
  });
});
