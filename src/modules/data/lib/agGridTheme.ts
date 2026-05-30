import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";

let registered = false;

/**
 * Register every AG Grid community feature exactly once. Called from the grid
 * panes (DataPane / S3ParquetGrid) rather than at app boot so the ag-grid
 * bundle code-splits into a lazy chunk and stays out of the startup critical
 * path. The module-level guard makes repeat calls across grid instances free.
 */
export function ensureAgGridRegistered(): void {
  if (registered) return;
  ModuleRegistry.registerModules([AllCommunityModule]);
  registered = true;
}

/**
 * Build an AG Grid theme matched to the app's current palette.
 *
 * The app's themes express colors as CSS custom properties (`--background`,
 * `--foreground`, …) on the document root. We resolve those to concrete color
 * strings via `getComputedStyle` and feed them to AG Grid's Theming API, so the
 * grid tracks *any* loaded theme — built-in or user-custom — not just a
 * hardcoded dark/light pair.
 *
 * AG Grid derives some colors (hover, selection) by alpha-blending the params
 * we pass, so we hand it resolved values rather than raw `var(--x)` references,
 * which it cannot blend.
 */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function buildDataGridTheme(mode: "dark" | "light") {
  const background = readVar("--background", mode === "dark" ? "#111" : "#fff");
  const foreground = readVar("--foreground", mode === "dark" ? "#eee" : "#111");
  const card = readVar("--card", background);
  const border = readVar("--border", mode === "dark" ? "#333" : "#e5e5e5");
  const accent = readVar("--ring", mode === "dark" ? "#5b8" : "#37c");
  const accentMuted = readVar(
    "--accent",
    mode === "dark" ? "#2a2a2a" : "#eee",
  );

  // Only verified AG Grid v35 theme params — `withParams` is typed, so an
  // unknown key is a compile error.
  return themeQuartz.withParams({
    backgroundColor: background,
    foregroundColor: foreground,
    borderColor: border,
    accentColor: accent,
    headerBackgroundColor: card,
    headerTextColor: foreground,
    headerFontWeight: 600,
    oddRowBackgroundColor: card,
    rowHoverColor: accentMuted,
    selectedRowBackgroundColor: accentMuted,
    fontSize: 12,
    headerHeight: 30,
    rowHeight: 28,
    borderRadius: 4,
  });
}
