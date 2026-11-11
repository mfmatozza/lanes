// Prepares an isolated VS Code run for the extension: temp profile, temp extensions dir, a repository with a bare origin,
// and times the .vsix install. Prints the paths as JSON. Usage: node scripts/e2e/vscode-setup.mjs [port]
// Nothing here touches ~/.claude, ~/.lanes or your real VS Code profile.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = process.argv[2] ?? "4399";
const t = fs.realpathSync.native(fs.mkdtempSync(path.join((process.env.LANES_TMP ?? "C:/lanes-tmp"), "vscode-")));
const dirs = { root: t, userData: path.join(t, "ud"), extensions: path.join(t, "ext"), home: path.join(t, "home"), origin: path.join(t, "origin.git"), repo: path.join(t, "my pröject 日本") };
for (const d of [dirs.userData, dirs.extensions, dirs.home]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(dirs.userData, "User"), { recursive: true });
fs.writeFileSync(
  path.join(dirs.userData, "User", "settings.json"),
  JSON.stringify({ "lanes.serverUrl": `http://127.0.0.1:${port}`, "workbench.startupEditor": "none", "chat.disableAIFeatures": true, "update.mode": "none", "telemetry.telemetryLevel": "off", "window.restoreWindows": "none", "extensions.autoUpdate": false }, null, 2),
);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(t, "init", "-q", "--bare", "-b", "main", dirs.origin);
git(t, "clone", "-q", "-c", "core.autocrlf=false", dirs.origin, dirs.repo);
for (const [k, v] of [["user.name", "Ana"], ["user.email", "ana@example.com"], ["core.autocrlf", "false"]]) git(dirs.repo, "config", k, v);
fs.mkdirSync(path.join(dirs.repo, "src"));
fs.writeFileSync(path.join(dirs.repo, "src", "app.ts"), "export const app = 1;\n");
git(dirs.repo, "add", "-A");
git(dirs.repo, "commit", "-qm", "init");
git(dirs.repo, "push", "-q", "origin", "main");

const vsix = fs.readdirSync(path.join(root, "packages", "extension")).find((f) => f.endsWith(".vsix"));
const t0 = Date.now();
const r = spawnSync("code", ["--user-data-dir", dirs.userData, "--extensions-dir", dirs.extensions, "--install-extension", path.join(root, "packages", "extension", vsix), "--force"], { encoding: "utf8", shell: true });
console.log(JSON.stringify({ ...dirs, port, installMs: Date.now() - t0, installOut: (r.stdout + r.stderr).trim().slice(-300) }, null, 1));
