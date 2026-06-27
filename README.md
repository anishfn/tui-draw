# drawtui

A real-time multiplayer **drawing & guessing game** that runs entirely in your
terminal — think *Skribbl.io*, rendered as a fast native TUI.

## Requirements

The terminal renderer uses a native core over FFI, so you need **one** of:

- **[Node.js](https://nodejs.org) ≥ 26.3** — uses Node's `node:ffi` (drawtui
  launches it with `--experimental-ffi` for you), or
- **[Bun](https://bun.sh) ≥ 1.1** — uses Bun's native FFI.

Plus a terminal that supports mouse events (most modern ones do).

## Usage

Just run the client — it connects to the hosted game server automatically. It
runs on whichever runtime you launch it with (Node 26.3+ or Bun), no extra
install needed:

```bash
npx drawtui Alice    # via npm/Node — runs on node:ffi
bunx drawtui Alice   # via Bun
```

Prefer a permanent `drawtui` command? Install it globally:

```bash
npm install -g drawtui   # or: bun add -g drawtui
drawtui Alice
```

## How to play

1. On launch you land in the **lobby** — create a room or join one with its
   6-character code.
2. The first player in a room is the **host**. Once a second player joins, the
   host presses **`S`** to start the game.
3. Share the room code (press **`Ctrl+Y`** to copy it) so friends can join the
   same room.

Take turns drawing the secret word while everyone else guesses in chat.
