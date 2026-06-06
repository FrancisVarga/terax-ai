/**
 * Native external-formatter clients for languages with no in-browser
 * (Prettier/WASM) formatter. These shell out, via a Tauri command, to a CLI on
 * the user's PATH (see `src-tauri/src/modules/extfmt`).
 *
 * Contract mirrors `formatWithPrettier`:
 *   - `string` → formatted output
 *   - `null`   → no native formatter installed (caller falls back to reindent)
 * and throws if the formatter ran but failed (e.g. a syntax error), so the
 * caller can surface the message instead of silently clobbering the buffer.
 */
import { invoke } from "@tauri-apps/api/core";

/** Extensions handled by a native sidecar formatter (not Prettier). */
const NATIVE_EXTS = new Set(["nix"]);

function extOf(path: string): string | null {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

/** True when `path` has a native sidecar formatter (used to gate routing). */
export function hasNativeFormatter(path: string): boolean {
  const ext = extOf(path);
  return ext != null && NATIVE_EXTS.has(ext);
}

/**
 * Format `source` for `path` with a native sidecar, if one applies to the
 * extension. Resolves to the formatted string, or `null` when the extension has
 * no native formatter OR the formatter binary is not installed. Rejects when a
 * formatter ran and failed.
 */
export async function formatWithNative(
  path: string,
  source: string,
): Promise<string | null> {
  const ext = extOf(path);
  if (ext === "nix") {
    // Rust returns Option<String>: null = no nixfmt/alejandra/nixpkgs-fmt on
    // PATH (caller reindents); a string = formatted; an Err rejects the invoke.
    return invoke<string | null>("format_nix", { source });
  }
  return null;
}
