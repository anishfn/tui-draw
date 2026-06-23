import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextRenderable,
  fg,
  stringToStyledText,
  t,
  type TextChunk,
  type CliRenderer,
} from "@opentui/core";
import type { RoomInfo } from "../../types/index.ts";

export interface LobbyOptions {
  onCreateRoom: (name: string, password?: string, isPrivate?: boolean) => void;
  onJoinRoom: (roomId: string, password?: string) => void;
}

export interface LobbyHandle {
  readonly root: BoxRenderable;
  setRooms(rooms: RoomInfo[]): void;
  setError(msg: string): void;
  clearError(): void;
  focusFirst(): void;
  /** Route every keypress from client/index.ts through here while in lobby. */
  handleKeypress(key: { name: string }): void;
}

export function createRoomLobby(
  renderer: CliRenderer,
  opts: LobbyOptions,
): LobbyHandle {
  /* --------------------------------------------------------------------- */
  /* Root layout                                                            */
  /* --------------------------------------------------------------------- */

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });

  const header = new TextRenderable(renderer, {
    content: "tui-draw  —  pick a room or create one",
    flexShrink: 0,
    paddingLeft: 1,
  });

  /* --------------------------------------------------------------------- */
  /* Main row: room list (left) + forms (right)                            */
  /* --------------------------------------------------------------------- */

  const mainRow = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    gap: 1,
  });

  /* --- Room list ------------------------------------------------------- */
  const listBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    title: " Rooms ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const listText = new TextRenderable(renderer, { content: "No rooms yet — create one!" });
  listBox.add(listText);

  /* --- Right panel: create + join forms ------------------------------- */
  const rightPanel = new BoxRenderable(renderer, {
    width: 36,
    flexShrink: 0,
    flexDirection: "column",
    gap: 1,
  });

  /* Create form */
  const createBox = new BoxRenderable(renderer, {
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    title: " Create room ",
    paddingLeft: 1,
    paddingRight: 1,
    gap: 1,
  });
  const createNameInput = new InputRenderable(renderer, {
    placeholder: "Room name…",
    maxLength: 32,
  });
  const createPassInput = new InputRenderable(renderer, {
    placeholder: "Password (optional)…",
    maxLength: 64,
  });
  const createPrivateToggle = new TextRenderable(renderer, {
    content: "[ ] Private  (Tab to toggle, hidden from room list)",
    flexShrink: 0,
  });
  createBox.add(createNameInput);
  createBox.add(createPassInput);
  createBox.add(createPrivateToggle);

  /* Join form */
  const joinBox = new BoxRenderable(renderer, {
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    title: " Join room ",
    paddingLeft: 1,
    paddingRight: 1,
    gap: 1,
  });
  const joinCodeInput = new InputRenderable(renderer, {
    placeholder: "Room code (e.g. ABC123)…",
    maxLength: 6,
  });
  const joinPassInput = new InputRenderable(renderer, {
    placeholder: "Password (if required)…",
    maxLength: 64,
  });
  joinBox.add(joinCodeInput);
  joinBox.add(joinPassInput);

  rightPanel.add(createBox);
  rightPanel.add(joinBox);

  mainRow.add(listBox);
  mainRow.add(rightPanel);

  /* --- Status bar ------------------------------------------------------ */
  const statusBar = new TextRenderable(renderer, {
    content: "Tab to cycle fields · Enter to submit",
    flexShrink: 0,
    paddingLeft: 1,
  });

  root.add(header);
  root.add(mainRow);
  root.add(statusBar);

  /* --------------------------------------------------------------------- */
  /* Private toggle state                                                  */
  /* --------------------------------------------------------------------- */

  let isPrivate = false;

  function renderToggle(focused: boolean): void {
    const check = isPrivate ? "x" : " ";
    const label = `[${check}] Private  (hidden from room list)`;
    createPrivateToggle.content = focused ? t`${fg("#89b4fa")(label)}` : label;
    renderer.requestRender();
  }
  renderToggle(false);

  /* --------------------------------------------------------------------- */
  /* Focus cycle — 5 slots: name, pass, [private toggle], join-code, join-pass */
  /* --------------------------------------------------------------------- */

  type Slot =
    | { kind: "input"; ref: InputRenderable }
    | { kind: "toggle" };

  const slots: Slot[] = [
    { kind: "input", ref: createNameInput },
    { kind: "input", ref: createPassInput },
    { kind: "toggle" },
    { kind: "input", ref: joinCodeInput },
    { kind: "input", ref: joinPassInput },
  ];
  let focusIdx = 0;

  function applyFocus(idx: number, focused: boolean): void {
    const slot = slots[idx]!;
    if (slot.kind === "input") {
      focused ? slot.ref.focus() : slot.ref.blur();
    } else {
      renderToggle(focused);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Submit handlers                                                       */
  /* --------------------------------------------------------------------- */

  function submitCreate(): void {
    const name = createNameInput.value.trim();
    if (!name) {
      setError("Enter a room name.");
      return;
    }
    const pass = createPassInput.value || undefined;
    opts.onCreateRoom(name, pass, isPrivate || undefined);
  }

  function submitJoin(): void {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      setError("Enter a 6-character room code.");
      return;
    }
    const pass = joinPassInput.value || undefined;
    opts.onJoinRoom(code, pass);
  }

  createNameInput.on(InputRenderableEvents.ENTER, () => submitCreate());
  createPassInput.on(InputRenderableEvents.ENTER, () => submitCreate());
  joinCodeInput.on(InputRenderableEvents.ENTER, () => submitJoin());
  joinPassInput.on(InputRenderableEvents.ENTER, () => submitJoin());

  /* --------------------------------------------------------------------- */
  /* Room list rendering                                                   */
  /* --------------------------------------------------------------------- */

  const NL: TextChunk[] = stringToStyledText("\n").chunks;

  function setRooms(rooms: RoomInfo[]): void {
    if (rooms.length === 0) {
      listText.content = "No rooms yet — create one!";
      return;
    }
    const chunks: TextChunk[] = [];
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i]!;
      const lock = r.hasPassword ? " 🔒" : "   ";
      const status = r.phase === "drawing" ? "drawing" : r.phase === "intermission" ? "break" : "waiting";
      const count = `${r.playerCount}/${r.maxPlayers}`;
      const line = t`${fg("#89b4fa")(r.id)}${lock}  ${r.name}  ${count}  ${status}`;
      chunks.push(...line.chunks);
      if (i < rooms.length - 1) chunks.push(...NL);
    }
    listText.content = new StyledText(chunks);
  }

  function setError(msg: string): void {
    statusBar.content = t`${fg("#f38ba8")("✗ " + msg)}`;
  }

  function clearError(): void {
    statusBar.content = "Tab to cycle fields · Enter to submit";
  }

  return {
    root,

    setRooms,
    setError,
    clearError,

    focusFirst() {
      applyFocus(focusIdx, false);
      focusIdx = 0;
      applyFocus(0, true);
    },

    handleKeypress(key: { name: string }) {
      if (key.name === "tab") {
        applyFocus(focusIdx, false);
        focusIdx = (focusIdx + 1) % slots.length;
        applyFocus(focusIdx, true);
        renderer.requestRender();
        return;
      }
      const slot = slots[focusIdx];
      if (slot?.kind === "toggle" && (key.name === "return" || key.name === "space")) {
        isPrivate = !isPrivate;
        renderToggle(true);
      }
    },
  };
}
