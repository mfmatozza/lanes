// Drives the real hook with the server down and then up, and checks the local ledger and `lanes report` hold only counts
// and times: no path, prompt, user or repository name. Everything runs in C:/lanes-tmp with a temporary LANES_HOME.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LANES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = process.env.LANES_TMP ?? "C:/lanes-tmp";
const t = fs.mkdtempSync(path.join(tmp, "lanes-ledger-"));
const home = path.join(t, "home"), repo = path.join(t, "Acme Payroll Secrets");
fs.mkdirSync(home); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q", "-b", "main"); git("config", "user.name", "Zelda Hyrule"); git("config", "user.email", "zelda@example.com"); git("config", "core.autocrlf", "false");
fs.mkdirSync(path.join(repo, "src")); fs.writeFileSync(path.join(repo, "src", "salaries-confidential.ts"), "export const s = 1;\n");
git("add", "-A"); git("commit", "-qm", "init");
const env0 = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_USER: "Zelda Hyrule", LANES_EMAIL: "zelda@example.com" };
const init = spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), "init", "--dir", repo], { env: env0, encoding: "utf8" });
if (init.status !== 0) throw new Error(init.stdout + init.stderr);
const port = 4700 + Math.floor(Math.random() * 200);
const env = { ...env0, LANES_SERVER: `http://127.0.0.1:${port}` };
const hook = (event, input) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(repo, ".lanes", "hook.cjs"), event], { env, cwd: repo });
  c.stdout.resume(); c.stderr.resume();
  c.on("close", (code) => resolve(code));
  c.stdin.end(JSON.stringify({ session_id: "led", cwd: repo, ...input }));
});
const edit = (n) => hook("pre", { tool_name: "Edit", tool_input: { file_path: path.join(repo, "src", "salaries-confidential.ts") }, n });
await hook("prompt", { prompt: "raise CEO salary to HUNTER2-PASSWORD-9f3 in salaries-confidential.ts" });
for (let i = 0; i < 3; i++) await edit(i); // server down: fail open, counted
const server = spawn(process.execPath, [path.join(LANES, "dist", "server.cjs")], { env: { ...env0, LANES_PORT: String(port) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < 2; i++) { await edit(i); await hook("post", { tool_name: "Edit", tool_input: { file_path: path.join(repo, "src", "salaries-confidential.ts") } }); }
const ledger = fs.readFileSync(path.join(home, "ledger.jsonl"), "utf8");
const report = spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), "report"], { env, encoding: "utf8" });
const json = spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), "report", "--json"], { env, encoding: "utf8" });
const file = path.join(t, "report.txt");
spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), "report", "--file", file], { env, encoding: "utf8" });
const all = { ledger, text: report.stdout + report.stderr, json: json.stdout, file: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" };
const bad = [];
for (const [name, text] of Object.entries(all)) for (const secret of ["Acme", "Payroll", "salaries", "HUNTER2", "Zelda", "zelda@", "CEO", t.replace(/\\/g, "/")]) if (text.includes(secret)) bad.push(`${name} contains "${secret}"`);
console.log("ledger lines:", ledger.trim().split("\n").length, "| kinds:", [...new Set(ledger.trim().split("\n").map((l) => JSON.parse(l).kind))].join(","));
console.log(all.text.trim().split("\n").slice(0, 12).join("\n"));
// what the server was told
const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
const snap = await (await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { authorization: `Bearer ${token}` } })).json();
console.log("server events:", JSON.stringify((snap.events ?? []).map((e) => e.kind)));
server.kill(); spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
for (const b of bad) console.log("PROBLEM:", b);
console.log(bad.length ? "FAILED" : "ALL OK");
if (!bad.length) fs.rmSync(t, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
