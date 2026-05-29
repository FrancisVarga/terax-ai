import type { Theme } from "../types";

/**
 * Titanium — a modern glassy metallic dark theme. Surfaces are translucent
 * cool-steel tones (rgba) so the app's blur/background shows through as frosted
 * glass, while foregrounds stay near-white for high readability. A polished
 * chrome-blue accent gives the metallic highlight.
 */
export const metal: Theme = {
  id: "metal",
  name: "Titanium",
  description: "Glassy metallic dark — frosted steel surfaces, chrome accent.",
  glass: true,
  editorTheme: { dark: "tokyo-night" },
  variants: {
    dark: {
      colors: {
        // Deep gunmetal base with a faint blue cast.
        background: "#0c0f14",
        foreground: "#e8edf2",
        // Frosted glass surfaces: light tint at low alpha over the dark base.
        card: "rgba(148,163,184,0.07)",
        cardForeground: "#e8edf2",
        popover: "rgba(20,26,34,0.92)",
        popoverForeground: "#e8edf2",
        // Polished chrome-blue accent for primary actions.
        primary: "#9ec5e8",
        primaryForeground: "#0c0f14",
        secondary: "rgba(148,163,184,0.10)",
        secondaryForeground: "#e8edf2",
        muted: "rgba(148,163,184,0.08)",
        mutedForeground: "#9fb0bd",
        accent: "rgba(158,197,232,0.16)",
        accentForeground: "#e8edf2",
        destructive: "#ff6b81",
        // Bright metallic edges — the glass rim.
        border: "rgba(184,204,224,0.14)",
        input: "rgba(184,204,224,0.18)",
        ring: "rgba(158,197,232,0.55)",
        sidebar: "rgba(255,255,255,0.04)",
        sidebarForeground: "#e8edf2",
        sidebarPrimary: "#9ec5e8",
        sidebarPrimaryForeground: "#0c0f14",
        sidebarAccent: "rgba(158,197,232,0.16)",
        sidebarAccentForeground: "#e8edf2",
        sidebarBorder: "rgba(184,204,224,0.12)",
        sidebarRing: "rgba(158,197,232,0.55)",
        radius: "0.7rem",
      },
      terminal: {
        background: "#0c0f14",
        foreground: "#dbe3ec",
        cursor: "#9ec5e8",
        cursorAccent: "#0c0f14",
        selection: "rgba(158,197,232,0.25)",
        ansi: [
          "#3b424d", "#ff6b81", "#7ee0a0", "#f3c969",
          "#9ec5e8", "#c4a7f0", "#7fd6e3", "#c5cfd9",
          "#5a6573", "#ff8b9d", "#9cecb8", "#ffd98a",
          "#bcd9f5", "#d6c2ff", "#a3e7f2", "#eef3f8",
        ],
      },
    },
  },
};
