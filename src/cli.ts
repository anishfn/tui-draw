#!/usr/bin/env bun
import { startClient } from "./client/index.ts";
import { DEFAULT_SERVER_URL } from "./types/index.ts";

/* -------------------------------------------------------------------------- */
/* tui-draw — single-server client                                            */
/* --------------------------------------------------------------------------
 * There is one fixed server (see DEFAULT_SERVER_URL in src/types/index.ts).
 * Running `tui-draw` just connects to it and opens the room lobby, where you
 * create or join a room from inside the TUI. There are intentionally no other
 * subcommands — the client cannot point at a different server (aside from the
 * SERVER env override, used by the host for local testing).
 * -------------------------------------------------------------------------- */

const HELP = `\
tui-draw — collaborative drawing in your terminal

USAGE
  tui-draw [name]
  tui-draw -n <name>

OPTIONS
  -n, --name <name>   Your display name (otherwise a random one is assigned)
  -h, --help          Show this help

Once connected you pick or create a room from the lobby. The server is fixed;
ask the host for the room code to join their game.
`;

function parseName(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-n" || arg === "--name") return argv[i + 1];
    if (!arg.startsWith("-")) return arg; // first bare positional is the name
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  const name = parseName(argv);
  // The SERVER env var stays as a host-side override; everyone else uses the
  // single fixed server baked into DEFAULT_SERVER_URL.
  const serverUrl = process.env.SERVER ?? DEFAULT_SERVER_URL;

  await startClient({ name, serverUrl });
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
