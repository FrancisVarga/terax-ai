import { describe, expect, it, vi } from "vitest";
import {
  bindRemoteCwd,
  buildRemoteCwdHookCommand,
  decodeRemoteCwd,
  getRemoteCwdBinding,
  markRemoteCwdAcked,
  newRemoteCwdNonce,
  unbindRemoteCwd,
} from "./remote-cwd";

describe("decodeRemoteCwd — strict validation of OSC 7704 payloads", () => {
  it("decodes a percent-encoded absolute path", () => {
    expect(decodeRemoteCwd("%2Fhome%2Fme%2Fproj")).toBe("/home/me/proj");
  });

  it("round-trips spaces, %, and unicode", () => {
    const path = "/home/me/a b/100%/café";
    const enc = encodeURIComponent(path);
    expect(decodeRemoteCwd(enc)).toBe(path);
  });

  it("rejects relative paths", () => {
    expect(decodeRemoteCwd("home%2Fme")).toBeNull();
    expect(decodeRemoteCwd(".%2Frel")).toBeNull();
  });

  it("rejects paths containing control characters", () => {
    // Encoded NUL, newline, ESC.
    expect(decodeRemoteCwd("%2Fhome%00")).toBeNull();
    expect(decodeRemoteCwd("%2Fhome%0A")).toBeNull();
    expect(decodeRemoteCwd("%2Fhome%1B")).toBeNull();
  });

  it("rejects malformed percent-encoding", () => {
    expect(decodeRemoteCwd("%2")).toBeNull();
    expect(decodeRemoteCwd("%ZZ")).toBeNull();
  });

  it("collapses double slashes and strips trailing slash (keeps root)", () => {
    expect(decodeRemoteCwd(encodeURIComponent("/a//b/"))).toBe("/a/b");
    expect(decodeRemoteCwd(encodeURIComponent("/"))).toBe("/");
  });
});

describe("remote cwd bindings — leaf-scoped, lifecycle-bound", () => {
  it("stores and retrieves a binding, then clears it", () => {
    const onRemoteCwd = vi.fn();
    bindRemoteCwd(99, { alias: "box", nonce: "n1", onRemoteCwd });
    expect(getRemoteCwdBinding(99)?.alias).toBe("box");
    unbindRemoteCwd(99);
    expect(getRemoteCwdBinding(99)).toBeUndefined();
  });

  it("markRemoteCwdAcked flips the binding's acked flag (retry-loop signal)", () => {
    const onRemoteCwd = vi.fn();
    bindRemoteCwd(100, { alias: "box", nonce: "n1", onRemoteCwd });
    expect(getRemoteCwdBinding(100)?.acked).toBeFalsy();
    markRemoteCwdAcked(100);
    expect(getRemoteCwdBinding(100)?.acked).toBe(true);
    unbindRemoteCwd(100);
  });

  it("markRemoteCwdAcked is a no-op for an unbound leaf", () => {
    expect(() => markRemoteCwdAcked(12345)).not.toThrow();
    expect(getRemoteCwdBinding(12345)).toBeUndefined();
  });
});

describe("newRemoteCwdNonce", () => {
  it("returns a 32-char hex token", () => {
    const n = newRemoteCwdNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(n).not.toBe(newRemoteCwdNonce());
  });
});

describe("buildRemoteCwdHookCommand", () => {
  it("embeds the nonce and emits OSC 7704", () => {
    const cmd = buildRemoteCwdHookCommand("DEADBEEF");
    expect(cmd).toContain("7704;DEADBEEF;");
    expect(cmd).toContain("ZSH_VERSION"); // zsh branch present
    expect(cmd).toContain("PROMPT_COMMAND"); // bash/sh branch present
  });

  it("includes a fish branch guarded by FISH_VERSION", () => {
    const cmd = buildRemoteCwdHookCommand("CAFE");
    expect(cmd).toContain("set -q FISH_VERSION");
    expect(cmd).toContain("--on-event fish_prompt"); // fish precmd equivalent
    // The nonce must appear in both the POSIX and fish OSC 7704 emitters.
    const occurrences = cmd.split("7704;CAFE;").length - 1;
    expect(occurrences).toBe(2);
  });

  it("guards both blocks with the && form so fish doesn't parse-abort", () => {
    const cmd = buildRemoteCwdHookCommand("X");
    // The OUTER guards (the part fish/PowerShell actually parse) must be the
    // `&&` form, not `if … then … fi`. An eager fish parser aborts the whole
    // line on a top-level POSIX `if/then/fi`. (The zsh branch DOES use if/fi,
    // but it lives inside the single-quoted eval string — never parsed by the
    // wrong shell.)
    expect(cmd).toContain("command -v od >/dev/null 2>&1 && eval '");
    expect(cmd).toContain("set -q FISH_VERSION && eval '");
    expect(cmd).not.toContain("if command -v od");
  });
});
