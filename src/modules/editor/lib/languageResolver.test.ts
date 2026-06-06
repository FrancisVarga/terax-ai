import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { resolveLanguage } from "./languageResolver";

/**
 * Reproduce what CodeMirror's `toggleComment` does: build a state with the
 * resolved language extension and ask the state for `commentTokens` at the
 * cursor. If this returns a `{ line }` (or block) token, Ctrl+/ works.
 */
async function commentTokensFor(
  filename: string,
): Promise<{ line?: string; block?: { open: string; close: string } } | null> {
  const ext = await resolveLanguage(filename);
  const state = EditorState.create({
    doc: "key = value\n",
    extensions: ext ? [ext] : [],
  });
  const tokens = state.languageDataAt<{
    line?: string;
    block?: { open: string; close: string };
  }>("commentTokens", 0);
  return tokens[0] ?? null;
}

describe("resolveLanguage comment tokens (Ctrl+/ support)", () => {
  it("resolves a language for known source extensions", async () => {
    expect(await resolveLanguage("a.ts")).not.toBeNull();
    expect(await resolveLanguage("a.py")).not.toBeNull();
    expect(await resolveLanguage("a.rs")).not.toBeNull();
  });

  it("gives .env files a # line comment", async () => {
    const t = await commentTokensFor(".env");
    expect(t?.line).toBe("#");
  });

  it("gives .env.local files a # line comment", async () => {
    const t = await commentTokensFor(".env.local");
    expect(t?.line).toBe("#");
  });

  it("gives PowerShell files their native # comment token", async () => {
    const t = await commentTokensFor("deploy.ps1");
    expect(t?.line).toBe("#");
    expect(t?.block).toEqual({ open: "<#", close: "#>" });
  });

  it("gives batch files a REM line comment", async () => {
    const t = await commentTokensFor("run.bat");
    expect(t?.line).toBe("REM ");
  });

  it("gives .ini / .conf files a # line comment", async () => {
    expect((await commentTokensFor("app.ini"))?.line).toBe("#");
    expect((await commentTokensFor("nginx.conf"))?.line).toBe("#");
  });

  it("gives Dart files // and /* */ comment tokens", async () => {
    const t = await commentTokensFor("main.dart");
    expect(t?.line).toBe("//");
    expect(t?.block).toEqual({ open: "/*", close: "*/" });
  });

  it("gives Kotlin/Scala files // comment tokens", async () => {
    expect((await commentTokensFor("App.kt"))?.line).toBe("//");
    expect((await commentTokensFor("App.scala"))?.line).toBe("//");
  });

  it("keeps shell's own # comment token (not overridden)", async () => {
    expect((await commentTokensFor("script.sh"))?.line).toBe("#");
  });

  it("resolves a language for .nix files", async () => {
    expect(await resolveLanguage("flake.nix")).not.toBeNull();
    expect(await resolveLanguage("shell.nix")).not.toBeNull();
  });

  it("gives .nix files # line and /* */ block comment tokens", async () => {
    const t = await commentTokensFor("default.nix");
    expect(t?.line).toBe("#");
    expect(t?.block).toEqual({ open: "/*", close: "*/" });
  });

  it("tokenizes a Nix sample without stalling (forward progress)", async () => {
    // A StreamParser that ever returns a token without advancing the stream
    // throws "Stream parser - no progress" inside highlightTree. Drive the
    // resolved language over a sample touching strings, antiquotation, paths,
    // multiline strings and comments to assert it always advances.
    const { ensureSyntaxTree } = await import("@codemirror/language");
    const ext = await resolveLanguage("flake.nix");
    const doc = [
      "# a comment",
      "/* block",
      "   comment */",
      "{ pkgs ? import <nixpkgs> {} }:",
      "rec {",
      '  name = "hello-${pkgs.version}";',
      "  src = ./src;",
      "  text = ''",
      "    multi ${line}",
      "  '';",
      "  flag = true;",
      "}",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: ext ? [ext] : [] });
    // Force a full parse; throws if the parser stalls.
    expect(() => ensureSyntaxTree(state, doc.length, 5000)).not.toThrow();
  });

  it("falls back to # for unknown extensions (all regular files)", async () => {
    expect((await commentTokensFor("weird.xyzlang"))?.line).toBe("#");
  });

  it("falls back to # for extension-less files", async () => {
    expect((await commentTokensFor("LICENSE"))?.line).toBe("#");
  });
});
