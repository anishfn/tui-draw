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

The model is simple: **one server runs somewhere reachable**, and every player
runs the client, which connects to that one fixed address. Hosting is three
steps, no matter the platform:

1. **Point the client at your server.** Edit `DEFAULT_SERVER_URL` in
   `src/types/index.ts` to your server's public IP or domain — out of the box it
   ships as the placeholder `ws://YOUR-RDP-IP:3017`:

   ```ts
   export const DEFAULT_SERVER_URL = "ws://203.0.113.10:3017";
   ```

   Whatever you commit here is what your friends' clients will connect to, so do
   this *before* you share the repo with them.
2. **Run the server** on a machine with a public IP and the port open.
3. **Share the client** — friends clone the repo (with your edited
   `DEFAULT_SERVER_URL`), `bun install`, and run `tui-draw`. They never touch any
   config.

Pick one of the walkthroughs below for where the server runs.

---

### Option A — Linux VPS (DigitalOcean, Hetzner, AWS EC2, …)

Step by step, from a fresh Ubuntu/Debian box:

```bash
# 1. SSH into the VPS
ssh root@203.0.113.10        # ← your VPS public IP

# 2. Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc             # so `bun` is on PATH this session

# 3. Get the code and install deps
git clone https://github.com/anishfn/tui-draw && cd tui-draw
bun install

# 4. Set DEFAULT_SERVER_URL to THIS box's public IP (step 1 above),
#    e.g. nano src/types/index.ts → ws://203.0.113.10:3017

# 5. Open the port — BOTH the OS firewall and your provider's:
ufw allow 3017/tcp           # OS-level firewall
#   …and add an inbound rule for TCP 3017 in your cloud provider's
#   Security Group / Network firewall (AWS, GCP, Azure, Oracle all have one).

# 6. Smoke-test it in the foreground
bun run server
# → tui-draw server listening on ws://localhost:3017
```

**Keep it running after you log out.** The foreground process dies when your SSH
session closes, so use one of these:

```bash
# Quick & dirty
nohup bun run server > server.log 2>&1 &

# …or in a tmux session you can re-attach to
tmux new -s draw 'bun run server'   # detach with Ctrl-b d, reattach: tmux attach -t draw
```

**Recommended: a systemd service** that survives reboots and restarts on crash.
Create `/etc/systemd/system/tui-draw.service`:

```ini
[Unit]
Description=tui-draw game server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/tui-draw
ExecStart=/root/.bun/bin/bun run src/server/index.ts
Environment=PORT=3017
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now tui-draw
systemctl status tui-draw          # confirm it's "active (running)"
journalctl -u tui-draw -f          # tail its logs
```

---

### Option B — Windows RDP server

If your "server" is a Windows box you reach over Remote Desktop:

1. **Install Bun for Windows** — open PowerShell and run:

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

   Close and reopen PowerShell so `bun` is on your PATH.

2. **Get the code:**

   ```powershell
   git clone https://github.com/anishfn/tui-draw
   cd tui-draw
   bun install
   ```

3. **Set `DEFAULT_SERVER_URL`** in `src/types/index.ts` to the RDP box's
   **public** IP (not the `10.x`/`192.168.x` LAN address RDP shows you — use
   whatever `https://ifconfig.me` reports, or your provider's listed public IP),
   e.g. `ws://203.0.113.10:3017`.

4. **Allow the port through Windows Firewall** (run PowerShell *as
   Administrator*):

   ```powershell
   New-NetFirewallRule -DisplayName "tui-draw 3017" -Direction Inbound `
     -Protocol TCP -LocalPort 3017 -Action Allow
   ```

   If the box is behind a cloud provider, also open inbound TCP 3017 in its
   network security group, exactly like the VPS case.

5. **Run the server:**

   ```powershell
   bun run server
   ```

   To keep it running unattended, either leave the RDP session running, or
   register it as a service with [NSSM](https://nssm.cc/) pointing at
   `bun run src/server/index.ts`.

---

### Option C — Docker (anywhere Docker runs)

```bash
docker compose up -d           # builds the image, runs on port 3017, auto-restarts
docker compose logs -f         # watch the logs
```

Still set `DEFAULT_SERVER_URL` in `src/types/index.ts` to the host's public
address so clients find it. Override the published port with the `PORT` env var
(`PORT=8080 docker compose up -d`).

### Option D — Managed cloud (Railway, Render, Fly.io)

All support Docker — point them at the included `Dockerfile` and set `PORT=3017`
(or let them inject their own `PORT`; the server reads it). Set
`DEFAULT_SERVER_URL` to the public hostname they give you. Most of these
terminate TLS for you, so use the secure `wss://` scheme, e.g.
`wss://tui-draw.up.railway.app`.

---

### Verify it's reachable

From your **own laptop** (not the server), confirm the port is open before
telling friends to join:

```bash
# Linux/macOS — should connect, not hang or refuse
nc -vz 203.0.113.10 3017
# or hit it with curl; the server answers HTTP 426 to non-WebSocket requests:
curl -i http://203.0.113.10:3017
# → HTTP/1.1 426 ... "tui-draw server. Connect a WebSocket client to play."
```

If that times out, the port isn't open — re-check **both** firewalls (OS and
cloud security group). If it refuses instantly, the server isn't running.

> **TLS / `wss://`:** raw `ws://` is fine for friends-only games. For anything
> public, put the server behind a reverse proxy (Caddy/Nginx/Cloudflare) that
> terminates HTTPS, and set `DEFAULT_SERVER_URL` to `wss://your-domain`.

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
