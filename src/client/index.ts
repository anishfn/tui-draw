import { BoxRenderable, CliRenderEvents, TextRenderable, createCliRenderer, fg, t } from "@opentui/core";
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
import { C, PALETTE } from "./ui/theme.ts";

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

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
    exitOnCtrlC: false, // we confirm quit ourselves
    useMouse: true,
    enableMouseMovement: true,
    targetFps: 60,
  });

  const state = new ClientState();
  state.myName = MY_NAME;

  let ws: WebSocket | null = null;
  let autoActionFired = false;
  // Chat lines we've already shown locally (optimistic echo). The server
  // broadcasts our own messages back to us, so we de-dupe that echo here.
  const pendingEcho: string[] = [];

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
  const NOT_CONNECTED = `Not connected to ${SERVER_URL} - is the server running and the address correct?`;

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
      getTool: () => state.tool,
    },
    sidebar: {
      onSubmit: (text) => {
        const ok = send({ t: PacketType.CHAT_MESSAGE, msg: { sender: state.myName, content: text } });
        if (!ok) return;
        // Render our own line immediately instead of waiting for the server
        // round-trip (the source of the "chat feels slow" lag). The server
        // slices content to 200 chars, so match that for the echo de-dupe.
        const shown = text.slice(0, 200);
        pendingEcho.push(shown);
        if (pendingEcho.length > 32) pendingEcho.shift();
        state.pushFeed({ kind: "chat", sender: state.myName, text: shown });
        state.emitChange();
      },
    },
  });

  renderer.root.add(lobby.root);
  renderer.root.add(dash.root);
  dash.root.visible = false;

  /* --- Global quit-confirm overlay (Ctrl+C twice to quit) ---------------- */
  const quitOverlay = new BoxRenderable(renderer, {
    position: "absolute",
    top: 0, left: 0, width: "100%", height: "100%",
    justifyContent: "center", alignItems: "center",
    zIndex: 100, visible: false,
  });
  const quitBox = new BoxRenderable(renderer, {
    border: true, borderStyle: "rounded", borderColor: C.bad,
    titleColor: undefined, backgroundColor: C.surface,
    paddingTop: 1, paddingBottom: 1, paddingLeft: 3, paddingRight: 3,
    flexDirection: "column", title: " Quit? ", titleAlignment: "center",
  });
  quitBox.add(new TextRenderable(renderer, {
    content: t`${fg(C.text)("Leave the game and quit drawtui?")}`,
  }));
  quitBox.add(new TextRenderable(renderer, {
    content: t`${fg(C.muted)("press ")}${fg(C.bad)("Ctrl+C")}${fg(C.muted)(" again to quit, any other key to cancel")}`,
  }));
  quitOverlay.add(quitBox);
  renderer.root.add(quitOverlay);
  let pendingQuit = false;
  let quitTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelQuit = (): void => {
    if (!pendingQuit) return;
    pendingQuit = false;
    quitOverlay.visible = false;
    if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; }
    renderer.requestRender();
  };

  /* --- Transient celebration banner -------------------------------------- */
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const flashToast = (text: string): void => {
    dash.showToast(text);
    try { process.stdout.write("\x07"); } catch { /* no bell */ }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dash.hideToast(), 1800);
  };

  // The chat input's *own* focus state is the single source of truth for "is
  // the user typing?" — never a parallel boolean, which drifts out of sync and
  // lets number/`c` keys both type into chat AND fire drawing shortcuts.
  const chatFocused = (): boolean => dash.sidebar.input.focused;

  const updateActivePane = (): void => {
    dash.setActivePane(chatFocused() ? "chat" : "canvas");
  };

  /** Focus or blur the chat input (idempotent) and resync the active pane. */
  const setChatFocus = (on: boolean): void => {
    if (on && !dash.sidebar.input.focused) dash.sidebar.input.focus();
    else if (!on && dash.sidebar.input.focused) dash.sidebar.input.blur();
    updateActivePane();
    renderer.requestRender();
  };

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
        totalRounds: state.totalRounds,
        wordChoices: state.wordChoices,
        mode: state.drawMode,
        color: state.drawColor,
        size: state.brushSize,
        erasing: state.erasing,
        tool: state.tool,
      });
      dash.canvas.setInteractive(state.amDrawing);
      if (state.phase === "intermission") {
        dash.showScoreboard(state.players, state.myName, state.reveal);
      } else {
        dash.hideScoreboard();
      }
      if (state.phase === "selecting" && state.amChoosing) {
        dash.showWordChoice(state.wordChoices, state.timeLeft);
      } else {
        dash.hideWordChoice();
      }
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
  // `null` (not `true`) so the *first* sync always applies focus instead of
  // assuming the input is already in the right state.
  let prevWantInput: boolean | null = null;

  // The chat input should hold focus only when we can usefully type into it:
  // while guessing during a drawing turn, or during the intermission scoreboard.
  // We only auto-toggle when the *desired* state changes, so a manual Tab
  // override persists until the phase actually moves on.
  const applyFocus = (wantInput: boolean): void => {
    if (wantInput === prevWantInput) return;
    prevWantInput = wantInput;
    setChatFocus(wantInput);
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
        state.roomPassword = packet.password ?? "";
        firstSync = true;
        prevDrawerId = null;
        prevRound = -1;
        prevWantInput = null;
        dash.setRoom(packet.roomId, packet.roomName, state.roomPassword);
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
        state.reveal = s.reveal;
        state.timeLeft = s.timeLeft;
        state.round = s.round;
        state.totalRounds = s.totalRounds;
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

      case PacketType.CHAT_MESSAGE: {
        // Skip the echo of a line we already rendered optimistically on submit.
        if (packet.msg.sender === state.myName) {
          const i = pendingEcho.indexOf(packet.msg.content);
          if (i >= 0) { pendingEcho.splice(i, 1); break; }
        }
        state.pushFeed({ kind: "chat", sender: packet.msg.sender, text: packet.msg.content });
        state.emitChange();
        break;
      }

      case PacketType.SYSTEM_ALERT:
        state.pushAlert(packet.alert);
        if (packet.alert.kind === "correct") flashToast(packet.alert.text);
        state.emitChange();
        break;

      case PacketType.JOIN:
      case PacketType.LIST_ROOMS:
      case PacketType.CREATE_ROOM:
      case PacketType.JOIN_ROOM:
      case PacketType.LEAVE_ROOM:
      case PacketType.START_GAME:
      case PacketType.SET_ROUNDS:
      case PacketType.CHOOSE_WORD:
        break;
    }
  };

  /* --- WebSocket --------------------------------------------------------- */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const connect = (): void => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dash.sidebar.setConnection("connecting");
    ws = new WebSocket(SERVER_URL);
    ws.addEventListener("open", () => {
      dash.sidebar.setConnection("online");
      send({ t: PacketType.JOIN, name: MY_NAME });
      state.pushFeed({ kind: "system", text: `Connected to drawtui server as ${MY_NAME}.`, color: "#9ccfd8" });
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
      dash.sidebar.setConnection("offline");
      state.pushFeed({ kind: "system", text: "Disconnected from server.", color: "#eb6f92" });
      state.amDrawing = false;
      state.inRoom = false;
      state.roomId = null;
      autoActionFired = false;
      state.emitChange();
      switchToLobby();
      // Auto-reconnect unless we're shutting down.
      if (!cleanedUp && !reconnectTimer) {
        reconnectTimer = setTimeout(connect, 2000);
      }
    });
    ws.addEventListener("error", () => {
      dash.sidebar.setConnection("offline");
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
    // Confirm-on-quit: first Ctrl+C asks, second within the window quits.
    if (key.ctrl && key.name === "c") {
      if (pendingQuit) { cleanup(); process.exit(0); }
      pendingQuit = true;
      quitOverlay.visible = true;
      renderer.requestRender();
      if (quitTimer) clearTimeout(quitTimer);
      quitTimer = setTimeout(cancelQuit, 4000);
      return;
    }
    // Any other key dismisses the quit prompt without acting on that key.
    if (pendingQuit) { cancelQuit(); return; }

    if (!state.inRoom) {
      lobby.handleKeypress(key);
      return;
    }

    // While the help overlay is up, any key dismisses it.
    if (dash.isHelpOpen()) {
      dash.toggleHelp();
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

    // Focus toggle, help, and chat work in EVERY phase (even the lobby).
    if (key.name === "tab") {
      setChatFocus(!chatFocused());
      return;
    }

    // Help overlay can be opened any time (outside the chat input).
    if (!chatFocused() && (key.name === "?" || key.sequence === "?")) {
      dash.toggleHelp();
      return;
    }

    // While typing a guess/chat, let the input consume everything else.
    if (chatFocused()) return;

    // Lobby phase: the host starts the game and sets the round count.
    if (state.phase === "lobby") {
      if (key.name === "s" && state.amHost) send({ t: PacketType.START_GAME });
      if (state.amHost) {
        const dec = key.name === "<" || key.sequence === "<" || (key.shift && key.name === ",");
        const inc = key.name === ">" || key.sequence === ">" || (key.shift && key.name === ".");
        if (dec || inc) {
          const next = state.totalRounds + (inc ? 1 : -1);
          send({ t: PacketType.SET_ROUNDS, rounds: Math.max(1, Math.min(10, next)) });
        }
      }
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

    switch (key.name) {
      case "b": state.tool = "brush"; state.erasing = false; state.emitChange(); break;
      case "n": state.tool = "line"; state.erasing = false; state.emitChange(); break;
      case "m": state.tool = "rect"; state.erasing = false; state.emitChange(); break;
      case "v": state.tool = "circle"; state.erasing = false; state.emitChange(); break;
      case "f": state.tool = "fill"; state.erasing = false; state.emitChange(); break;
      case "g": state.drawMode = state.drawMode === "braille" ? "block" : "braille"; state.emitChange(); break;
      case "e": state.erasing = !state.erasing; state.emitChange(); break;
      case "[": state.brushSize = Math.max(1, state.brushSize - 1); state.emitChange(); break;
      case "]": state.brushSize = Math.min(8, state.brushSize + 1); state.emitChange(); break;
      case "z": {
        if (!state.amDrawing) break;
        const pts = key.shift ? dash.canvas.redo() : dash.canvas.undo();
        if (pts) {
          send({ t: PacketType.CLEAR_BOARD });
          for (const p of pts) send({ t: PacketType.DRAW_POINT, point: p });
        }
        break;
      }
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
  }).catch((err) => console.error("Fatal: failed to start drawtui client:", err));
}
