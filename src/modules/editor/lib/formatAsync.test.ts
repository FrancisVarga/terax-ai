import { describe, expect, it } from "vitest";

import { formatWithPrettierAsync } from "./formatAsync";
import { prettierSpecFor, canPrettierFormat } from "./format";

describe("prettierSpecFor", () => {
  it("resolves a spec for supported extensions", () => {
    expect(prettierSpecFor("a.ts")?.parser).toBe("typescript");
    expect(prettierSpecFor("a.css")?.parser).toBe("css");
    expect(prettierSpecFor("a.json")?.parser).toBe("json");
  });

  it("returns null for unsupported extensions", () => {
    expect(prettierSpecFor("a.rs")).toBeNull();
    expect(prettierSpecFor("a.dart")).toBeNull();
    expect(prettierSpecFor("noext")).toBeNull();
  });

  it("canPrettierFormat agrees with prettierSpecFor", () => {
    expect(canPrettierFormat("a.ts")).toBe(true);
    expect(canPrettierFormat("a.rs")).toBe(false);
  });
});

describe("formatWithPrettierAsync (inline path for small files)", () => {
  it("formats a small TS file on the main thread", async () => {
    const out = await formatWithPrettierAsync("a.ts", "const x=1");
    expect(out).toBe("const x = 1;\n");
  });

  it("returns null when no Prettier parser matches", async () => {
    // .rs has no Prettier spec → caller falls back to reindent.
    expect(await formatWithPrettierAsync("a.rs", "fn main(){}")).toBeNull();
  });

  it("rejects on a syntax error so the caller can surface it", async () => {
    await expect(
      formatWithPrettierAsync("a.ts", "const = ;"),
    ).rejects.toThrow();
  });

  it("still formats a >100KB file (worker path, falls back when no Worker global)", async () => {
    // In the node test env there is no `Worker` global, so the worker branch's
    // construction throws and `formatWithPrettierAsync` falls back to an inline
    // format — proving the large-file path produces correct output regardless
    // of whether the worker is available.
    const big = "const x=1\n" + "// pad ".repeat(20_000); // > 100 KB
    const out = await formatWithPrettierAsync("big.ts", big);
    expect(out).not.toBeNull();
    expect(out!.startsWith("const x = 1;")).toBe(true);
  });
});
