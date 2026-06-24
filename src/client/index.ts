import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import {
  DEFAULT_SERVER_URL,
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
  "▶ S start · 🔤 1-3 pick word · ⇆ Tab chat · ✎ b brush · 🧹 e eraser · ↔ [ ] size · 🎨 1-8 color · 🗑 c clear · 📋 Ctrl+Y copy code · Esc leave · ⏻ Ctrl+C quit";

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

  const SERVER_URL = config.serverUrl ?? process.env.SERVER ?? DEFAULT_SERVER_URL;

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

  const send = (packet: Packet): boolean => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encodePacket(packet));
        return true;
      }
    } catch { /* socket closing — drop */ }
    return false;
  };

  /* --- UI ---------------------------------------------------------------- */
  const NOT_CONNECTED = `Not connected to ${SERVER_URL} — is the server running and the address correct?`;

  const lobby = createRoomLobby(renderer, {
    onCreateRoom: (name, password, isPrivate) => {
      if (!send({ t: PacketType.CREATE_ROOM, name, password, isPrivate })) {
        lobby.setError(NOT_CONNECTED);
        return;
      }
      lobby.clearError();
    },
    onJoinRoom: (roomId, password) => {
      if (!send({ t: PacketType.JOIN_ROOM, roomId, password })) {
        lobby.setError(NOT_CONNECTED);
        return;
      }
      lobby.clearError();
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
      const drawer = state.players.find((p) => p.id === state.drawerId);
      dash.setCanvasStatus({
        phase: state.phase,
        hint: state.amDrawing ? (state.word ?? "") : state.hint,
        timeLeft: state.timeLeft,
        round: state.round,
        drawing: state.amDrawing,
        choosing: state.amChoosing,
        amHost: state.amHost,
        enoughPlayers: state.players.length >= 2,
        drawerName: drawer?.name ?? "",
        wordChoices: state.wordChoices,
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
  let prevWantInput = true;

  // The chat input should hold focus only when we can usefully type into it:
  // while guessing during a drawing turn, or during the intermission scoreboard.
  const applyFocus = (wantInput: boolean): void => {
    if (wantInput === prevWantInput) return;
    prevWantInput = wantInput;
    inputFocused = wantInput;
    if (wantInput) dash.sidebar.input.focus();
    else dash.sidebar.input.blur();
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
        prevWantInput = true;
        dash.setRoom(packet.roomId, packet.roomName);
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
        state.selfId = s.selfId;
        state.hostId = s.hostId;
        state.hint = s.hint;
        state.word = s.word;
        state.timeLeft = s.timeLeft;
        state.round = s.round;
        state.amHost = s.selfId !== "" && s.selfId === s.hostId;
        state.amDrawing = s.phase === "drawing" && s.selfId === s.drawerId;
        state.amChoosing = s.phase === "selecting" && s.selfId === s.drawerId;
        // Word choices only matter while we're actively choosing.
        if (!state.amChoosing) state.wordChoices = [];
        const turnChanged = s.drawerId !== prevDrawerId || s.round !== prevRound;
        if (firstSync || turnChanged) { dash.canvas.replay(s.history); firstSync = false; }
        const wantInput = (s.phase === "drawing" && !state.amDrawing) || s.phase === "intermission";
        applyFocus(wantInput);
        prevDrawerId = s.drawerId;
        prevRound = s.round;
        state.emitChange();
        break;
      }

      case PacketType.WORD_CHOICES:
        state.wordChoices = packet.words;
        state.emitChange();
        break;

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
      case PacketType.START_GAME:
      case PacketType.CHOOSE_WORD:
        break;
    }
  };

  /* --- WebSocket --------------------------------------------------------- */
  const connect = (): void => {
    ws = new WebSocket(SERVER_URL);
    ws.addEventListener("open", () => {
      send({ t: PacketType.JOIN, name: MY_NAME });
      state.pushFeed({ kind: "system", text: `Connected to ${SERVER_URL} as ${MY_NAME}.`, color: "#9ccfd8" });
      if (!state.inRoom) lobby.clearError();
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
      if (!state.inRoom) {
        lobby.setError(NOT_CONNECTED);
        renderer.requestRender();
      }
      state.emitChange();
    });
  };

  /* --- Keyboard ---------------------------------------------------------- */
  renderer.keyInput.on("keypress", (key) => {
    if (!state.inRoom) {
      lobby.handleKeypress(key);
      return;
    }

    // Copy the room code to the system clipboard (OSC 52) — works even though
    // the mouse is captured by the canvas, so players can't select text.
    if (key.ctrl && key.name === "y") {
      if (state.roomId) {
        const ok = renderer.copyToClipboardOSC52(state.roomId);
        state.pushFeed({
          kind: "system",
          text: ok
            ? `Room code ${state.roomId} copied to clipboard.`
            : `Room code is ${state.roomId} (clipboard not supported here).`,
          color: "#9ccfd8",
        });
        state.emitChange();
      }
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

    // Lobby phase: the host starts the game with [S].
    if (state.phase === "lobby") {
      if (key.name === "s" && state.amHost) send({ t: PacketType.START_GAME });
      return;
    }

    // Selecting phase: the drawer picks one of the three offered words.
    if (state.phase === "selecting") {
      if (state.amChoosing) {
        const n = Number(key.name);
        if (Number.isInteger(n) && n >= 1 && n <= state.wordChoices.length) {
          send({ t: PacketType.CHOOSE_WORD, index: n - 1 });
        }
      }
      return;
    }

    if (key.name === "tab") {
      inputFocused = !inputFocused;
      if (inputFocused) dash.sidebar.input.focus();
      else dash.sidebar.input.blur();
      renderer.requestRender();
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
