import type { ServerWebSocket } from "bun";
import {
  DEFAULT_PORT,
  PacketType,
  decodePacket,
  encodePacket,
  type Packet,
} from "../types/index.ts";
import { RoomRegistry } from "./registry.ts";
import type { Session } from "./types.ts";

const registry = new RoomRegistry();

/** All connected sockets, keyed by player id. */
const allClients = new Map<string, ServerWebSocket<Session>>();

let nextId = 1;
const genId = (): string => `p${nextId++}`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function send(ws: ServerWebSocket<Session>, packet: Packet): void {
  try {
    ws.send(encodePacket(packet));
  } catch {
    /* ignore dead socket */
  }
}

/** Push the current room list to every client in the lobby (not in a room). */
function pushRoomList(): void {
  const rooms = registry.list();
  const frame = encodePacket({ t: PacketType.ROOM_LIST, rooms });
  for (const ws of allClients.values()) {
    if (ws.data.joined && ws.data.roomId === null) {
      try {
        ws.send(frame);
      } catch {
        /* ignore */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Packet handling                                                            */
/* -------------------------------------------------------------------------- */

function handlePacket(ws: ServerWebSocket<Session>, packet: Packet): void {
  switch (packet.t) {
    /* ------------------------------------------------------------------ */
    /* Pre-room lifecycle                                                  */
    /* ------------------------------------------------------------------ */

    case PacketType.JOIN: {
      if (ws.data.joined) break; // ignore duplicate JOINs
      const name = packet.name.trim().slice(0, 16) || `Player-${ws.data.id}`;
      ws.data.name = name;
      ws.data.joined = true;
      send(ws, { t: PacketType.ROOM_LIST, rooms: registry.list() });
      break;
    }

    case PacketType.LIST_ROOMS: {
      send(ws, { t: PacketType.ROOM_LIST, rooms: registry.list() });
      break;
    }

    case PacketType.CREATE_ROOM: {
      if (!ws.data.joined) break;
      if (ws.data.roomId !== null) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Leave your current room first." });
        break;
      }
      const name = packet.name.trim().slice(0, 32);
      if (!name) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Room name cannot be empty." });
        break;
      }
      const room = registry.create(name, packet.password, packet.isPrivate ?? false);
      room.addClient(ws);
      send(ws, { t: PacketType.ROOM_JOINED, roomId: room.id, roomName: room.name, password: room.getPassword() ?? undefined });
      send(ws, { t: PacketType.STATE_SYNC, state: room.snapshotFor(ws.data.id) });
      pushRoomList();
      break;
    }

    case PacketType.JOIN_ROOM: {
      if (!ws.data.joined) break;
      if (ws.data.roomId !== null) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Leave your current room first." });
        break;
      }
      const room = registry.get(packet.roomId);
      if (!room) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Room not found. Check the code and try again." });
        break;
      }
      if (!room.checkPassword(packet.password)) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Incorrect password." });
        break;
      }
      if (room.isFull()) {
        send(ws, { t: PacketType.ROOM_ERROR, text: "Room is full (max 8 players)." });
        break;
      }
      registry.cancelCleanup(room.id);
      room.addClient(ws);
      send(ws, { t: PacketType.ROOM_JOINED, roomId: room.id, roomName: room.name, password: room.getPassword() ?? undefined });
      send(ws, { t: PacketType.STATE_SYNC, state: room.snapshotFor(ws.data.id) });
      pushRoomList();
      break;
    }

    case PacketType.LEAVE_ROOM: {
      if (ws.data.roomId === null) break;
      const room = registry.get(ws.data.roomId);
      if (room) {
        room.broadcast({
          t: PacketType.SYSTEM_ALERT,
          alert: { kind: "info", text: `${ws.data.avatar} ${ws.data.name} left the room.` },
        });
        const isEmpty = room.removeClient(ws.data.id);
        if (isEmpty) registry.scheduleCleanup(room.id);
      } else {
        ws.data.roomId = null;
      }
      send(ws, { t: PacketType.ROOM_LIST, rooms: registry.list() });
      pushRoomList();
      break;
    }

    /* ------------------------------------------------------------------ */
    /* In-game (must be in a room)                                         */
    /* ------------------------------------------------------------------ */

    case PacketType.START_GAME: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room) break;
      room.startGame(ws.data.id);
      pushRoomList();
      break;
    }

    case PacketType.SET_ROUNDS: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room) break;
      room.setRounds(ws.data.id, packet.rounds);
      break;
    }

    case PacketType.CHOOSE_WORD: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room) break;
      room.chooseWord(ws.data.id, packet.index);
      break;
    }

    case PacketType.DRAW_POINT: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room || !room.isDrawer(ws.data.id)) break;
      room.recordPoint(packet.point);
      room.relayExcept(ws.data.id, encodePacket(packet));
      break;
    }

    case PacketType.CHAT_MESSAGE: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room) break;
      const verdict = room.evaluateGuess(ws.data.id, packet.msg.content);
      if (verdict === "correct") break; // suppressed; game loop sent alert
      if (verdict === "close") {
        // Privately nudge the guesser; don't broadcast a near-miss (it leaks).
        send(ws, {
          t: PacketType.SYSTEM_ALERT,
          alert: { kind: "hint", text: `"${packet.msg.content}" is close!` },
        });
        break;
      }
      room.broadcast({
        t: PacketType.CHAT_MESSAGE,
        msg: { sender: ws.data.name, content: packet.msg.content.slice(0, 200) },
      });
      break;
    }

    case PacketType.CLEAR_BOARD: {
      const room = ws.data.roomId ? registry.get(ws.data.roomId) : undefined;
      if (!room || !room.isDrawer(ws.data.id)) break;
      room.clearHistory();
      room.broadcast({ t: PacketType.CLEAR_BOARD });
      break;
    }

    // These are server→client only; silently ignore if received.
    case PacketType.ROOM_LIST:
    case PacketType.ROOM_JOINED:
    case PacketType.ROOM_ERROR:
    case PacketType.SYSTEM_ALERT:
    case PacketType.STATE_SYNC:
    case PacketType.WORD_CHOICES:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Bun.serve                                                                  */
/* -------------------------------------------------------------------------- */

export async function startServer(port: number = DEFAULT_PORT): Promise<void> {
  const server = Bun.serve<Session, never>({
    port,
    fetch(req, srv) {
      const ok = srv.upgrade(req, {
        data: { id: genId(), name: "", avatar: "", joined: false, roomId: null },
      });
      if (ok) return undefined;
      return new Response("drawtui server. Connect a WebSocket client to play.", {
        status: 426,
        headers: { "Content-Type": "text/plain" },
      });
    },
    websocket: {
      open(ws) {
        allClients.set(ws.data.id, ws);
      },
      message(ws, raw) {
        try {
          const packet = decodePacket(raw);
          if (!packet) return;
          handlePacket(ws, packet);
        } catch (err) {
          console.error("[server] dropped malformed packet:", err);
        }
      },
      close(ws) {
        allClients.delete(ws.data.id);
        if (ws.data.roomId !== null) {
          const room = registry.get(ws.data.roomId);
          if (room) {
            room.broadcast({
              t: PacketType.SYSTEM_ALERT,
              alert: { kind: "info", text: `${ws.data.avatar} ${ws.data.name} left.` },
            });
            const isEmpty = room.removeClient(ws.data.id);
            if (isEmpty) registry.scheduleCleanup(room.id);
            pushRoomList();
          }
        }
      },
    },
  });

  console.log(`drawtui server listening on ws://localhost:${server.port}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      registry.stopAll();
      server.stop(true);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  startServer(port).catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
