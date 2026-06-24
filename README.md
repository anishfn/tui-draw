# drawtui

A real-time multiplayer **drawing & guessing game** that runs entirely in your
terminal — think *Skribbl.io*, rendered as a fast native TUI.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** — the terminal renderer uses Bun's native FFI,
  so Bun must be installed even if you launch via npm/npx
- A terminal that supports mouse events (most modern ones do)

## Usage

Just run the client — it connects to the hosted game server automatically. You
can launch it from npm or Bun; either way it runs under Bun:

```bash
bunx drawtui Alice   # via Bun
npx drawtui Alice    # via npm — re-execs under Bun automatically
```

Prefer a permanent `drawtui` command? Install it globally:

```bash
bun add -g drawtui   # or: npm install -g drawtui
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
