import { describe, expect, it } from "vitest";
import { parseAnsiLog } from "./parseAnsiLog";

const plain = (raw: string) =>
  parseAnsiLog(raw).map((l) => l.segments.map((s) => s.text).join(""));

describe("parseAnsiLog", () => {
  it("splits into 1-based numbered lines", () => {
    const lines = parseAnsiLog("a\nb\nc");
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(plain("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("normalizes CRLF and drops a single trailing newline", () => {
    expect(plain("x\r\ny\n")).toEqual(["x", "y"]);
  });

  it("keeps a blank line that is not the phantom trailing one", () => {
    expect(plain("x\n\ny")).toEqual(["x", "", "y"]);
  });

  it("strips ANSI escapes from the visible text", () => {
    // red "fail" then reset
    expect(plain("\x1b[31mfail\x1b[0m")).toEqual(["fail"]);
  });

  it("classifies severity from ANSI-stripped text, not escape bytes", () => {
    const [line] = parseAnsiLog("\x1b[31mERROR: boom\x1b[0m");
    expect(line.level).toBe("error");
  });

  it("classifies warn / info / none", () => {
    expect(parseAnsiLog("WARN slow")[0].level).toBe("warn");
    expect(parseAnsiLog("info: ready")[0].level).toBe("info");
    expect(parseAnsiLog("just some text")[0].level).toBe("none");
  });

  it("carries ANSI color onto the styled segment", () => {
    const [line] = parseAnsiLog("\x1b[32mok\x1b[0m");
    const colored = line.segments.find((s) => s.text === "ok");
    expect(colored?.color).toBeTruthy();
  });

  it("extracts a URL into a link segment without trailing punctuation", () => {
    const [line] = parseAnsiLog("Local: http://localhost:5173/ ready.");
    const link = line.segments.find((s) => s.url);
    expect(link?.url).toBe("http://localhost:5173/");
  });

  it("does not swallow a trailing period into the URL", () => {
    const [line] = parseAnsiLog("see https://example.com.");
    const link = line.segments.find((s) => s.url);
    expect(link?.url).toBe("https://example.com");
  });

  it("returns no lines for empty input", () => {
    expect(parseAnsiLog("")).toEqual([]);
  });
});
