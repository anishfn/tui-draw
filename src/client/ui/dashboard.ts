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
import type { GamePhase } from "../../types/index.ts";
import { createCanvas, type CanvasHandle, type CanvasOptions } from "./canvas.ts";
import { createSidebar, type SidebarHandle, type SidebarOptions } from "./sidebar.ts";

export interface CanvasStatus {
  phase: GamePhase;
  hint: string;
  timeLeft: number;
  round: number;
  /** We currently hold the pen (drawing phase). */
  drawing: boolean;
  /** We are the drawer picking a word (selecting phase). */
  choosing: boolean;
  /** We are the room host (may start the game from the lobby). */
  amHost: boolean;
  /** Whether there are enough players for the host to start. */
  enoughPlayers: boolean;
  /** Display name of the current drawer (for guessers' banners). */
  drawerName: string;
  /** The three words offered to us while choosing. */
  wordChoices: string[];
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
  /** Show the room code + name on top of the canvas pane. */
  setRoom(code: string, name: string): void;
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
    content: "Connecting...",
    flexShrink: 0,
    paddingLeft: 1,
  });

  const canvas = createCanvas(renderer, wiring.canvas);

  leftPane.add(statusBar);
  leftPane.add(canvas.renderable);

  /* --- Right: sidebar -------------------------------------------------- */
  const sidebar = createSidebar(renderer, wiring.sidebar);

  root.add(leftPane);
  root.add(sidebar.container);

  /* --- Canvas sizing ---------------------------------------------------- */
  // The canvas framebuffer must be sized explicitly to the laid-out pane: it
  // blits with no clipping and can't cross-axis-stretch, so we feed it the
  // pane's interior every frame. Cheap — `resize()` no-ops when unchanged.
  const fitCanvas = (): void => {
    const w = leftPane.width - 2; // minus left/right border
    const h = leftPane.height - 2 - statusBar.height;
    if (w > 0 && h > 0) canvas.resize(w, h);
  };
  renderer.setFrameCallback(async () => fitCanvas());

  return {
    root,
    canvas,
    sidebar,
    setCanvasStatus(s) {
      const { phase, hint, timeLeft, round, drawing, choosing, mode, color, size, erasing } = s;

      if (phase === "lobby") {
        statusBar.content = s.amHost
          ? s.enoughPlayers
            ? t`${fg("#a6e3a1")("* Lobby")}   You are the host - press ${fg("#f9e2af")("[S]")} to start the game`
            : t`${fg("#f9e2af")("* Lobby")}   Waiting for more players... (need at least 2)`
          : t`${fg("#89dceb")("* Lobby")}   Waiting for the host to start the game...`;
        return;
      }

      if (phase === "selecting") {
        if (choosing) {
          const choices = s.wordChoices.length
            ? s.wordChoices
                .map((w, i) => `[${i + 1}] ${w}`)
                .join("   ")
            : "...";
          statusBar.content = t`[${String(timeLeft)}s]   ${fg("#f9e2af")("Choose a word:")}   ${choices}`;
        } else {
          statusBar.content = `[${timeLeft}s]   ${s.drawerName || "Someone"} is choosing a word...`;
        }
        return;
      }

      if (phase === "intermission") {
        statusBar.content = t`${fg("#f38ba8")("* Round over")}   next turn in ${String(timeLeft)}s...`;
        return;
      }

      // drawing phase
      if (drawing) {
        const brushIcon = mode === "braille" ? "::" : "##";
        if (erasing) {
          statusBar.content = `R${round}  [${timeLeft}s]   YOU DRAW   ${hint}   eraser  w${size}`;
        } else {
          statusBar.content = t`R${String(round)}  [${String(timeLeft)}s]   YOU DRAW   ${hint}   ${brushIcon} ${fg(color)("#")}  w${String(size)}`;
        }
      } else {
        statusBar.content = `R${round}  [${timeLeft}s]   guessing...   ${hint}`;
      }
    },
    setRoom(code, name) {
      leftPane.title = ` ${code}${name ? "  -  " + name : ""} `;
      renderer.requestRender();
    },
  };
}
