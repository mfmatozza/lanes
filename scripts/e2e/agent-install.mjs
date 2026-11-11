// Runs the website's "setup prompt" with a REAL Claude Code (haiku, the logged-in subscription) in a temp repository with a
// bare origin, and checks that the agent alone (no clicks) installs the extension and sets the repository up.
// Usage: node scripts/e2e/agent-install.mjs [--keep] [--prompt-file <file>]     (the .vsix must be built: npm run package)
// Isolation: `code` is a shim that adds --user-data-dir, VSCODE_EXTENSIONS points at a temp folder (VS Code honours it),
// LANES_HOME is a temp folder, only the project's settings are read. Nothing touches ~/.vscode, ~/.lanes or ~/.claude/settings.json.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const keep = process.argv.includes("--keep");
const promptFile = process.argv.includes("--prompt-file") ? process.argv[process.argv.indexOf("--prompt-file") + 1] : undefined;
const t = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.LANES_TMP ?? "C:/lanes-tmp", "install-")));
const d = { ud: path.join(t, "ud"), ext: path.join(t, "ext"), home: path.join(t, "home"), shim: path.join(t, "shim"), origin: path.join(t, "origin.git"), repo: path.join(t, "repo") };
for (const x of [d.ud, d.ext, d.home, d.shim]) fs.mkdirSync(x, { recursive: true });
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The user's own `code`, found before PATH is changed.
const realCode = execFileSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8" }).split(/\r?\n/).find((l) => l && !l.endsWith(".cmd")) ?? "";
if (!realCode) throw new Error("`code` is not on PATH");
const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`);
fs.writeFileSync(path.join(d.shim, "code"), `#!/bin/bash\nexec "${process.platform === "win32" ? posix(realCode) : realCode}" --user-data-dir "${process.platform === "win32" ? posix(d.ud) : d.ud}" "$@"\n`, { mode: 0o755 });

git(t, "init", "-q", "--bare", "-b", "main", d.origin);
git(t, "clone", "-q", d.origin, d.repo);
for (const [k, v] of [["user.name", "Ana"], ["user.email", "ana@example.com"], ["core.autocrlf", "false"]]) git(d.repo, "config", k, v);
fs.mkdirSync(path.join(d.repo, "src"));
fs.writeFileSync(path.join(d.repo, "src", "app.ts"), "export const app = 1;\n");
git(d.repo, "add", "-A");
git(d.repo, "commit", "-qm", "init");
git(d.repo, "push", "-q", "origin", "main");
const vsix = fs.readdirSync(path.join(root, "packages", "extension")).find((f) => f.endsWith(".vsix"));
if (!vsix) throw new Error("build the .vsix first: npm run package");
fs.copyFileSync(path.join(root, "packages", "extension", vsix), path.join(d.repo, vsix));

// The prompt: the one on the website (docs/product/install-verified.md, section C) unless --prompt-file is given.
const prompt = (promptFile ? fs.readFileSync(promptFile, "utf8") : fs.readFileSync(path.join(root, "docs", "product", "install-verified.md"), "utf8").match(/<!-- prompt:beta -->\s*```text\n([^]*?)```/)?.[1] ?? "").replaceAll("lanes-0.1.0.vsix", path.join(d.repo, vsix).replace(/\\/g, "/"));
if (!prompt.trim()) throw new Error("no prompt found");

const env = { ...process.env, PATH: `${d.shim}${path.delimiter}${process.env.PATH}`, VSCODE_EXTENSIONS: d.ext, LANES_HOME: d.home, LANES_AUTOSTART: "0" };
for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(k)) delete env[k];
const run = spawnSync("claude", ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "1", "--setting-sources", "project", "--allowedTools", "Bash", "--disallowedTools", "WebFetch,WebSearch,Task,Agent"], { cwd: d.repo, env, input: prompt, encoding: "utf8", timeout: 300_000, windowsHide: true, shell: process.platform === "win32" });
fs.writeFileSync(path.join(t, "agent.jsonl"), run.stdout ?? "");

const steps = [];
let final = "";
for (const line of (run.stdout ?? "").split("\n").filter(Boolean)) {
  try {
    const m = JSON.parse(line);
    for (const c of m.message?.content ?? []) if (c.type === "tool_use") steps.push(`${c.name}: ${String(c.input?.command ?? JSON.stringify(c.input)).slice(0, 200)}`);
    if (m.type === "result") final = String(m.result ?? "");
  } catch { /* not a JSON line */ }
}
const checks = {};
checks["extension installed"] = fs.existsSync(path.join(d.ext, fs.readdirSync(d.ext).find((f) => f.startsWith("michelefmatozza.lanes-")) ?? "x", "dist", "lanes.cjs"));
checks[".lanes/hook.cjs in repo"] = fs.existsSync(path.join(d.repo, ".lanes", "hook.cjs"));
checks["hooks in .claude/settings.json"] = fs.existsSync(path.join(d.repo, ".claude", "settings.json")) && /hook\.cjs/.test(fs.readFileSync(path.join(d.repo, ".claude", "settings.json"), "utf8"));
checks["setup commit made"] = git(d.repo, "log", "-1", "--format=%s") === "chore: set up Lanes";
checks["lanes/main on origin"] = git(d.repo, "ls-remote", "--heads", "origin", "lanes/main") !== "";
checks["agent did not push main"] = git(d.origin, "log", "-1", "--format=%s", "main") === "init";
console.log(JSON.stringify({ exit: run.status, dir: t, steps, final: final.slice(0, 1500), checks }, null, 2));
if (!keep) fs.rmSync(t, { recursive: true, force: true });
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
