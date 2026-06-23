#!/usr/bin/env bun
import { startClient } from "./client/index.ts";
import { startServer } from "./server/index.ts";
import { DEFAULT_PORT } from "./types/index.ts";

/* -------------------------------------------------------------------------- */
/* Tiny arg parser                                                            */
/* -------------------------------------------------------------------------- */

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (arg.startsWith("-") && arg.length === 2) {
      const aliases: Record<string, string> = { n: "name", p: "password", s: "server" };
      const key = aliases[arg[1]!] ?? arg[1]!;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "lobby";
  return { command, positional: positional.slice(1), flags };
}

/* -------------------------------------------------------------------------- */
/* Help                                                                       */
/* -------------------------------------------------------------------------- */

const HELP = `\
tui-draw — collaborative drawing in your terminal

USAGE
  tui-draw [command] [options]

COMMANDS
  lobby               Open room browser (default)
  join <code>         Join a room by its 6-character code
  create [name]       Create a new room and enter it
  list                Print available rooms and exit
  server              Start the game server

OPTIONS
  -n, --name <name>       Your display name
  -p, --password <pass>   Room password (join / create)
      --private            Make the created room private (hidden from lobby)
  -s, --server <url>      Server WebSocket URL  (default: ws://localhost:${DEFAULT_PORT})
      --port <port>        Port to listen on     (server command, default: ${DEFAULT_PORT})
  -h, --help              Show this help

EXAMPLES
  tui-draw                               # open the lobby
  tui-draw join ABC123 -n Alice          # quick join
  tui-draw create "Friday Fun"           # create a public room
  tui-draw create "Secret" --private     # create a private room (share code manually)
  tui-draw server --port 4000            # host a server
  SERVER=wss://example.com tui-draw      # connect to a remote server
`;

/* -------------------------------------------------------------------------- */
/* List command (non-interactive)                                             */
/* -------------------------------------------------------------------------- */

async function listRooms(serverUrl: string): Promise<void> {
  const { PacketType, decodePacket, encodePacket } = await import("./types/index.ts");

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout connecting to " + serverUrl)); }, 5000);

    ws.addEventListener("open", () => {
      ws.send(encodePacket({ t: PacketType.JOIN, name: "tui-draw-list" }));
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      const packet = decodePacket(ev.data as string);
      if (!packet) return;
      if (packet.t === PacketType.ROOM_LIST) {
        clearTimeout(timeout);
        if (packet.rooms.length === 0) {
          console.log("No rooms available.");
        } else {
          console.log(`${"CODE".padEnd(8)} ${"NAME".padEnd(24)} ${"PLAYERS".padEnd(10)} PHASE`);
          console.log("-".repeat(56));
          for (const r of packet.rooms) {
            const lock = r.hasPassword ? "🔒" : "  ";
            console.log(
              `${r.id.padEnd(8)} ${(lock + " " + r.name).padEnd(24)} ${`${r.playerCount}/${r.maxPlayers}`.padEnd(10)} ${r.phase}`
            );
          }
        }
        ws.close();
        resolve();
      }
    });

    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Cannot connect to " + serverUrl)); });
    ws.addEventListener("close", () => { clearTimeout(timeout); resolve(); });
  });
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags["help"] || flags["h"] || command === "help") {
    console.log(HELP);
    process.exit(0);
  }

  const serverUrl = (flags["server"] as string | undefined)
    ?? process.env.SERVER
    ?? `ws://localhost:${DEFAULT_PORT}`;

  const name = flags["name"] as string | undefined;
  const password = flags["password"] as string | undefined;

  switch (command) {
    case "lobby":
      await startClient({ name, serverUrl });
      break;

    case "join": {
      const roomId = (positional[0] ?? "").toUpperCase();
      if (!roomId || roomId.length !== 6) {
        console.error("tui-draw join <code>  — code must be 6 characters");
        process.exit(1);
      }
      await startClient({ name, serverUrl, autoJoin: { roomId, password } });
      break;
    }

    case "create": {
      const roomName = positional[0] ?? name ?? "My Room";
      const isPrivate = flags["private"] === true;
      await startClient({ name, serverUrl, autoCreate: { name: roomName, password, isPrivate } });
      break;
    }

    case "list":
      await listRooms(serverUrl);
      break;

    case "server": {
      const port = Number(flags["port"] ?? process.env.PORT ?? DEFAULT_PORT);
      await startServer(port);
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
