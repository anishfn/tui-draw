import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import {
  DEFAULT_PORT,
  PacketType,
  decodePacket,
  encodePacket,
  type DrawMode,
  type Packet,
} from "../types/index.ts";
import { ClientState } from "./state.ts";
import { createDashboard } from "./ui/dashboard.ts";
import { createRoomLobby } from "./ui/roomLobby.ts";

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const PALETTE = [
  "#e0def4", "#eb6f92", "#f6c177", "#9ccfd8",
  "#31748f", "#c4a7e7", "#ebbcba", "#3e8fb0",
] as const;

const FOOTER =
  "⇆ Tab chat · ✎ b brush · 🧹 e eraser · ↔ [ ] size · 🎨 1-8 color · 🗑 c clear · Esc leave room · ⏻ Ctrl+C quit";

export interface ClientConfig {
  name?: string;
  serverUrl?: string;
  /** If set, automatically join this room after connecting. */
  autoJoin?: { roomId: string; password?: string };
  /** If set, automatically create a room after connecting. */
  autoCreate?: { name: string; password?: string; isPrivate?: boolean };
}

/* -------------------------------------------------------------------------- */
/* Main client function                                                       */
/* -------------------------------------------------------------------------- */

export async function startClient(config: ClientConfig = {}): Promise<void> {
  const MY_NAME =
    (config.name ?? process.env.NAME ?? "").trim().slice(0, 16) ||
    `Artist-${Math.floor(1000 + Math.random() * 9000)}`;

  const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
  const SERVER_URL = config.serverUrl ?? process.env.SERVER ?? `ws://localhost:${PORT}`;

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    enableMouseMovement: true,
    targetFps: 60,
  });

  const state = new ClientState();
  state.myName = MY_NAME;

  let ws: WebSocket | null = null;
  let inputFocused = true;
  let autoActionFired = false;

  const send = (packet: Packet): void => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodePacket(packet));
    } catch { /* socket closing — drop */ }
  };

  /* --- UI ---------------------------------------------------------------- */
  const lobby = createRoomLobby(renderer, {
    onCreateRoom: (name, password) => {
      lobby.clearError();
      send({ t: PacketType.CREATE_ROOM, name, password });
    },
    onJoinRoom: (roomId, password) => {
      lobby.clearError();
      send({ t: PacketType.JOIN_ROOM, roomId, password });
    },
  });

  const dash = createDashboard(renderer, {
    canvas: {
      onDraw: (point) => send({ t: PacketType.DRAW_POINT, point }),
      getColor: () => state.drawColor as `#${string}`,
      getMode: () => state.drawMode,
      getSize: () => state.brushSize,
      getErase: () => state.erasing,
    },
    sidebar: {
      onSubmit: (text) =>
        send({ t: PacketType.CHAT_MESSAGE, msg: { sender: state.myName, content: text } }),
    },
  });
  dash.setFooter(FOOTER);

  renderer.root.add(lobby.root);
  renderer.root.add(dash.root);
  dash.root.visible = false;

  /* --- Phase switching --------------------------------------------------- */
  const switchToLobby = (): void => {
    state.inRoom = false;
    state.amDrawing = false;
    dash.root.visible = false;
    lobby.root.visible = true;
    lobby.focusFirst();
    lobby.setRooms(state.roomList);
    renderer.requestRender();
  };

  const switchToGame = (): void => {
    state.inRoom = true;
    lobby.root.visible = false;
    dash.root.visible = true;
    renderer.requestRender();
  };

  /* --- Reactive render --------------------------------------------------- */
  const renderState = (): void => {
    if (state.inRoom) {
      dash.sidebar.setPlayers(state.players, state.drawerId, state.myName);
      dash.sidebar.setFeed(state.feed);
      dash.setCanvasStatus({
        hint: state.amDrawing ? (state.word ?? "") : state.hint,
        timeLeft: state.timeLeft,
        round: state.round,
        drawing: state.amDrawing,
        mode: state.drawMode,
        color: state.drawColor,
        size: state.brushSize,
        erasing: state.erasing,
      });
      dash.canvas.setInteractive(state.amDrawing);
    } else {
      lobby.setRooms(state.roomList);
    }
    renderer.requestRender();
  };
  state.subscribe(renderState);
  lobby.focusFirst();

  /* --- Inbound packets --------------------------------------------------- */
  let firstSync = true;
  let prevDrawerId: string | null = null;
  let prevRound = -1;
  let prevAmDrawing = false;

  const focusForRole = (drawing: boolean): void => {
    if (drawing) { inputFocused = false; dash.sidebar.input.blur(); }
    else { inputFocused = true; dash.sidebar.input.focus(); }
  };

  const onPacket = (packet: Packet): void => {
    switch (packet.t) {
      case PacketType.ROOM_LIST:
        state.roomList = packet.rooms;
        state.emitChange();
        // Fire auto-action on the first ROOM_LIST after JOIN.
        if (!autoActionFired) {
          autoActionFired = true;
          if (config.autoJoin) {
            send({ t: PacketType.JOIN_ROOM, ...config.autoJoin });
          } else if (config.autoCreate) {
            send({ t: PacketType.CREATE_ROOM, name: config.autoCreate.name, password: config.autoCreate.password, isPrivate: config.autoCreate.isPrivate });
          }
        }
        break;

      case PacketType.ROOM_JOINED:
        state.roomId = packet.roomId;
        state.roomName = packet.roomName;
        firstSync = true;
        prevDrawerId = null;
        prevRound = -1;
        prevAmDrawing = false;
        switchToGame();
        break;

      case PacketType.ROOM_ERROR:
        lobby.setError(packet.text);
        renderer.requestRender();
        break;

      case PacketType.STATE_SYNC: {
        const s = packet.state;
        state.phase = s.phase;
        state.players = s.players;
        state.drawerId = s.drawerId;
        state.hint = s.hint;
        state.word = s.word;
        state.timeLeft = s.timeLeft;
        state.round = s.round;
        state.amDrawing = s.word !== null;
        const turnChanged = s.drawerId !== prevDrawerId || s.round !== prevRound;
        if (firstSync || turnChanged) { dash.canvas.replay(s.history); firstSync = false; }
        if (state.amDrawing !== prevAmDrawing) focusForRole(state.amDrawing);
        prevAmDrawing = state.amDrawing;
        prevDrawerId = s.drawerId;
        prevRound = s.round;
        state.emitChange();
        break;
      }

      case PacketType.DRAW_POINT:   dash.canvas.apply(packet.point); break;
      case PacketType.CLEAR_BOARD:  dash.canvas.clear(); break;

      case PacketType.CHAT_MESSAGE:
        state.pushFeed({ kind: "chat", sender: packet.msg.sender, text: packet.msg.content });
        state.emitChange();
        break;

      case PacketType.SYSTEM_ALERT:
        state.pushAlert(packet.alert);
        state.emitChange();
        break;

      case PacketType.JOIN:
      case PacketType.LIST_ROOMS:
      case PacketType.CREATE_ROOM:
      case PacketType.JOIN_ROOM:
      case PacketType.LEAVE_ROOM:
        break;
    }
  };

  /* --- WebSocket --------------------------------------------------------- */
  const connect = (): void => {
    ws = new WebSocket(SERVER_URL);
    ws.addEventListener("open", () => {
      send({ t: PacketType.JOIN, name: MY_NAME });
      state.pushFeed({ kind: "system", text: `Connected to ${SERVER_URL} as ${MY_NAME}.`, color: "#9ccfd8" });
      state.emitChange();
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const packet = decodePacket(ev.data as string);
        if (packet) onPacket(packet);
      } catch { /* swallow malformed traffic */ }
    });
    ws.addEventListener("close", () => {
      state.pushFeed({ kind: "system", text: "Disconnected from server.", color: "#eb6f92" });
      state.amDrawing = false;
      state.inRoom = false;
      state.roomId = null;
      autoActionFired = false;
      state.emitChange();
      switchToLobby();
    });
    ws.addEventListener("error", () => {
      state.pushFeed({
        kind: "system",
        text: `Could not reach ${SERVER_URL}. Is the server running?`,
        color: "#eb6f92",
      });
      state.emitChange();
    });
  };

  /* --- Keyboard ---------------------------------------------------------- */
  renderer.keyInput.on("keypress", (key) => {
    if (!state.inRoom) {
      lobby.handleKeypress(key);
      return;
    }

    if (key.name === "tab") {
      inputFocused = !inputFocused;
      if (inputFocused) dash.sidebar.input.focus();
      else dash.sidebar.input.blur();
      renderer.requestRender();
      return;
    }

    if (key.name === "escape") {
      send({ t: PacketType.LEAVE_ROOM });
      state.feed = [];
      state.players = [];
      state.roomId = null;
      dash.canvas.clear();
      switchToLobby();
      return;
    }

    if (inputFocused) return;

    switch (key.name) {
      case "b": state.drawMode = state.drawMode === "braille" ? "block" : "braille"; state.emitChange(); break;
      case "e": state.erasing = !state.erasing; state.emitChange(); break;
      case "[": state.brushSize = Math.max(1, state.brushSize - 1); state.emitChange(); break;
      case "]": state.brushSize = Math.min(8, state.brushSize + 1); state.emitChange(); break;
      case "c":
        if (state.amDrawing) { send({ t: PacketType.CLEAR_BOARD }); dash.canvas.clear(); }
        break;
      default: {
        const n = Number(key.name);
        if (Number.isInteger(n) && n >= 1 && n <= PALETTE.length) {
          state.drawColor = PALETTE[n - 1]!;
          state.erasing = false;
          state.emitChange();
        }
      }
    }
  });

  /* --- Shutdown ---------------------------------------------------------- */
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { ws?.close(); } catch { /* ignore */ }
    renderer.destroy();
  };
  renderer.on(CliRenderEvents.DESTROY, () => { try { ws?.close(); } catch { /* ignore */ } });
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  renderState();
  connect();
}

/* -------------------------------------------------------------------------- */
/* Run directly                                                               */
/* -------------------------------------------------------------------------- */

if (import.meta.main) {
  startClient({
    name: process.argv[2],
    serverUrl: process.env.SERVER,
  }).catch((err) => console.error("Fatal: failed to start tui-draw client:", err));
}
