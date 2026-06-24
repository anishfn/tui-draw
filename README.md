# tui-draw

A real-time multiplayer **drawing & guessing game** that runs entirely in your
terminal — think *Skribbl.io*, rendered as a fast native TUI.

## Requirements

- **[Node](https://nodejs.org) ≥ 18** or **[Bun](https://bun.sh) ≥ 1.1**
- A terminal that supports mouse events (most modern ones do)

## Usage

Just run the client — it connects to the hosted game server automatically.
Use whichever runtime you have:

```bash
npx @anishfn/tui-draw             # join with a random name (Node)
npx @anishfn/tui-draw Alice       # join with a display name
bunx @anishfn/tui-draw Alice      # same thing, via Bun
```

Prefer a permanent `tui-draw` command? Install it globally:

```bash
npm install -g @anishfn/tui-draw  # or: bun add -g @anishfn/tui-draw
tui-draw Alice
```

## How to play

1. On launch you land in the **lobby** — create a room or join one with its
   6-character code.
2. The first player in a room is the **host**. Once a second player joins, the
   host presses **`S`** to start the game.
3. Share the room code (press **`Ctrl+Y`** to copy it) so friends can join the
   same room.

Take turns drawing the secret word while everyone else guesses in chat.
