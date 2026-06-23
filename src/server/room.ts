import type { ServerWebSocket } from "bun";
import {
  PacketType,
  encodePacket,
  type DrawPointPayload,
  type Packet,
  type RoomInfo,
  type SystemAlertPayload,
} from "../types/index.ts";
import { GameLoop } from "./gameLoop.ts";
import type { Session } from "./types.ts";

export const MAX_PLAYERS = 8;

export class Room {
  readonly id: string;
  readonly name: string;
  readonly hasPassword: boolean;
  readonly isPrivate: boolean;
  private readonly password: string | null;
  readonly clients = new Map<string, ServerWebSocket<Session>>();
  private readonly game: GameLoop;

  constructor(id: string, name: string, password?: string, isPrivate = false) {
    this.id = id;
    this.name = name;
    this.password = password && password.length > 0 ? password : null;
    this.hasPassword = this.password !== null;
    this.isPrivate = isPrivate;

    this.game = new GameLoop({
      broadcastSnapshot: () => this.broadcastSnapshot(),
      broadcastAlert: (alert: SystemAlertPayload) =>
        this.broadcast({ t: PacketType.SYSTEM_ALERT, alert }),
      broadcastClear: () => this.broadcast({ t: PacketType.CLEAR_BOARD }),
    });
    this.game.start();
  }

  checkPassword(pw: string | undefined): boolean {
    if (!this.hasPassword) return true;
    return this.password === (pw ?? "");
  }

  isFull(): boolean {
    return this.clients.size >= MAX_PLAYERS;
  }

  isEmpty(): boolean {
    return this.clients.size === 0;
  }

  /** Register a client in this room and start tracking them in the game loop. */
  addClient(ws: ServerWebSocket<Session>): void {
    const player = this.game.addPlayer(ws.data.id, ws.data.name);
    ws.data.avatar = player.avatar;
    ws.data.roomId = this.id;
    this.clients.set(ws.data.id, ws);
  }

  /** Deregister a client. Returns true when the room is now empty. */
  removeClient(id: string): boolean {
    const ws = this.clients.get(id);
    if (ws) {
      ws.data.roomId = null;
      this.clients.delete(id);
    }
    this.game.removePlayer(id);
    return this.clients.size === 0;
  }

  isDrawer(id: string): boolean {
    return this.game.isDrawer(id);
  }

  recordPoint(point: DrawPointPayload): void {
    this.game.recordPoint(point);
  }

  clearHistory(): void {
    this.game.clearHistory();
  }

  evaluateGuess(playerId: string, content: string) {
    return this.game.evaluateGuess(playerId, content);
  }

  snapshotFor(forId: string) {
    return this.game.snapshotFor(forId);
  }

  /** Relay a raw encoded frame to every client except the sender. */
  relayExcept(senderId: string, frame: string): void {
    for (const [id, ws] of this.clients) {
      if (id === senderId) continue;
      try {
        ws.send(frame);
      } catch {
        /* ignore dead socket */
      }
    }
  }

  broadcast(packet: Packet): void {
    const frame = encodePacket(packet);
    for (const ws of this.clients.values()) {
      try {
        ws.send(frame);
      } catch {
        /* ignore dead socket */
      }
    }
  }

  /** Send each client a personalized STATE_SYNC (drawer gets the real word). */
  broadcastSnapshot(): void {
    for (const [id, ws] of this.clients) {
      try {
        ws.send(
          encodePacket({ t: PacketType.STATE_SYNC, state: this.game.snapshotFor(id) }),
        );
      } catch {
        /* ignore dead socket */
      }
    }
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.clients.size,
      maxPlayers: MAX_PLAYERS,
      phase: this.game.getPhase(),
      hasPassword: this.hasPassword,
      isPrivate: this.isPrivate,
    };
  }

  stop(): void {
    this.game.stop();
  }
}
