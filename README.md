# Skribbl-TUI

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

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1**
- A terminal emulator that supports mouse events (most modern ones do)

---

## Quick Start

There is **one fixed server** that every client connects to. Set its address
once in `src/types/index.ts` (`DEFAULT_SERVER_URL`) to your server's public IP
or domain, e.g. `ws://203.0.113.10:3017`. See [Hosting](#hosting) for running
that server on a VPS/RDP.

```bash
bun install
```

**Host machine — start the one server:**

```bash
bun run server
# 🎨  tui-draw server listening on ws://localhost:3017
```

**Every player — just run the client** (it connects to the fixed server):

```bash
tui-draw            # or: bun run cli
tui-draw Alice      # with a display name
```

Players pick or create a room in the lobby. The first player to join a room is
its **host**; once a second player joins, the host presses **`S`** to start —
turns do not begin automatically. Share the 6‑char room code (press `Ctrl+Y` to
copy it) so friends can join the same room.

> The CLI is a pure client — there are no `join`/`create`/`list`/`server`
> subcommands; everything happens in the lobby. The `SERVER` env var still
> overrides the fixed address for the host's own local testing.

---

## Hosting

### Docker

```bash
docker-compose up -d
```

The server starts on port `3017`. Set `DEFAULT_SERVER_URL` in
`src/types/index.ts` to this server's public address (e.g.
`ws://YOUR_SERVER_IP:3017`) so every client connects to it automatically.

### Manual (VPS / RDP)

```bash
# On the server
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/anishfn/tui-draw && cd tui-draw
bun install
bun run server
```

Open port `3017` in your firewall (`ufw allow 3017`) **and** in your provider's
network firewall / security group. On a Windows RDP, install Bun for Windows,
`bun run server`, and allow TCP 3017 (`New-NetFirewallRule … -LocalPort 3017`).

### Cloud (Railway, Render, Fly.io)

All support Docker — point them at the `Dockerfile` and set `PORT=3017`.

---

## Configuration

| Env var  | Default                       | Description                                                 |
| -------- | ----------------------------- | ----------------------------------------------------------- |
| `PORT`   | `3017`                        | Server listen port                                          |
| `SERVER` | `DEFAULT_SERVER_URL`          | Override the fixed client target (host-side testing only)   |
| `NAME`   | `Artist-####`                 | Display name (also: `tui-draw <name>`)                      |

---

## How to Play

- The **host** (first player to join) presses `S` in the lobby to start the game
  once at least two players are present. The room code is shown on top of the
  canvas — press `Ctrl+Y` to copy it, or share it so friends can join.
- At the start of each turn the **drawer** is offered **three words** and picks one
  by pressing `1`, `2`, or `3` (auto-picks if they run out of time).
- The drawer then sees the secret word and paints it on the canvas with the mouse.
  Everyone else sees a masked hint like `_ A _ _ E R` and races to type the answer.
  The drawing is **resolution-independent**, so every player sees the same picture
  regardless of their terminal size.
- **Guess** by typing in the chat box and pressing Enter. Correct guesses are
  hidden from other players. Faster guesses earn more points; the drawer scores
  for every correct guess.
- A turn ends when everyone guesses or the timer runs out, then the pen rotates.

### Controls

| Key                           | Action                                               |
| ----------------------------- | ---------------------------------------------------- |
| `S`                           | Start the game (host only, in the lobby)             |
| `1`–`3`                       | Pick your word (drawer only, while choosing)         |
| Ctrl+Y                        | Copy the room code to your clipboard                 |
| **Mouse drag**                | Paint on the canvas (drawer only)                    |
| Tab                           | Toggle focus between chat input and command mode     |
| `b`                           | Toggle braille (fine) vs block (`█`) brush†          |
| `e`                           | Toggle the eraser†                                   |
| `[` / `]`                     | Decrease / increase brush size†                      |
| `1`–`8`                       | Pick a pen color†                                    |
| `c`                           | Clear the board (drawer only)†                       |
| Ctrl+C                        | Quit cleanly (restores your terminal)                |

† These keys only fire while the chat input is **unfocused** (press Tab first).

---

## Architecture

```
src/
├── types/index.ts          # Shared discriminated-union socket protocol
├── server/
│   ├── index.ts            # Bun.serve WebSocket room broker
│   ├── gameLoop.ts         # Authoritative timer, scoring & word evaluation
│   ├── room.ts             # Per-room state machine
│   └── registry.ts         # Room registry / player routing
└── client/
    ├── index.ts            # Entry point, WebSocket hookup, key bindings
    ├── state.ts            # Observable local mirror of server state
    └── ui/
        ├── dashboard.ts    # Master Flexbox layout shell
        ├── canvas.ts       # Braille / block sub-pixel paint handler
        ├── sidebar.ts      # Player list, chat feed & guess input
        └── roomLobby.ts    # Pre-game lobby screen
```

### Design Principles

- **Server is authoritative.** Clients hold a dumb, observable mirror and can
  never disagree about scores, the timer, or whose turn it is. Game rules live
  exclusively in `gameLoop.ts`, which is fully transport-agnostic.
- **One typed protocol, both ends.** Every frame on the wire is a member of the
  `Packet` discriminated union in `src/types`. Add a packet kind and the compiler
  flags every handler that forgot it.
- **Sub-pixel drawing.** Each terminal cell encodes a 2×4 braille dot grid
  (`U+2800`–`U+28FF`), giving an effective resolution of *(2·cols) × (4·rows)*
  dots. Mouse drags are Bresenham-interpolated and stamped with a filled disc
  brush for solid, continuous strokes.
- **No app theme.** The UI inherits your terminal's palette — no background or
  border colors are set. The only colors on screen are the drawer's chosen ink.
- **Clean teardown.** On any shutdown signal the client calls `renderer.destroy()`,
  restoring the alternate screen, cursor, and raw mouse-capture modes.

### Wire Protocol

| Packet         | Direction        | Payload                                                              |
| -------------- | ---------------- | -------------------------------------------------------------------- |
| `JOIN`         | client → server  | `{ name }`                                                           |
| `START_GAME`   | host → server    | *(none)* — only the host may start                                  |
| `WORD_CHOICES` | server → drawer  | `{ words }` — the three words to choose from (drawer only)          |
| `CHOOSE_WORD`  | drawer → server  | `{ index }` — which offered word the drawer picked                  |
| `DRAW_POINT`   | drawer ↔ lobby   | `{ x, y, color, mode, size, erase, drag }` — `x`/`y`/`size` normalized |
| `CHAT_MESSAGE` | client ↔ lobby   | `{ sender, content }` (evaluated as a guess)                         |
| `SYSTEM_ALERT` | server → clients | `{ kind, text }`                                                     |
| `CLEAR_BOARD`  | drawer ↔ lobby   | *(none)*                                                             |
| `STATE_SYNC`   | server → client  | Full `GameSnapshot` (drawer's frame carries the real word; others get the hint) |

---

## License

MIT
