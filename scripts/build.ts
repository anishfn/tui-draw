#!/usr/bin/env bun
/**
 * scripts/build.ts
 * --------------------------------------------------------------------------
 * Bundles the client CLI (src/cli.ts) into a single plain-JavaScript file so
 * `tui-draw` runs on ANY runtime — Node, npm/pnpm/yarn installs, and Bun — not
 * just Bun. The TypeScript is transpiled and the local modules are inlined;
 * `@opentui/core` ships prebuilt JS (with a native core) so we keep it external
 * and let the consumer's package manager resolve it from node_modules.
 *
 * The published `bin` points at the output of this script (dist/cli.js) with a
 * `#!/usr/bin/env node` shebang, which Node, Bun, and every package-manager
 * shim know how to execute.
 * -------------------------------------------------------------------------- */

import { chmod } from "node:fs/promises";

const OUT_DIR = "dist";
const OUT_FILE = `${OUT_DIR}/cli.js`;
const NODE_SHEBANG = "#!/usr/bin/env node";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: OUT_DIR,
  target: "node",
  format: "esm",
  // Prebuilt package with a native core — resolve from node_modules at runtime
  // rather than inlining it into the bundle.
  external: ["@opentui/core"],
  naming: "cli.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Build failed");
}

// Bun copies the source `#!/usr/bin/env bun` shebang into the bundle. Rewrite
// it to a Node shebang so the bin works without Bun installed.
const built = await Bun.file(OUT_FILE).text();
const withoutShebang = built.startsWith("#!")
  ? built.slice(built.indexOf("\n") + 1)
  : built;
await Bun.write(OUT_FILE, `${NODE_SHEBANG}\n${withoutShebang}`);
await chmod(OUT_FILE, 0o755);

console.log(`Built ${OUT_FILE} (${(Bun.file(OUT_FILE).size / 1024).toFixed(1)} KB)`);
