/**
 * src/client/ui/dashboard.ts
 * --------------------------------------------------------------------------
 * Master layout shell.
 *
 * Splits the terminal workspace into two flex regions:
 *   +----------------------------+-------------------+
 *   |  Left: drawing canvas      |  Right: sidebar   |
 *   |  (status, timer, canvas,   |  (players, chat,  |
 *   |   tool HUD + overlays)     |   guess, keys)    |
 *   +----------------------------+-------------------+
 *
 * The left pane stacks a status header and a countdown bar above the
 * {@link CanvasHandle}, a tool HUD below it, and floats three absolute
 * overlays (intermission scoreboard, celebration toast, help) on top.
 * --------------------------------------------------------------------------
 */

import {
  BoxRenderable,
  RGBA,
  StyledText,
  TextRenderable,
  bg,
  fg,
  t,
  stringToStyledText,
  type TextChunk,
  type CliRenderer,
} from "@opentui/core";
import type { GamePhase, Player } from "../../types/index.ts";
import { createCanvas, type CanvasHandle, type CanvasOptions } from "./canvas.ts";
import { createSidebar, type SidebarHandle, type SidebarOptions } from "./sidebar.ts";
import { C, PALETTE, PALETTE_NAMES, barColor } from "./theme.ts";

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
  /** Total rounds configured for the game (shown in lobby + status). */
  totalRounds: number;
  /** The three words offered to us while choosing. */
  wordChoices: string[];
  mode: string;
  color: string;
  size: number;
  erasing: boolean;
  /** Active drawing tool: brush | line | rect | circle | fill. */
  tool: string;
}

export interface DashboardHandle {
  readonly root: BoxRenderable;
  readonly canvas: CanvasHandle;
  readonly sidebar: SidebarHandle;
  setCanvasStatus(status: CanvasStatus): void;
  /** Show the room code + name (+ password for private rooms) atop the canvas. */
  setRoom(code: string, name: string, password: string): void;
  /** Show / hide the intermission scoreboard overlay. */
  showScoreboard(players: Player[], myName: string, reveal: string | null): void;
  hideScoreboard(): void;
  /** Show / hide the centered word-picker dialog (drawer only). */
  showWordChoice(choices: string[], timeLeft: number): void;
  hideWordChoice(): void;
  /** Flash a transient banner over the canvas (e.g. a correct guess). */
  showToast(text: string, color?: string): void;
  hideToast(): void;
  /** Toggle the controls/help overlay. Returns the new visibility. */
  toggleHelp(): boolean;
  isHelpOpen(): boolean;
  /** Highlight whichever region is active (`"canvas"` or `"chat"`). */
  setActivePane(pane: "canvas" | "chat"): void;
}

const BAR_WIDTH = 18;

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
    // No background: stay transparent so the user's terminal/wallpaper shows.
  });

  /* --- Left: canvas pane ----------------------------------------------- */
  const leftPane = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    title: " Canvas ",
    titleAlignment: "center",
  });

  const statusBar = new TextRenderable(renderer, {
    content: "Connecting...",
    flexShrink: 0,
    paddingLeft: 1,
  });

  const timerBar = new TextRenderable(renderer, {
    content: "",
    flexShrink: 0,
    paddingLeft: 1,
  });

  const canvas = createCanvas(renderer, wiring.canvas);

  const toolBar = new TextRenderable(renderer, {
    content: "",
    flexShrink: 0,
    paddingLeft: 1,
  });

  leftPane.add(statusBar);
  leftPane.add(timerBar);
  leftPane.add(canvas.renderable);
  leftPane.add(toolBar);

  /* --- Overlays (absolute, float over the canvas) ---------------------- */
  function makeOverlay(zIndex: number, accent: string): { layer: BoxRenderable; box: BoxRenderable } {
    const layer = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      zIndex,
      visible: false,
    });
    const box = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: accent,
      titleColor: RGBA.fromHex(accent),
      backgroundColor: C.surface,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 3,
      paddingRight: 3,
      flexDirection: "column",
      titleAlignment: "center",
    });
    layer.add(box);
    leftPane.add(layer);
    return { layer, box };
  }

  const score = makeOverlay(10, C.warn);
  score.box.title = " * Scoreboard * ";
  const scoreText = new TextRenderable(renderer, { content: "" });
  score.box.add(scoreText);

  const wordPick = makeOverlay(15, C.accent);
  wordPick.box.title = " Your turn to draw ";
  const wordText = new TextRenderable(renderer, { content: "" });
  wordPick.box.add(wordText);

  const toast = makeOverlay(20, C.good);
  toast.layer.justifyContent = "flex-start";
  const toastText = new TextRenderable(renderer, { content: "" });
  toast.box.add(toastText);

  const help = makeOverlay(30, C.accent);
  help.box.title = " Controls ";
  const helpText = new TextRenderable(renderer, { content: buildHelp() });
  help.box.add(helpText);

  /* --- Right: sidebar -------------------------------------------------- */
  const sidebar = createSidebar(renderer, wiring.sidebar);

  root.add(leftPane);
  root.add(sidebar.container);

  /* --- Canvas sizing ---------------------------------------------------- */
  const fitCanvas = (): void => {
    // Responsive sidebar: shrink it on narrow terminals so the canvas survives.
    const total = root.width;
    const sbW = total < 60 ? 24 : total < 90 ? 30 : 35;
    if (sidebar.container.width !== sbW) sidebar.container.width = sbW;

    const w = leftPane.width - 2; // minus left/right border
    const h =
      leftPane.height - 2 - statusBar.height - timerBar.height - toolBar.height;
    if (w > 0 && h > 0) canvas.resize(w, h);
  };
  renderer.setFrameCallback(async () => fitCanvas());

  /* --- Timer-bar scale tracking ---------------------------------------- */
  let phaseKey = "";
  let maxTime = 1;

  function renderTimer(phase: GamePhase, timeLeft: number, round: number): void {
    if (phase === "lobby") {
      timerBar.content = "";
      return;
    }
    const key = `${phase}:${round}`;
    if (key !== phaseKey || timeLeft > maxTime) {
      phaseKey = key;
      maxTime = Math.max(1, timeLeft);
    }
    const frac = Math.max(0, Math.min(1, timeLeft / maxTime));
    const filled = Math.round(frac * BAR_WIDTH);
    const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);
    timerBar.content = t`${fg(barColor(frac))("[" + bar + "]")} ${fg(C.muted)(timeLeft + "s")}`;
  }

  /* --- Tool HUD (drawer only) ------------------------------------------ */
  function renderToolBar(s: CanvasStatus): void {
    if (!s.drawing) {
      toolBar.content = "";
      return;
    }
    const chunks: TextChunk[] = [];
    const push = (st: StyledText | string) =>
      chunks.push(...(typeof st === "string" ? stringToStyledText(st) : st).chunks);

    push(t`${fg(C.muted)("ink ")}`);
    for (let i = 0; i < PALETTE.length; i++) {
      const active = !s.erasing && PALETTE[i] === s.color;
      push(t`${bg(PALETTE[i]!)(active ? `[${i + 1}]` : ` ${i + 1} `)}`);
    }
    const toolName = s.erasing ? "eraser" : s.tool;
    const colorName = s.erasing
      ? "-"
      : PALETTE_NAMES[PALETTE.indexOf(s.color as `#${string}`)] ?? "?";
    push(t`  ${fg(C.accent)(toolName)} ${fg(C.muted)(`(${colorName})`)}  size ${fg(C.text)(String(s.size))}  ${fg(C.muted)(s.mode)}`);
    toolBar.content = new StyledText(chunks);
  }

  return {
    root,
    canvas,
    sidebar,
    setCanvasStatus(s) {
      const { phase, hint, timeLeft, round, drawing, choosing } = s;
      renderTimer(phase, timeLeft, round);
      renderToolBar(s);

      if (phase === "lobby") {
        const rounds = `rounds ${s.totalRounds}`;
        statusBar.content = s.amHost
          ? s.enoughPlayers
            ? t`${fg(C.good)("* Lobby")}   ${fg(C.text)(rounds)} ${fg(C.muted)("(< > change)")}   press ${fg(C.warn)("[S]")} to start`
            : t`${fg(C.warn)("* Lobby")}   ${fg(C.text)(rounds)} ${fg(C.muted)("(< > change)")}   need 2+ players...`
          : t`${fg(C.info)("* Lobby")}   ${fg(C.text)(rounds)}   waiting for the host to start...`;
        return;
      }

      if (phase === "selecting") {
        statusBar.content = choosing
          ? t`${fg(C.warn)("Pick a word")} to start drawing...`
          : t`${fg(C.info)(s.drawerName || "Someone")} is choosing a word...`;
        return;
      }

      if (phase === "intermission") {
        statusBar.content = t`${fg(C.bad)("* Round over")}   next turn soon...`;
        return;
      }

      // drawing phase
      const roundTag = `Round ${round}/${s.totalRounds}`;
      if (drawing) {
        statusBar.content = t`${fg(C.good)(roundTag)}  ${fg(C.accent)("YOU DRAW")}   ${hint}`;
      } else {
        statusBar.content = t`${fg(C.good)(roundTag)}  guessing...   ${fg(C.warn)(hint)}`;
      }
    },

    setRoom(code, name, password) {
      const pw = password ? `   pw: ${password}` : "";
      leftPane.title = ` ${code}${name ? "  -  " + name : ""}${pw} `;
      renderer.requestRender();
    },

    showScoreboard(players, myName, reveal) {
      const ranked = [...players].sort((a, b) => b.score - a.score);
      const lines: StyledText[] = [];
      if (reveal) lines.push(t`The word was ${fg(C.warn)(reveal)}`);
      lines.push(stringToStyledText(""));
      ranked.forEach((p, i) => {
        const medal = i === 0 ? "#1" : i === 1 ? "#2" : i === 2 ? "#3" : `${i + 1}.`;
        const you = p.name === myName;
        const name = you ? `${p.name} (you)` : p.name;
        lines.push(t`${fg(i === 0 ? C.warn : C.muted)(medal)} ${fg(p.color)(p.avatar + " " + name)}  ${fg(C.text)(String(p.score))}`);
      });
      scoreText.content = joinLines(lines);
      score.layer.visible = true;
      renderer.requestRender();
    },
    hideScoreboard() {
      score.layer.visible = false;
      renderer.requestRender();
    },

    showWordChoice(choices, timeLeft) {
      const lines: StyledText[] = [];
      lines.push(t`${fg(C.text)("Choose a word to draw:")}`);
      lines.push(stringToStyledText(""));
      (choices.length ? choices : ["..."]).forEach((w, i) => {
        lines.push(t`   ${fg(C.accent)(`[${i + 1}]`)}  ${fg(C.warn)(w)}`);
      });
      lines.push(stringToStyledText(""));
      const frac = timeLeft / 15;
      lines.push(t`   ${fg(C.muted)("press 1-3")}        ${fg(barColor(frac))(timeLeft + "s")}`);
      wordText.content = joinLines(lines);
      wordPick.layer.visible = true;
      renderer.requestRender();
    },
    hideWordChoice() {
      wordPick.layer.visible = false;
      renderer.requestRender();
    },

    showToast(text, color = C.good) {
      toast.box.borderColor = color;
      toastText.content = t`${fg(color)(text)}`;
      toast.layer.visible = true;
      renderer.requestRender();
    },
    hideToast() {
      toast.layer.visible = false;
      renderer.requestRender();
    },

    toggleHelp() {
      help.layer.visible = !help.layer.visible;
      renderer.requestRender();
      return help.layer.visible;
    },
    isHelpOpen() {
      return help.layer.visible;
    },

    setActivePane(pane) {
      leftPane.borderColor = pane === "canvas" ? C.borderActive : C.border;
      sidebar.setChatActive(pane === "chat");
      renderer.requestRender();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function joinLines(lines: StyledText[]): StyledText {
  const NL = stringToStyledText("\n").chunks;
  const chunks: TextChunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    chunks.push(...lines[i]!.chunks);
    if (i < lines.length - 1) chunks.push(...NL);
  }
  return new StyledText(chunks);
}

/** A styled "key — action" row; the key gets the accent color. */
function keyRow(pairs: [string, string][]): StyledText {
  const chunks: TextChunk[] = [];
  pairs.forEach(([key, label], i) => {
    if (i > 0) chunks.push(...stringToStyledText("   ").chunks);
    chunks.push(...t`${fg(C.accent)(key.padEnd(3))} ${fg(C.text)(label.padEnd(9))}`.chunks);
  });
  return new StyledText(chunks);
}

function buildHelp(): StyledText {
  const lines: StyledText[] = [
    t`${fg(C.warn)("Drawing")}`,
    keyRow([["b", "brush"], ["n", "line"], ["m", "rect"]]),
    keyRow([["v", "circle"], ["f", "fill"], ["e", "eraser"]]),
    keyRow([["z", "undo"], ["Z", "redo"], ["c", "clear"]]),
    keyRow([["[ ]", "size"], ["1-8", "color"], ["g", "braille"]]),
    stringToStyledText(""),
    t`${fg(C.warn)("Game")}`,
    keyRow([["S", "start"], ["1-3", "pick word"]]),
    keyRow([["Tab", "chat"], ["Ent", "send"]]),
    keyRow([["^Y", "copy code"], ["?", "help"]]),
    keyRow([["Esc", "leave"], ["^C", "quit"]]),
    stringToStyledText(""),
    t`${fg(C.muted)("press any key to close")}`,
  ];
  return joinLines(lines);
}
