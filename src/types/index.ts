/**
 * src/types/index.ts
 * --------------------------------------------------------------------------
 * Shared JSON socket-event schemas & payload protocols.
 *
 * This module is the single source of truth for every byte that crosses the
 * WebSocket boundary. Both the authoritative Bun server and the OpenTUI client
 * import these definitions, so the wire format is checked at compile time on
 * both ends. There are no runtime-only fields and no `any` on the hot path.
 * --------------------------------------------------------------------------
 */

/** A color is always a `#rrggbb` hex string on the wire (cheap, deterministic). */
export type Color = `#${string}`;

/** Two rendering strategies for the canvas grid (see Phase 4). */
export type DrawMode = "braille" | "block";

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A single paint sample. Coordinates are expressed in **canvas cell space**
 * (integer column/row of the drawing grid), keeping packets tiny. Each client
 * is responsible for interpolating between consecutive samples of a stroke and
 * for up-scaling into braille sub-dot space locally.
 */
export interface DrawPointPayload {
  /** Cell column (terminal mouse resolution). */
  x: number;
  /** Cell row (terminal mouse resolution). */
  y: number;
  /** Stroke color. */
  color: Color;
  /** Rendering strategy chosen by the drawer at sample time. */
  mode: DrawMode;
  /** Brush radius (in braille dots for braille mode, in cells for block mode). */
  size: number;
  /** When `true`, this stamp removes ink instead of adding it (eraser). */
  erase: boolean;
  /**
   * `true` when this sample continues an in-progress drag (interpolate a line
   * from the previous sample). `false` marks the start of a fresh stroke
   * (mouse-down), which resets the interpolation anchor.
   */
  drag: boolean;
}

/** A chat line / guess submitted by a player. */
export interface ChatMessagePayload {
  sender: string;
  content: string;
}

/** Categories of out-of-band system notices the server pushes to the lobby. */
export type SystemAlertKind =
  | "info" // generic lobby notice
  | "hint" // masked word, e.g. "_ A _ _ E R"
  | "tick" // countdown tick
  | "role" // "You are drawing" / "<name> is drawing"
  | "correct" // a player guessed the word
  | "round"; // round / turn transition

/** Non-chat, server-authored notice (word hints, ticks, role changes…). */
export interface SystemAlertPayload {
  kind: SystemAlertKind;
  text: string;
}

/** A connected participant as seen by every client. */
export interface Player {
  id: string;
  name: string;
  score: number;
  /** Whether this player currently holds the pen. */
  isDrawing: boolean;
  /** Whether this player has already guessed the word this turn. */
  hasGuessed: boolean;
  /** Single emoji avatar assigned on join. */
  avatar: string;
  /** Accent color (hex) for this player's name in the roster/feed. */
  color: Color;
}

/** Phase of the authoritative game loop. */
export type GamePhase = "lobby" | "drawing" | "intermission";

/** Summary of a room sent to clients in the lobby. */
export interface RoomInfo {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  phase: GamePhase;
  /** True when the room has a password — the actual password is never sent. */
  hasPassword: boolean;
  /** Private rooms are hidden from the public list; joinable only by code. */
  isPrivate: boolean;
}

/**
 * A full snapshot of authoritative state. Sent on join and whenever a
 * structural change occurs (player list, scores, turn, timer). The canvas
 * history is replayed so late joiners see the in-progress drawing.
 */
export interface GameSnapshot {
  phase: GamePhase;
  players: Player[];
  /** Player id currently drawing, or null in lobby/intermission. */
  drawerId: string | null;
  /** Masked word hint for guessers, e.g. "_ A _ _ E R". */
  hint: string;
  /** Whole word — only ever populated for the drawer's own snapshot. */
  word: string | null;
  /** Seconds remaining in the current turn. */
  timeLeft: number;
  /** Current round number (1-based). */
  round: number;
  /** Replay buffer so the board can be reconstructed mid-turn. */
  history: DrawPointPayload[];
}

/* -------------------------------------------------------------------------- */
/* Packet envelope (discriminated union)                                      */
/* -------------------------------------------------------------------------- */

export const PacketType = {
  // Pre-room lifecycle
  JOIN: "JOIN",
  LIST_ROOMS: "LIST_ROOMS",
  ROOM_LIST: "ROOM_LIST",
  CREATE_ROOM: "CREATE_ROOM",
  JOIN_ROOM: "JOIN_ROOM",
  ROOM_JOINED: "ROOM_JOINED",
  ROOM_ERROR: "ROOM_ERROR",
  LEAVE_ROOM: "LEAVE_ROOM",
  // In-game
  DRAW_POINT: "DRAW_POINT",
  CHAT_MESSAGE: "CHAT_MESSAGE",
  SYSTEM_ALERT: "SYSTEM_ALERT",
  CLEAR_BOARD: "CLEAR_BOARD",
  STATE_SYNC: "STATE_SYNC",
} as const;

export type PacketType = (typeof PacketType)[keyof typeof PacketType];

/**
 * Every frame on the socket is one of these. The `t` discriminant lets both
 * ends `switch` exhaustively — add a member here and the compiler will flag
 * every handler that forgot to deal with it.
 */
export type Packet =
  // Pre-room lifecycle
  | { t: typeof PacketType.JOIN; name: string }
  | { t: typeof PacketType.LIST_ROOMS }
  | { t: typeof PacketType.ROOM_LIST; rooms: RoomInfo[] }
  | { t: typeof PacketType.CREATE_ROOM; name: string; password?: string; isPrivate?: boolean }
  | { t: typeof PacketType.JOIN_ROOM; roomId: string; password?: string }
  | { t: typeof PacketType.ROOM_JOINED; roomId: string; roomName: string }
  | { t: typeof PacketType.ROOM_ERROR; text: string }
  | { t: typeof PacketType.LEAVE_ROOM }
  // In-game
  | { t: typeof PacketType.DRAW_POINT; point: DrawPointPayload }
  | { t: typeof PacketType.CHAT_MESSAGE; msg: ChatMessagePayload }
  | { t: typeof PacketType.SYSTEM_ALERT; alert: SystemAlertPayload }
  | { t: typeof PacketType.CLEAR_BOARD }
  | { t: typeof PacketType.STATE_SYNC; state: GameSnapshot };

/* -------------------------------------------------------------------------- */
/* Safe (de)serialization                                                     */
/* -------------------------------------------------------------------------- */

/** Serialize a packet for transport. Pure, never throws on valid input. */
export function encodePacket(packet: Packet): string {
  return JSON.stringify(packet);
}

/**
 * Defensively decode an inbound frame. Returns `null` for anything that is not
 * a well-formed, known packet so callers can drop corrupt traffic without
 * crashing the process (Phase 5: error isolation).
 */
export function decodePacket(raw: string | Buffer | ArrayBuffer): Packet | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(raw)
          : raw.toString("utf8");

    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;

    const t = (value as { t?: unknown }).t;
    switch (t) {
      case PacketType.JOIN:
      case PacketType.LIST_ROOMS:
      case PacketType.ROOM_LIST:
      case PacketType.CREATE_ROOM:
      case PacketType.JOIN_ROOM:
      case PacketType.ROOM_JOINED:
      case PacketType.ROOM_ERROR:
      case PacketType.LEAVE_ROOM:
      case PacketType.DRAW_POINT:
      case PacketType.CHAT_MESSAGE:
      case PacketType.SYSTEM_ALERT:
      case PacketType.CLEAR_BOARD:
      case PacketType.STATE_SYNC:
        return value as Packet;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** The default room/port the server and client agree on out of the box. */
export const DEFAULT_PORT = 3017;
