import { describe, expect, it } from "vitest";
import {
  assembleEntries,
  groupLog,
  type LogEntry,
} from "./groupLog";
import { parseAnsiLog } from "./parseAnsiLog";

const entries = (raw: string): LogEntry[] => assembleEntries(parseAnsiLog(raw));
const msgs = (es: LogEntry[]) => es.map((e) => e.segments.map((s) => s.text).join(""));

describe("assembleEntries — continuation folding", () => {
  it("folds indented lines under the preceding entry", () => {
    const es = entries("Error: boom\n    at foo (x.ts:1)\n    at bar (y.ts:2)\nnext");
    expect(es).toHaveLength(2);
    expect(es[0].continuation).toHaveLength(2);
    expect(msgs(es)).toEqual(["Error: boom", "next"]);
  });

  it("folds stack frames starting with 'at '", () => {
    const es = entries("Exception thrown\nat Module.run\nat main");
    expect(es).toHaveLength(1);
    expect(es[0].continuation).toHaveLength(2);
  });

  it("treats an orphan continuation as its own entry", () => {
    const es = entries("    leading indent with no parent");
    expect(es).toHaveLength(1);
    expect(es[0].continuation).toHaveLength(0);
  });

  it("a blank line ends a fold and is its own entry", () => {
    const es = entries("head\n    detail\n\ntail");
    expect(msgs(es)).toEqual(["head", "", "tail"]);
    expect(es[0].continuation).toHaveLength(1);
  });
});

describe("field extraction", () => {
  it("peels an ISO timestamp", () => {
    const [e] = entries("2026-05-30T12:00:00Z server ready");
    expect(e.fields.ts).toBe("2026-05-30T12:00:00Z");
    expect(e.fields.message).toContain("server ready");
  });

  it("peels a bracketed source prefix", () => {
    const [e] = entries("[vite] page reload");
    expect(e.fields.source).toBe("vite");
  });

  it("peels a colon source prefix", () => {
    const [e] = entries("hmr: update applied");
    expect(e.fields.source).toBe("hmr");
  });

  it("pretty-prints a trailing JSON object", () => {
    const [e] = entries('config loaded {"port":5173,"open":true}');
    expect(e.fields.json).toBe('{\n  "port": 5173,\n  "open": true\n}');
  });

  it("leaves json undefined when the tail is not JSON", () => {
    const [e] = entries("plain message with { brace");
    expect(e.fields.json).toBeUndefined();
  });
});

describe("groupLog modes", () => {
  it("collapse coalesces adjacent identical entries with a count", () => {
    const [g] = groupLog(parseAnsiLog("ping\nping\nping\npong"), "collapse");
    expect(g.entries).toHaveLength(2);
    expect(g.entries[0].count).toBe(3);
    expect(g.entries[1].count).toBe(1);
  });

  it("collapse does not merge non-adjacent duplicates", () => {
    const [g] = groupLog(parseAnsiLog("a\nb\na"), "collapse");
    expect(g.entries).toHaveLength(3);
  });

  it("severity buckets entries into level sections in fixed order", () => {
    const groups = groupLog(
      parseAnsiLog("info ok\nERROR bad\nwarn meh\ninfo ok2"),
      "severity",
    );
    expect(groups.map((x) => x.label)).toEqual(["error", "warn", "info"]);
    expect(groups.find((x) => x.label === "info")!.entries).toHaveLength(2);
  });

  it("source buckets entries by detected prefix", () => {
    const groups = groupLog(
      parseAnsiLog("[vite] a\n[tsc] b\n[vite] c"),
      "source",
    );
    const vite = groups.find((x) => x.label === "vite");
    expect(vite!.entries).toHaveLength(2);
  });

  it("none returns a single section in stream order", () => {
    const groups = groupLog(parseAnsiLog("x\ny"), "none");
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(2);
  });
});
