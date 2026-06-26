/**
 * src/client/ui/theme.ts
 * --------------------------------------------------------------------------
 * Central palette + accent colors shared across the TUI.
 *
 * Keeping every color in one place lets the whole app share a cohesive look
 * instead of scattering hex strings through the views. All values are plain
 * `#rrggbb` so they work everywhere OpenTUI accepts a color.
 * --------------------------------------------------------------------------
 */

import type { Color } from "../../types/index.ts";

/** The 8 ink colors the drawer cycles through with keys 1-8. */
export const PALETTE: readonly Color[] = [
  "#e0def4", "#eb6f92", "#f6c177", "#9ccfd8",
  "#31748f", "#c4a7e7", "#ebbcba", "#3e8fb0",
] as const;

/** Short human names for each palette slot (shown in the tool indicator). */
export const PALETTE_NAMES: readonly string[] = [
  "white", "red", "gold", "cyan",
  "teal", "lilac", "rose", "blue",
];

/** Semantic accent colors for chrome, status, and feedback. */
export const C = {
  accent: "#cba6f7",
  accentDim: "#6c7086",
  good: "#a6e3a1",
  warn: "#f9e2af",
  bad: "#f38ba8",
  info: "#89dceb",
  text: "#cdd6f4",
  muted: "#6c7086",
  border: "#45475a",
  borderActive: "#cba6f7",
} as const;

/**
 * Render a fixed-width ASCII progress bar, colored by how full it is
 * (green → yellow → red as it drains). Returns `[####------]`-style text.
 */
export function barColor(fraction: number): Color {
  if (fraction > 0.5) return C.good;
  if (fraction > 0.25) return C.warn;
  return C.bad;
}
