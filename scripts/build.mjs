// Bundles the hook and the server into single CommonJS files with no dependencies (ADR-0020).
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// The extension's version, for `lanes mcp`'s serverInfo (packages/cli/src/mcp.ts).
const version = JSON.stringify(JSON.parse(readFileSync("packages/extension/package.json", "utf8")).version);
const common = { bundle: true, platform: "node", format: "cjs", logLevel: "warning", define: { "import.meta.main": "true", __LANES_VERSION__: version } };
await build({ ...common, entryPoints: ["packages/hook/src/hook.ts"], outfile: "dist/hook.cjs" });
await build({ ...common, entryPoints: ["packages/server/src/main.ts"], outfile: "dist/server.cjs" });
await build({ ...common, entryPoints: ["packages/cli/src/cli.ts"], outfile: "dist/lanes.cjs" });
// The extension: no CLI main (import.meta.main false), bundled with the hook and the server it installs and starts.
await build({ ...common, define: { "import.meta.main": "false", __LANES_VERSION__: version }, external: ["vscode"], entryPoints: ["packages/extension/src/extension.ts"], outfile: "packages/extension/dist/extension.cjs" });
const { copyFileSync } = await import("node:fs");
// lanes.cjs too: the extension's users have no `lanes` on PATH; an agent or a teammate runs `node <extension>/dist/lanes.cjs ...`.
for (const f of ["hook.cjs", "server.cjs", "lanes.cjs"]) copyFileSync(`dist/${f}`, `packages/extension/dist/${f}`);
