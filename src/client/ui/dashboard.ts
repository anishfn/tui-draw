/**
 * src/client/ui/dashboard.ts
 * --------------------------------------------------------------------------
 * Master layout shell.
 *
 * Splits the terminal workspace into two flex regions:
 *   ┌────────────────────────────┬───────────────────┐
 *   │  Left: drawing canvas       │  Right: sidebar   │
 *   │  (bordered, grows to fill)  │  (fixed width 35) │
 *   └────────────────────────────┴───────────────────┘
 *
 * Theme-free: no background or color overrides — the layout inherits the
 * terminal's own palette. The left pane carries a status header above the
 * {@link CanvasHandle}; the right pane is the {@link SidebarHandle}.
 * --------------------------------------------------------------------------
 */

import { BoxRenderable, TextRenderable, fg, t, type CliRenderer } from "@opentui/core";
import { createCanvas, type CanvasHandle, type CanvasOptions } from "./canvas.ts";
import { createSidebar, type SidebarHandle, type SidebarOptions } from "./sidebar.ts";

export interface CanvasStatus {
  hint: string;
  timeLeft: number;
  round: number;
  drawing: boolean;
  mode: string;
  color: string;
  size: number;
  erasing: boolean;
}

export interface DashboardHandle {
  readonly root: BoxRenderable;
  readonly canvas: CanvasHandle;
  readonly sidebar: SidebarHandle;
  setCanvasStatus(status: CanvasStatus): void;
  setFooter(text: string): void;
}

export function createDashboard(
  renderer: CliRenderer,
  wiring: { canvas: CanvasOptions; sidebar: SidebarOptions },
): DashboardHandle {
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "row",
    gap: 1,
    padding: 1,
  });

  /* --- Left: canvas pane ----------------------------------------------- */
  const leftPane = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    title: " Canvas ",
    titleAlignment: "center",
  });

  const statusBar = new TextRenderable(renderer, {
    content: "Connecting…",
    flexShrink: 0,
    paddingLeft: 1,
  });

  const canvas = createCanvas(renderer, wiring.canvas);

  const footer = new TextRenderable(renderer, {
    content: "",
    flexShrink: 0,
    paddingLeft: 1,
  });

  leftPane.add(statusBar);
  leftPane.add(canvas.renderable);
  leftPane.add(footer);

  /* --- Right: sidebar -------------------------------------------------- */
  const sidebar = createSidebar(renderer, wiring.sidebar);

  root.add(leftPane);
  root.add(sidebar.container);

  return {
    root,
    canvas,
    sidebar,
    setCanvasStatus({ hint, timeLeft, round, drawing, mode, color, size, erasing }) {
      if (drawing) {
        const brushIcon = mode === "braille" ? "⠿" : "▉";
        if (erasing) {
          statusBar.content = `R${round}  ⏱${timeLeft}s   ✎ YOU DRAW   ${hint}   🧹 eraser  ↔${size}`;
        } else {
          statusBar.content = t`R${String(round)}  ⏱${String(timeLeft)}s   ✎ YOU DRAW   ${hint}   ${brushIcon} ${fg(color)("●")}  ↔${String(size)}`;
        }
      } else {
        statusBar.content = `R${round}  ⏱${timeLeft}s   guessing…   ${hint}`;
      }
    },
    setFooter(text) {
      footer.content = text;
    },
  };
}
