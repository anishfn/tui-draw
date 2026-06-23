# Skribbl-TUI 🎨

A real-time, multiplayer **drawing & guessing game** that runs entirely in your
terminal — think *Skribbl.io*, but rendered with a blazing-fast native Zig
layout engine instead of a browser.

Built with **[Bun](https://bun.sh)** + **[@opentui/core](https://github.com/anomalyco/opentui)**:
pure TypeScript, a native `Bun.serve` WebSocket backend, and a Flexbox-driven
TUI. No Ink, no DOM wrappers, no Electron.

```
 ╭──────────────── Canvas ────────────────╮ ╭────────── Skribbl-TUI ──────────╮
 │ R3  ⏱ 62s   ✎ YOU DRAW   volcano        │ │ ╭─ Players ───────────────────╮ │
 │   ⢀⣀⠤⠤⠒⠒⠉⠉⠉⠒⠒⠤⠤⣀⡀                       │ │ │ ✎ Alice (you)  120          │ │
 │  ⡰⠁              ⠈⠢⡀                     │ │ │   Bob ✓  99                 │ │
 │  ⠇                 ⠘⡄                    │ │ ╰─────────────────────────────╯ │
 │  ⠘⢄              ⢀⠔⠁                     │ │ ╭─ Chat ──────────────────────╮ │
 │     ⠉⠒⠤⠤⣀⣀⣀⠤⠤⠒⠊⠉                        │ │ │ • Bob guessed the word!     │ │
 │                                         │ │ │ Bob: is it a mountain?      │ │
 │ Tab: focus chat · b: braille/block …    │ │ ╰─ Guess ─────────────────────╯ │
 ╰─────────────────────────────────────────╯ ╰─────────────────────────────────╯
```

---

## Quick start

Requires **Bun ≥ 1.1**.

```bash
bun install
```

**1. Start the server** (the authoritative game host):

```bash
bun run server
# 🎨  Skribbl-TUI server listening on ws://localhost:3017
```

**2. Start one client per player** (each in its own terminal):

```bash
bun run client Alice
bun run client Bob
# …add as many as you like
```

The first player to join becomes the drawer and a new turn begins automatically.

### Configuration

| Env var   | Default                  | Meaning                                     |
| --------- | ------------------------ | ------------------------------------------- |
| `PORT`    | `3017`                   | Server listen port / client connect port.   |
| `SERVER`  | `ws://localhost:$PORT`   | Full WebSocket URL the client dials.        |
| `NAME`    | `Artist-####`            | Display name (also `bun run client <name>`).|

Play across machines: `SERVER=ws://192.168.1.20:3017 bun run client Alice`.

---

## How to play

- The **drawer** is shown the secret word and paints it on the canvas with the
  mouse. Everyone else sees a masked hint like `_ A _ _ E R` and races to guess.
- **Guess** by typing in the chat box and pressing <kbd>Enter</kbd>. Correct
  guesses are hidden from other players, and the faster you guess the more
  points you score. The drawer earns points for every correct guess.
- A turn ends when everyone guesses or the timer runs out, then the pen rotates.

### Controls

| Key            | Action                                                        |
| -------------- | ------------------------------------------------------------- |
| **Mouse drag** | Paint on the canvas (drawer only).                            |
| <kbd>Tab</kbd> | Toggle focus between the chat input and drawer command mode.  |
| <kbd>b</kbd>   | Toggle **braille** (fine) vs **block** (`█`) brush.†          |
| <kbd>e</kbd>   | Toggle the **eraser**.†                                       |
| <kbd>[</kbd> / <kbd>]</kbd> | Decrease / increase brush size.†                  |
| <kbd>1</kbd>–<kbd>8</kbd> | Pick a pen color.†                                 |
| <kbd>c</kbd>   | Clear the board (drawer only).†                               |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Quit cleanly (restores your terminal).          |

† Command keys only fire while the chat input is **un-focused** (press
<kbd>Tab</kbd>), so they never clobber a guesser's typing.

---

## Architecture

```
skribbl-tui/
├── src/
│   ├── types/index.ts        # Shared, compile-time-exhaustive socket protocol
│   ├── server/
│   │   ├── index.ts          # Bun.serve WebSocket room/broker controller
│   │   └── gameLoop.ts       # Authoritative timer, scoring & word evaluation
│   └── client/
│       ├── index.ts          # Renderer entry, WebSocket hookup, key bindings
│       ├── state.ts          # Observable local mirror of server state
│       └── ui/
│           ├── dashboard.ts  # Master Flexbox layout shell (left / right split)
│           ├── canvas.ts     # Braille / block sub-pixel paint handler
│           └── sidebar.ts    # Player list, chat feed & guess input
```

### Design principles

- **The server is authoritative.** Clients hold only a dumb, observable mirror
  (`ClientState`) and can never disagree about scores, the timer, or whose turn
  it is. The game rules live exclusively in `gameLoop.ts`, which is fully
  transport-agnostic (it knows nothing about sockets or the terminal).
- **One typed protocol, both ends.** Every frame on the wire is a member of the
  discriminated-union `Packet` type in `src/types`. Add a packet kind and the
  compiler flags every handler that forgot it. All inbound frames are decoded
  through `decodePacket`, which returns `null` for anything malformed — a
  corrupt packet can never crash either process.
- **Sub-pixel drawing.** Each terminal cell encodes a 2×4 **braille** dot grid
  (`U+2800`–`U+28FF`), giving the canvas an effective resolution of
  *(2·cols) × (4·rows)* dots. Mouse drags are sampled at cell granularity, up-
  scaled to dot-space centers, and Bresenham-interpolated; a **filled disc
  brush** is stamped at every step, so strokes come out solid and continuous
  rather than dotted. A solid-`█` **block** brush and an **eraser** are also
  available, both with adjustable size.
- **No app theme — it's your terminal's.** The UI sets no background, border, or
  text colors; it inherits whatever palette your terminal already uses, and the
  canvas paints onto a transparent surface. The only colors on screen are the
  drawer's chosen ink.
- **Clean teardown.** The client never calls `process.exit()`. On any shutdown
  signal it calls `renderer.destroy()`, which restores the alternate screen,
  the cursor, and raw mouse-capture modes so your shell is left pristine.

### Wire protocol (`src/types/index.ts`)

| Packet         | Direction         | Payload                                          |
| -------------- | ----------------- | ------------------------------------------------ |
| `JOIN`         | client → server   | `{ name }`                                       |
| `DRAW_POINT`   | drawer ↔ lobby    | `{ x, y, color, mode, drag }` (cell coords)      |
| `CHAT_MESSAGE` | client ↔ lobby    | `{ sender, content }` (evaluated as a guess)     |
| `SYSTEM_ALERT` | server → clients  | `{ kind, text }` (hints, ticks, role changes)    |
| `CLEAR_BOARD`  | drawer ↔ lobby    | *(none)* — wipe the canvas                       |
| `STATE_SYNC`   | server → client   | full `GameSnapshot` (personalized: only the drawer's frame carries the real word) |

---

## License

MIT.
