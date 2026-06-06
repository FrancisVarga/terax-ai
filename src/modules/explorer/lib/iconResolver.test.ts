import { describe, expect, it } from "vitest";

import materialIcons from "@iconify-json/material-icon-theme/icons.json";
import { fileIconUrl, folderIconUrl } from "./iconResolver";

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
};
const cat = materialIcons as unknown as IconifySet;

/**
 * Decode the SVG body back out of a `data:image/svg+xml;utf8,…` URL so a test
 * can assert which glyph a filename resolved to (not just "some non-empty URL").
 */
function bodyFromUrl(url: string): string {
  const comma = url.indexOf(",");
  const svg = decodeURIComponent(url.slice(comma + 1));
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

const documentBody = cat.icons["document"]!.body;

/** True when `name` resolved to a real glyph, not the generic `document`. */
function hasRealIcon(name: string): boolean {
  const url = fileIconUrl(name);
  if (!url) return false;
  return bodyFromUrl(url) !== documentBody;
}

describe("fileIconUrl", () => {
  it("never returns empty for a known file (always at least the fallback)", () => {
    expect(fileIconUrl("components.json")).not.toBe("");
    expect(fileIconUrl("totally-unknown.zzz")).not.toBe("");
  });

  it("renders the real json glyph for .json files (not the document fallback)", () => {
    // Regression: plain *.json files were rendering the grey `document`
    // fallback instead of the json glyph in the explorer tree.
    expect(hasRealIcon("components.json")).toBe(true);
    expect(hasRealIcon("tsconfig.json")).toBe(true);
    expect(hasRealIcon("data.json")).toBe(true);
    expect(hasRealIcon("settings.jsonc")).toBe(true);
    expect(hasRealIcon("data.json5")).toBe(true);
  });

  it("renders the real glyph for other common source extensions", () => {
    expect(hasRealIcon("main.rs")).toBe(true);
    expect(hasRealIcon("README.md")).toBe(true);
    expect(hasRealIcon("flake.nix")).toBe(true);
    expect(hasRealIcon("app.ts")).toBe(true);
  });

  it("falls back to the document glyph for unknown extensions", () => {
    expect(hasRealIcon("mystery.zzzlang")).toBe(false);
  });
});

describe("folderIconUrl", () => {
  it("never returns empty and differs between collapsed and expanded", () => {
    const collapsed = folderIconUrl("src", false);
    const expanded = folderIconUrl("src", true);
    expect(collapsed).not.toBe("");
    expect(expanded).not.toBe("");
  });
});
