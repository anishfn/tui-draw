/**
 * src/client/ui/theme.ts
 * --------------------------------------------------------------------------
 * Catppuccin Mocha palette + semantic accent mapping shared across the TUI.
 *
 * `MOCHA` is the raw named palette; `C` maps it to UI roles so views never
 * hard-code hex. The drawing `PALETTE` is the 8-slot ink set (keys 1-8).
 * Reference: https://github.com/catppuccin/catppuccin (Mocha flavor)
 * --------------------------------------------------------------------------
 */

import type { Color } from "../../types/index.ts";

/** The full Catppuccin Mocha palette. */
export const MOCHA = {
  rosewater: "#f5e0dc",
  flamingo: "#f2cdcd",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  maroon: "#eba0ac",
  peach: "#fab387",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  sky: "#89dceb",
  sapphire: "#74c7ec",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
} as const;

/** The 8 ink colors the drawer cycles through with keys 1-8. */
export const PALETTE: readonly Color[] = [
  MOCHA.text,   // 1 white
  MOCHA.red,    // 2
  MOCHA.peach,  // 3
  MOCHA.yellow, // 4
  MOCHA.green,  // 5
  MOCHA.teal,   // 6
  MOCHA.blue,   // 7
  MOCHA.mauve,  // 8
] as const;

/** Short human names for each palette slot (shown in the tool indicator). */
export const PALETTE_NAMES: readonly string[] = [
  "white", "red", "peach", "yellow",
  "green", "teal", "blue", "mauve",
];

/** Semantic accent colors for chrome, status, and feedback. */
export const C = {
  accent: MOCHA.blue,
  accentDim: MOCHA.sapphire,
  good: MOCHA.green,
  warn: MOCHA.yellow,
  bad: MOCHA.red,
  info: MOCHA.sky,
  text: MOCHA.text,
  muted: MOCHA.overlay1,
  border: MOCHA.surface1,
  borderActive: MOCHA.blue,
  base: MOCHA.base,
  mantle: MOCHA.mantle,
  surface: MOCHA.surface0,
} as const;

/**
 * Render a fixed-width ASCII progress bar color, by how full it is
 * (green -> yellow -> red as it drains).
 */
export function barColor(fraction: number): Color {
  if (fraction > 0.5) return C.good;
  if (fraction > 0.25) return C.warn;
  return C.bad;
}
