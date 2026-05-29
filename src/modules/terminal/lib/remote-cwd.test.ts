import { describe, expect, it, vi } from "vitest";
import {
  bindRemoteCwd,
  buildRemoteCwdHookCommand,
  decodeRemoteCwd,
  getRemoteCwdBinding,
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
});
