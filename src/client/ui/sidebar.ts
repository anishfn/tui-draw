/**
 * src/client/ui/sidebar.ts
 * --------------------------------------------------------------------------
 * Right-hand panel: active player list (top), live chat feed (middle), and the
 * interactive guess Input (base).
 *
 * The sidebar is a pure view: it exposes imperative `set*` methods the client
 * calls whenever the local {@link ClientState} mirror changes. It is entirely
 * theme-free — no background, border, or text colors are set, so it inherits
 * the user's terminal palette.
 * --------------------------------------------------------------------------
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  StyledText,
  TextRenderable,
  fg,
  stringToStyledText,
  t,
  type TextChunk,
  type CliRenderer,
} from "@opentui/core";
import type { FeedLine } from "../state.ts";
import type { Player } from "../../types/index.ts";
import { C } from "./theme.ts";

export type ConnState = "connecting" | "online" | "offline";

export interface SidebarHandle {
  readonly container: BoxRenderable;
  readonly input: InputRenderable;
  setPlayers(players: Player[], drawerId: string | null, myName: string): void;
  setFeed(feed: FeedLine[]): void;
  /** Highlight the chat/guess region when it holds focus. */
  setChatActive(active: boolean): void;
  /** Update the connection dot in the panel title. */
  setConnection(state: ConnState): void;
}

export interface SidebarOptions {
  onSubmit: (text: string) => void;
}

export function createSidebar(
  renderer: CliRenderer,
  opts: SidebarOptions,
): SidebarHandle {
  const container = new BoxRenderable(renderer, {
    width: 44,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: C.accent,
    title: " drawtui ",
    titleAlignment: "center",
    gap: 1,
    padding: 1,
  });

  /* --- Player list ----------------------------------------------------- */
  const playersBox = new BoxRenderable(renderer, {
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    title: " Players ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const playersText = new TextRenderable(renderer, { content: "" });
  playersBox.add(playersText);

  /* --- Chat feed ------------------------------------------------------- */
  const feedBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    overflow: "hidden",
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    title: " Chat ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const feedText = new TextRenderable(renderer, { content: "" });
  feedBox.add(feedText);

  /* --- Guess input ----------------------------------------------------- */
  const inputBox = new BoxRenderable(renderer, {
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    title: " Guess ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const input = new InputRenderable(renderer, {
    placeholder: "Type your guess...",
    maxLength: 120,
  });
  inputBox.add(input);

  /* --- Compact controls hint (below chat) ------------------------------ */
  const controlsText = new TextRenderable(renderer, {
    content: t`${fg(C.muted)("? keys   Tab chat   Esc leave")}`,
    flexShrink: 0,
    paddingLeft: 1,
  });

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    const text = value.trim();
    if (text.length > 0) opts.onSubmit(text);
    input.value = "";
    renderer.requestRender();
  });

  container.add(playersBox);
  container.add(feedBox);
  container.add(inputBox);
  container.add(controlsText);

  /* --------------------------------------------------------------------- */
  /* Helpers                                                               */
  /* --------------------------------------------------------------------- */

  const NL: TextChunk[] = stringToStyledText("\n").chunks;

  function buildLines(lines: (StyledText | string)[]): StyledText {
    const chunks: TextChunk[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const styled = typeof line === "string" ? stringToStyledText(line) : line;
      chunks.push(...styled.chunks);
      if (i < lines.length - 1) chunks.push(...NL);
    }
    return new StyledText(chunks);
  }

  /* --------------------------------------------------------------------- */
  /* Imperative view updates                                               */
  /* --------------------------------------------------------------------- */

  function setPlayers(players: Player[], drawerId: string | null, myName: string) {
    if (players.length === 0) {
      playersText.content = "Waiting for players...";
      return;
    }
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const top = Math.max(1, sorted[0]!.score);
    const lines = sorted.map((p, i) => {
      const rank = i === 0 ? "#1" : i === 1 ? "#2" : i === 2 ? "#3" : `${i + 1}.`;
      const pen = p.id === drawerId ? ">" : " ";
      const you = p.name === myName ? " (you)" : "";
      const check = p.hasGuessed ? " +" : "";
      const filled = Math.round((p.score / top) * 6);
      const bar = "#".repeat(filled) + "-".repeat(6 - filled);
      return t`${fg(i === 0 ? C.warn : C.muted)(rank)}${fg(C.accent)(pen)}${fg(p.color)(p.avatar + " " + p.name)}${you}${check}  ${fg(p.color)(bar)} ${fg(C.text)(String(p.score))}`;
    });
    playersText.content = buildLines(lines);
  }

  function setChatActive(active: boolean) {
    const c = active ? C.borderActive : C.border;
    feedBox.borderColor = c;
    inputBox.borderColor = c;
    renderer.requestRender();
  }

  function setConnection(state: ConnState) {
    const hex =
      state === "online" ? C.good : state === "connecting" ? C.warn : C.bad;
    container.title = ` drawtui [${state === "online" ? "+" : state === "connecting" ? "~" : "x"}] `;
    container.titleColor = RGBA.fromHex(hex);
    renderer.requestRender();
  }

  function setFeed(feed: FeedLine[]) {
    const interior = Math.max(1, feedBox.height - 2);
    const visible = feed.slice(-interior);
    if (visible.length === 0) {
      feedText.content = "";
      return;
    }
    const lines = visible.map((line) => {
      if (line.kind === "chat") return `${line.sender ?? "?"}: ${line.text}`;
      if (line.color) return t`* ${fg(line.color)(line.text)}`;
      return `* ${line.text}`;
    });
    feedText.content = buildLines(lines);
  }

  return { container, input, setPlayers, setFeed, setChatActive, setConnection };
}
