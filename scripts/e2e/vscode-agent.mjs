// Runs one real Claude agent (haiku, the logged-in subscription) in the repository that vscode-setup.mjs prepared and
// reports when the first agent shows up on the server (what the Agents view polls). Usage:
//   node scripts/e2e/vscode-agent.mjs <setup-root> [port] [installedTimestampMs]
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [rootDir, port = "4399", installedAt] = process.argv.slice(2);
const home = path.join(rootDir, "home");
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: url, LANES_USER: "Ana", LANES_EMAIL: "ana@example.com" };
for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(k)) delete env[k];
const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
const state = async () => (await fetch(url + "/v1/state", { headers: { authorization: `Bearer ${token}` } })).json();

const prompt = 'Use only the Write tool, never Bash, no explanations. Create files src/f1.ts through src/f12.ts one at a time with the Write tool (each exporting const fN = N), then add the line "// done" at the end of src/app.ts with the Edit tool.';
const child = spawn("claude", ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "1", "--permission-mode", "acceptEdits", "--setting-sources", "project", "--disallowedTools", "WebFetch,WebSearch,Task,Agent"], { cwd: path.join(rootDir, fs.readdirSync(rootDir).find((d) => d.startsWith("my pr"))), env, windowsHide: true });
child.stdout.pipe(fs.createWriteStream(path.join(rootDir, "agent.jsonl")));
child.stderr.pipe(process.stderr);
child.stdin.end(prompt);
const started = Date.now();
let seen = 0;
const poll = setInterval(async () => {
  try {
    const s = await state();
    if (!seen && s.agents.length > 0) {
      seen = Date.now();
      console.log(`first agent on the server ${((seen - started) / 1000).toFixed(1)} s after the agent started` + (installedAt ? `, ${((seen - Number(installedAt)) / 1000).toFixed(0)} s after the .vsix install` : ""));
    }
  } catch { /* server not up */ }
}, 500);
child.on("exit", async (code) => {
  clearInterval(poll);
  console.log("agent exited", code, `${((Date.now() - started) / 1000).toFixed(0)} s`);
  process.exit(0);
});
