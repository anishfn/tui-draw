/**
 * src/client/state.ts
 * --------------------------------------------------------------------------
 * Local memory cache reflecting *true* server state.
 *
 * This is a dumb, observable mirror. The WebSocket layer writes into it; the UI
 * layer reads from it and re-renders on change. It deliberately holds no game
 * rules — the server is authoritative — so the client can never disagree with
 * the lobby about scores or whose turn it is.
 * --------------------------------------------------------------------------
 */

import type {
  DrawMode,
  GamePhase,
  Player,
  RoomInfo,
  SystemAlertPayload,
} from "../types/index.ts";

/** A single rendered chat/system line in the feed. */
export interface FeedLine {
  kind: "chat" | "system";
  /** For chat lines, the sender's name. */
  sender?: string;
  text: string;
  /** Optional color hint for system lines (hex). */
  color?: string;
}

export class ClientState {
  /** This client's chosen display name. */
  myName = "";
  /** This client's server-assigned drawer flag (derived from snapshots). */
  amDrawing = false;

  phase: GamePhase = "lobby";
  players: Player[] = [];
  drawerId: string | null = null;
  hint = "";
  /** Populated only when we are the drawer. */
  word: string | null = null;
  timeLeft = 0;
  round = 0;

  /** Rolling chat + system feed (most recent last). */
  feed: FeedLine[] = [];

  /** Room lobby state. */
  inRoom = false;
  roomId: string | null = null;
  roomName = "";
  roomList: RoomInfo[] = [];

  /** Current local drawing tool selection (drawer-side only). */
  drawMode: DrawMode = "braille";
  /** Current local pen color (drawer-side only). Defaults to terminal foreground. */
  drawColor = "#ffffff";
  /** Brush radius (dots for braille, cells for block). */
  brushSize = 2;
  /** Eraser active? */
  erasing = false;

  /** Listeners notified whenever any slice changes. */
  private listeners = new Set<() => void>();

  /** Subscribe to change notifications; returns an unsubscribe fn. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fan out a change notification to all subscribers. */
  emitChange(): void {
    for (const fn of this.listeners) fn();
  }

  /** Append a feed line, trimming history so the buffer stays bounded. */
  pushFeed(line: FeedLine): void {
    this.feed.push(line);
    if (this.feed.length > 500) this.feed.splice(0, this.feed.length - 500);
  }

  /** Convenience: translate a server alert into a feed line with semantic color. */
  pushAlert(alert: SystemAlertPayload): void {
    const color =
      alert.kind === "correct" ? "#a6e3a1" :
      alert.kind === "role"    ? "#f9e2af" :
      alert.kind === "round"   ? "#f38ba8" :
      alert.kind === "tick"    ? "#89dceb" :
      undefined;
    this.pushFeed({ kind: "system", text: alert.text, color });
  }
}
