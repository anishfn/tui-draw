import type { RoomInfo } from "../types/index.ts";
import { Room } from "./room.ts";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
const CODE_LENGTH = 6;
const CLEANUP_DELAY_MS = 60_000;

function genCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!existing.has(code)) return code;
  }
  throw new Error("Failed to generate a unique room code");
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  create(name: string, password?: string, isPrivate = false, rounds = 3): Room {
    const id = genCode(new Set(this.rooms.keys()));
    const room = new Room(id, name, password, isPrivate, rounds);
    this.rooms.set(id, room);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  remove(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.cancelCleanup(roomId);
    room.stop();
    this.rooms.delete(roomId);
  }

  /**
   * Schedule the room for deletion after CLEANUP_DELAY_MS of being empty.
   * Calling this again while a timer is running resets the timer.
   */
  scheduleCleanup(roomId: string): void {
    this.cancelCleanup(roomId);
    const timer = setTimeout(() => {
      const room = this.rooms.get(roomId);
      if (room && room.isEmpty()) this.remove(roomId);
    }, CLEANUP_DELAY_MS);
    this.cleanupTimers.set(roomId, timer);
  }

  cancelCleanup(roomId: string): void {
    const t = this.cleanupTimers.get(roomId);
    if (t !== undefined) {
      clearTimeout(t);
      this.cleanupTimers.delete(roomId);
    }
  }

  /** Returns only public rooms. Private rooms are omitted from the lobby list. */
  list(): RoomInfo[] {
    return [...this.rooms.values()].filter((r) => !r.isPrivate).map((r) => r.info());
  }

  stopAll(): void {
    for (const roomId of this.rooms.keys()) this.remove(roomId);
  }
}
