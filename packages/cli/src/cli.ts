// `lanes init | server | status`. Everything the VS Code commands "Set Up Repository" and "Start Local Server" do.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isLocalServer, isLoopback, loadConfig, loadOrCreateToken, tokenFor, writeUserConfig } from "@lanes/core/local.ts";
import { findRepo, teamContextOn } from "@lanes/core/repo.ts";
import { ghOnPath, pr, PrError, type PrFilter } from "./pr.ts";
import { collectReport, feedbackFile, formatReport, hostedWaitlist } from "./report.ts";
import { copilotAdapter } from "@lanes/core/agents/copilot.ts";
import { kiroAdapter } from "@lanes/core/agents/kiro.ts";
import { isLanesHook, withLanesCodexHooks, withLanesCursorHooks, withLanesGeminiHooks, withLanesHooks, withoutLanesCursorHooks, withoutLanesHooks, type ClaudeSettings, type CursorHooks } from "@lanes/core/settings.ts";
import type { AgentRequest } from "@lanes/core/types.ts";
import { defaultAgent, requestLines, runRequest, sentence, setTeamContext, TeamError, teamPost, whoAmI } from "./team.ts";
import { serveMcp } from "./mcp.ts";
import { installMore, moreMcpSetup, MORE_AGENTS, removeMore } from "./agents.ts";

/** Colour only for a person at a terminal: never when stdout is piped or redirected, or NO_COLOR is set (https://no-color.org). */
export const colorOn = (stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean => stream.isTTY === true && !env.NO_COLOR;
const paint = (code: string) => (text: string) => (colorOn() ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const STATUS_COLOR: Record<string, (s: string) => string> = { Waiting: yellow, Approved: green, Delivered: green, Declined: red, Expired: dim };

const HELP: Record<string, string> = {
  init: `lanes init [--dir <repo>] [--no-commit] [--server <url>] [--token <token>] [--user <name>] [--agents <names>]
  Set up Lanes in the repository containing --dir (default: the current folder): copies the hooks, merges them into
  .claude/settings.json, commits only those files and prepares the lanes/main branch. Safe to run again.
  --agents (comma-separated, default claude) also installs each agent's own hooks or plugin in the repository and prints
  how to add \`lanes mcp\` to it. Hooks or plugins: claude, codex, gemini, cursor, copilot, kiro, antigravity, factory,
  qwen, opencode, kilo, amp. MCP only: augment, junie, jetbrains, continue, zed, goose, warp.`,
  connect: `lanes connect --server <url> --token <token> [--user <name>]
  Point the hooks on this machine at a teammate's server (saved in ~/.lanes/config.json).`,
  server: `lanes server [--port <n>] [--host <addr>]
  Start the coordination server on this machine (default 127.0.0.1:4317) and print its token. Use --host 0.0.0.0 to let teammates connect.`,
  status: `lanes status [--server <url>]
  Show whether the server answers, and how many agents, leases and tasks it knows. Exit code 1 when it is offline.`,
  doctor: `lanes doctor [--dir <repo>] [--server <url>]
  Check this machine and repository for Lanes: Node, git, the hooks, team context, the server and your token, Claude Code. One line per check with what to do next. Exit code 1 when a check fails.`,
  report: `lanes report [--json] [--file <path>] [--days <n>] [--server <url>]
  Print what coordination did for the edits on this machine: edits that went ahead uncoordinated because the server was down, coordinated share, collisions handled, queue wait. Counts and times only: never file paths, prompts or names. Nothing is sent anywhere. --json prints the same as JSON; --file writes a text file with optional blank notes you may email if you want to.`,
  hosted: `lanes hosted
  Print the email to join the waitlist for the hosted server (planned, not built yet). A waitlist, not a purchase: nothing is sent from here.`,
  pr: `lanes pr [--task <task id, session or part of the title>] [--branch <name>] [--base <branch>] [--no-gh]
  Squash one task's checkpoint commits from lanes/main into a new branch, one Co-authored-by per contributor, and open a PR with gh (else print the commands).`,
  off: `lanes off [--dir <repo>] [--no-commit]
  Switch Lanes off in the repository containing --dir: removes the Lanes hooks from .claude/settings.json (and settings.local.json, .codex/hooks.json, .gemini/settings.json, .cursor/hooks.json, .github/hooks/lanes.json, .kiro/hooks/lanes.json), deletes .lanes/hook.cjs and .lanes/server.cjs and commits only those changes. Your own hooks and settings stay. Safe to run again; lanes init switches it back on.`,
  team: `lanes team [on|off] [--dir <repo>]
  Team context (preview). On: every agent in this repository gets a short team brief with each prompt and a one-line heads-up before it edits or reads a file a teammate is changing. Edits are never blocked. Writes .lanes/team.json; commit it so teammates get it. No argument: show whether it is on.`,
  say: `lanes say <message> [--dir <repo>]
  Post to the team chat of this repository. Agents only see messages that @mention their user (name without spaces) or @team, quoted as information. Put the message in quotes: PowerShell drops a bare @name.`,
  ask: `lanes ask <teammate> <request> [--edit] [--dir <repo>]
  Ask a teammate's agent to do something. Nothing reaches their agent until they approve it (lanes approve). Read only unless --edit. Expires in 30 minutes.`,
  requests: `lanes requests [--dir <repo>]
  List the open requests sent to you and by you in this repository, with their ids, status and time left.`,
  approve: `lanes approve <id> [--run [--agent claude|codex]] [--dir <repo>]
  Approve a request sent to you: your agent gets it with your next prompt. --run instead runs it now with your own Claude Code or Codex login (read only: Claude's plan mode or Codex's read-only sandbox; may edit: a separate worktree and branch) and sends the answer back to the asker. --agent picks one; by default Claude Code if installed, else Codex.`,
  deny: `lanes deny <id> [--dir <repo>]
  Decline a request sent to you. The asker sees it as declined.`,
  app: `lanes app [--print] [--dir <repo>]
  Open the Lanes app in your browser: who is working on what, the team chat, and requests to approve. Works with any editor or agent. The link holds your token: do not share it. --print only prints the link.`,
  mcp: `lanes mcp [--dir <repo>]
  Run the Lanes team tools as an MCP server over stdio, for any agent that supports MCP (team_brief, team_check_file, team_say, team_ask, team_requests, team_status, team_members). Example: claude mcp add lanes -- node <path>/lanes.cjs mcp`,
  invite: `lanes invite <name> [--github <login>]
  On the server's machine: give a teammate a personal token and print the \`lanes join\` command to send them privately. The token is shown once; inviting the same name again replaces it. With --github, no token is printed: the teammate runs \`lanes login\` and approves on GitHub. Once a team has members, chat and requests need a personal token.`,
  join: `lanes join <url> <token> [--user <name>]
  Use the personal token a teammate's \`lanes invite\` gave you: saves the server and token in ~/.lanes/config.json, checks the server accepts it and stores the name the server has for it (--user is only used when the server cannot say).`,
  login: `lanes login [--server <url>] [--print]
  Sign in with GitHub to a server whose admin ran \`lanes invite <name> --github <login>\`: shows a code to enter on github.com, then saves the server, your personal token and name in ~/.lanes/config.json, for the hooks, the CLI and VS Code. --print does not open the browser.`,
  remove: `lanes remove <name>
  On the server's machine: revoke a teammate's personal token at once.`,
  members: `lanes members
  On the server's machine: list the teammates who have a personal token.`,
};
const TEAM_COMMANDS = ["team", "say", "ask", "requests", "approve", "deny", "invite", "join", "remove"];
const usage = () => [`${bold("Lanes")} keeps your team's coding agents out of each other's way.\nUsage: lanes <command> [options]`, ...Object.values(HELP), "Run `lanes <command> --help` for one command."].join("\n\n");

/** Wrong command line: exit code 2, as opposed to a failure of a correct one. */
class UsageError extends Error {}

class UserError extends Error {}

/** A sentence for the file-system failures a user can fix (#187), instead of Node's errno dump; undefined for anything else. */
export function describeFsError(err: unknown): string | undefined {
  const e = err as NodeJS.ErrnoException & { dest?: string };
  const where = e?.dest ?? e?.path;
  if (!where || typeof e.code !== "string") return undefined;
  switch (e.code) {
    case "EPERM":
    case "EACCES":
    case "EROFS":
      return `Cannot write ${where}: ${e.code === "EROFS" ? "the folder is read-only" : "permission denied"}. Make it writable, or run Lanes in a folder you own, then run it again.`;
    case "ENOSPC":
      return `Cannot write ${where}: the disk is full.`;
    case "EEXIST":
    case "ENOTDIR":
      return `Cannot use ${where}: a file is in the way of a folder Lanes needs. Move or delete it, then run again.`;
    default:
      return undefined;
  }
}

/** --dir must exist: otherwise the walk up to a repository would blame "not a repository" (#187). */
function startDir(dir: string | undefined): string {
  const full = path.resolve(dir ?? process.cwd());
  if (!fs.existsSync(full)) throw new UserError(`${full} does not exist. Check --dir.`);
  return full;
}

/** Where hook.cjs and server.cjs live: next to this file when bundled, else the repo's dist/ folder. */
function assetsDir(): string {
  const here = path.dirname(process.argv[1] ?? ".");
  for (const dir of [process.env.LANES_DIST, here, path.join(here, "..", "..", "..", "dist")]) {
    if (dir && fs.existsSync(path.join(dir, "hook.cjs")) && fs.existsSync(path.join(dir, "server.cjs"))) return dir;
  }
  throw new UserError("hook.cjs and server.cjs not found. Run `npm run build` first.");
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Fails early, and truthfully, when git is not installed (#185): findRepo would otherwise report "not a git repository". */
export function requireGit(): void {
  if ((spawnSync("git", ["--version"], { stdio: "ignore" }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new UserError("git was not found on your PATH. Install git (https://git-scm.com), open a new terminal, then run this again.");
  }
}

/** A server address the hooks can use: http(s) with a host (#183). Throws a usage error showing the expected form. */
export function checkServerUrl(value: string): string {
  let ok = false;
  try {
    const u = new URL(value);
    ok = /^https?:$/.test(u.protocol) && u.hostname !== "";
  } catch {
    // not a URL at all
  }
  if (!ok) throw new UsageError(`'${value}' is not a server URL. Use the form http://host:4317 (or https://...).`);
  return value;
}

/** The addresses a teammate may use: a loopback server URL becomes each of this machine's LAN IPv4 addresses, as `lanes server` prints them. */
export function joinUrls(serverUrl: string): string[] {
  if (!isLoopback(serverUrl)) return [serverUrl];
  const lan = new Set(Object.values(os.networkInterfaces()).flatMap((l) => l ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address));
  if (lan.size === 0) return [serverUrl];
  return [...lan].map((address) => {
    const u = new URL(serverUrl);
    u.hostname = address;
    return u.toString().replace(/\/+$/, "");
  });
}

/** `lanes login` (ADR-0031): GitHub's device flow, run by the server; this side only shows the code and waits. */
async function login(server: string, open: boolean): Promise<void> {
  const call = async (route: string, body: Record<string, unknown>) => {
    let res: Response;
    try {
      res = await fetch(server + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new UserError(`Lanes server ${server} does not answer. Check the address (\`lanes login --server <url>\`).`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404 || res.status === 501) throw new UserError(`${server} doesn't offer Sign in with GitHub. Ask its admin for a \`lanes join\` command instead.`);
    if (!res.ok) throw new UserError(typeof data.error === "string" ? `${server}: ${sentence(data.error)}` : `The Lanes server answered ${res.status}.`);
    return data;
  };
  const start = await call("/v1/login/github/start", {});
  const { loginId, userCode, verificationUri, expiresIn } = start as { loginId: string; userCode: string; verificationUri: string; expiresIn: number };
  let interval = Number(start.interval) || 5;
  console.log(`${bold("Sign in with GitHub")}\nOpen ${verificationUri} and enter ${bold(userCode)}`);
  console.log(dim("Waiting for you to approve on GitHub…"));
  // Only a plain https link goes to the shell: it comes from GitHub through the server.
  if (open && /^https:\/\/[\w.:/-]+$/.test(verificationUri)) openInBrowser(verificationUri);
  const deadline = Date.now() + (Number(expiresIn) || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await call("/v1/login/github/poll", { loginId });
    if (r.status === "done" && typeof r.name === "string" && typeof r.token === "string") {
      writeUserConfig({ serverUrl: server, token: r.token, user: r.name });
      console.log(`Signed in as ${r.name}. Hooks, the CLI and VS Code on this machine now use your personal token.`);
      return;
    }
    if (r.status !== "pending") throw new UserError(typeof r.error === "string" ? sentence(r.error) : "The sign-in failed. Run `lanes login` again.");
    interval = Number(r.interval) || interval;
  }
  throw new UserError("The code expired before it was approved. Run `lanes login` again.");
}

/** False when something already listens on host:port (#184); any other problem is left for the server to report. */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "EADDRINUSE"));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** True if a `node` executable is on PATH, i.e. the committed hook command (a bare `node`) can start. */
export function nodeOnPath(searchPath = process.env.PATH ?? ""): boolean {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  return searchPath.split(path.delimiter).filter(Boolean).some((dir) => names.some((name) => fs.existsSync(path.join(dir, name))));
}

/**
 * Node that is not on PATH (#113) without committing a machine-specific path (#126): the committed settings.json always
 * says a bare `node`, and a machine without it gets the absolute path of the node running init in its own, git-ignored
 * .claude/settings.local.json. There the committed hooks stay silent (see hookCommand), so nothing runs twice. Once node
 * is on PATH again, init removes the local entries. Returns what to tell the user.
 * shortcut: inside VS Code (Electron) there is no plain node to point at, so the user is told to install Node.
 */
export function configureLocalRuntime(root: string, script: string, searchPath?: string): string[] {
  const file = path.join(root, ".claude", "settings.local.json");
  let local: ClaudeSettings = {};
  try {
    local = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return [`${file} is not valid JSON, so it was left alone.`];
  }
  const hasOurs = Object.values(local.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some(isLanesHook)));
  if (nodeOnPath(searchPath)) {
    if (hasOurs) {
      const rest = withoutLanesHooks(local);
      if (Object.keys(rest).length > 0) fs.writeFileSync(file, JSON.stringify(rest, null, 2) + "\n");
      else fs.rmSync(file);
    }
    return [];
  }
  if (!/^node(\.exe)?$/i.test(path.basename(process.execPath))) {
    return ["Node is not on your PATH, so the Lanes hooks cannot start on this machine. Install Node 22.18 or newer, then run `lanes init` again."];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(withLanesHooks(local, process.execPath, script), null, 2) + "\n");
  try {
    // Never committed: the path is only valid here.
    const ignored = spawnSync("git", ["check-ignore", "-q", file], { cwd: root }).status === 0;
    if (!ignored) {
      const exclude = path.resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, "\n.claude/settings.local.json\n");
    }
  } catch {
    // best effort: the file is still not part of the setup commit
  }
  return [`Node is not on your PATH: the hooks on this machine use ${process.execPath} through .claude/settings.local.json (not committed).`];
}

/**
 * How to open a URL in the default browser, with no shell parsing the URL. On Windows `cmd /c start` would expand
 * `%NAME%` and stop at `&`; PowerShell reads the URL from an environment variable, so it is never parsed as code, and
 * Start-Process hands it to ShellExecute whole, fragment included.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; env?: Record<string, string> } {
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:LANES_OPEN_URL"], env: { LANES_OPEN_URL: url } };
  return { cmd: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

/** Opens a URL in the default browser and returns at once; a missing opener is ignored (the caller prints the link). */
export function openInBrowser(url: string): void {
  const { cmd, args, env } = browserCommand(url);
  spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }).on("error", () => {}).unref();
}

// Agents whose hooks live in one file Lanes owns (S3.5).
const ADAPTERS = [copilotAdapter, kiroAdapter];
export const AGENTS =["claude", "codex", "gemini", "cursor", ...ADAPTERS.map((a) => a.agent), ...MORE_AGENTS];

/**
 * How to add `lanes mcp` to each agent. Printed only: user-level config is never edited. Claude and Codex take
 * `mcp add <name> -- <command>`; Gemini takes `mcp add <name> <command> [args...]` and defaults to the project's
 * .gemini/settings.json, hence --scope user (https://geminicli.com/docs/tools/mcp-server/); Cursor has no add command, only
 * mcp.json (https://cursor.com/docs/context/mcp).
 */
export function mcpSetup(agents: string[], cli = path.resolve(process.argv[1] ?? "lanes.cjs")): string[] {
  const p = cli.replace(/\\/g, "/");
  return agents.map((a) => {
    const adapter = ADAPTERS.find((x) => x.agent === a);
    if (adapter) return adapter.mcp(p);
    const more = moreMcpSetup(a, p);
    if (more) return more;
    if (a === "gemini") return `gemini mcp add --scope user lanes node "${p}" mcp`;
    if (a === "cursor") return `Cursor: add to ~/.cursor/mcp.json: ${JSON.stringify({ mcpServers: { lanes: { type: "stdio", command: "node", args: [p, "mcp"] } } })}`;
    return `${a} mcp add lanes -- node "${p}" mcp`;
  });
}

/** Parsed JSON of an agent's config file, or `{}` when there is none. Never overwrites a file it can't read. */
function readConfig<T>(file: string, command: string): T {
  if (!fs.existsSync(file)) return {} as T;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new UserError(`${file} is not valid JSON. Fix it, then run \`lanes ${command}\` again.`);
  }
}

/** Applies `update` to an adapter's file: `{}` deletes it (and its emptied folders), undefined leaves it alone. */
function writeAdapter(root: string, adapter: { file: string }, command: string, update: (json: Record<string, any>) => Record<string, any> | undefined): string | undefined {
  const file = path.join(root, adapter.file);
  const next = update(readConfig<Record<string, any>>(file, command));
  if (!next) return undefined;
  if (Object.keys(next).length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    return adapter.file;
  }
  fs.rmSync(file);
  for (let d = path.dirname(file); d.startsWith(root + path.sep); d = path.dirname(d)) {
    try {
      fs.rmdirSync(d); // only when empty
    } catch {
      break;
    }
  }
  return adapter.file;
}

export function init(dir: string, options: { commit: boolean; assets?: string; searchPath?: string; agents?: string[] }): { files: string[]; integration: Integration; notes: string[] } {
  const agents = options.agents ?? ["claude"];
  requireGit();
  const repo = findRepo(dir);
  if (!repo) throw new UserError(`${dir} is not inside a git repository.`);
  // A home folder that is itself a repository would put the hooks into the user's global ~/.claude/settings.json.
  // userInfo() ignores HOME/USERPROFILE, so a scripted fake home cannot hide the real one.
  const homes = [os.homedir(), os.userInfo().homedir].map((h) => path.resolve(h).toLowerCase());
  if (homes.includes(path.resolve(repo.root).toLowerCase())) {
    throw new UserError(`${repo.root} is your home folder, not a project. Run \`lanes init\` inside a project repository.`);
  }
  const assets = options.assets ?? assetsDir();

  // Claude Code reads .claude/settings.json only from the folder it was started in, and ${CLAUDE_PROJECT_DIR} is that
  // folder (checked with a real claude, #127). Started in a monorepo subfolder, it ignores the repository root's file, so
  // init run from a subfolder also writes one there; its hooks point at the root's .lanes/hook.cjs.
  let start = repo.root;
  try {
    start = fs.realpathSync.native(path.resolve(dir));
    if (!fs.statSync(start).isDirectory()) start = repo.root;
  } catch {
    // not an existing folder: the root only
  }
  const rel = path.relative(repo.root, start);
  const inSub = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  const settingsDirs = inSub ? [repo.root, start] : [repo.root];
  const scriptFor = (d: string) => `${"${CLAUDE_PROJECT_DIR}"}/${path.relative(d, repo.root).split(path.sep).join("/") || "."}/.lanes/hook.cjs`.replace("/./", "/");

  fs.mkdirSync(path.join(repo.root, ".lanes"), { recursive: true });
  fs.copyFileSync(path.join(assets, "hook.cjs"), path.join(repo.root, ".lanes", "hook.cjs"));
  fs.copyFileSync(path.join(assets, "server.cjs"), path.join(repo.root, ".lanes", "server.cjs"));
  const files = [".lanes/hook.cjs", ".lanes/server.cjs"];
  const notes: string[] = [];
  for (const d of agents.includes("claude") ? settingsDirs : []) {
    const settingsFile = path.join(d, ".claude", "settings.json");
    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      } catch {
        // Never overwrite a file we can't read: it may hold the user's own hooks and permissions.
        throw new UserError(`${settingsFile} is not valid JSON. Fix it, then run \`lanes init\` again.`);
      }
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(withLanesHooks(settings, "node", scriptFor(d)), null, 2) + "\n");
    files.push(path.relative(repo.root, settingsFile).split(path.sep).join("/"));
    notes.push(...configureLocalRuntime(d, scriptFor(d), options.searchPath));
  }
  if (inSub && agents.includes("claude")) notes.push(`Hooks are also set up for ${rel.split(path.sep).join("/")}: Claude Code only reads .claude/settings.json from the folder it starts in. Other subfolders need \`lanes init\` run in them, or Claude started at the repository root.`);
  if (agents.includes("codex")) {
    // Codex loads <repo>/.codex/hooks.json once the project's .codex/ layer is trusted (https://developers.openai.com/codex/hooks).
    // shortcut: a bare `node` only; no settings.local.json-style fallback when node is not on PATH.
    const hooksFile = path.join(repo.root, ".codex", "hooks.json");
    let hooks: ClaudeSettings = {};
    if (fs.existsSync(hooksFile)) {
      try {
        hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      } catch {
        throw new UserError(`${hooksFile} is not valid JSON. Fix it, then run \`lanes init\` again.`);
      }
    }
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify(withLanesCodexHooks(hooks), null, 2) + "\n");
    files.push(".codex/hooks.json");
    notes.push("Codex runs these hooks only after each user trusts them: run /hooks in Codex and approve the Lanes entries.");
  }
  if (agents.includes("gemini")) {
    // Project hooks live in <repo>/.gemini/settings.json, next to the user's own project settings (https://geminicli.com/docs/hooks/).
    const file = path.join(repo.root, ".gemini", "settings.json");
    const settings = readConfig<ClaudeSettings>(file, "init");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(withLanesGeminiHooks(settings), null, 2) + "\n");
    files.push(".gemini/settings.json");
    notes.push("Gemini CLI warns before running project hooks it has not seen, and skips .gemini/settings.json in a folder it does not trust (when folder trust is on).");
  }
  if (agents.includes("cursor")) {
    const file = path.join(repo.root, ".cursor", "hooks.json");
    const hooks = readConfig<CursorHooks>(file, "init");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(withLanesCursorHooks(hooks), null, 2) + "\n");
    files.push(".cursor/hooks.json");
    notes.push("Cursor: each edit is published right after it is made; Cursor has no hook that can wait before an edit without deciding its permission, so Lanes cannot queue Cursor's edits behind a teammate's. The Claude Code hooks stay inert inside Cursor.");
  }
  for (const more of agents.map((a) => installMore(repo.root, a))) files.push(...more.files), notes.push(...more.notes); // agents.ts
  for (const a of ADAPTERS.filter((x) => agents.includes(x.agent))) {
    files.push(writeAdapter(repo.root, a, "init", a.add)!);
    notes.push(a.note);
  }

  if (options.commit) {
    // Pathspec: never sweep up the user's own uncommitted work.
    git(repo.root, "add", "--", ...files);
    const staged = git(repo.root, "diff", "--cached", "--name-only", "--", ...files);
    try {
      if (staged) git(repo.root, "commit", "-m", "chore: set up Lanes", "--", ...files);
    } catch (err) {
      // One line: git's own text for a missing identity is a paragraph, and CRLF warnings come first (#186).
      const lines = String((err as { stderr?: string }).stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^warning:/i.test(l));
      const reason = /Author identity unknown|empty ident|unable to auto-detect/i.test(lines.join(" "))
        ? "git does not know who you are. Run `git config user.name \"Your Name\"` and `git config user.email you@example.com`"
        : (lines.filter((l) => /^(fatal|error):/i.test(l)).pop() ?? lines.pop() ?? "git refused the commit");
      throw new UserError(`The Lanes files were written but not committed: ${reason}. Then run \`lanes init\` again (safe to repeat), or use --no-commit.`);
    }
  }
  // After the setup commit, so lanes/main starts with the hooks in it.
  return { files, integration: ensureIntegration(repo.root, files), notes };
}

/** `lanes off`: undoes what `init` wrote in the repository, touching nothing of the user's own hooks. Returns what changed. */
export function off(dir: string, options: { commit: boolean }): { root: string; changed: string[] } {
  requireGit();
  const repo = findRepo(dir);
  if (!repo) throw new UserError(`${dir} is not inside a git repository.`);
  const changed: string[] = [];
  const dirs = new Set([repo.root]);
  try {
    dirs.add(fs.realpathSync.native(path.resolve(dir))); // `init` run from a subfolder wrote settings there too
  } catch {
    // not an existing folder: the root only
  }
  // Codex's hooks.json and Gemini's settings.json have the same shape as Claude's settings, so one removal fits all three.
  const configs = [...[...dirs].flatMap((d) => ["settings.json", "settings.local.json"].map((name) => path.join(d, ".claude", name))), path.join(repo.root, ".codex", "hooks.json"), path.join(repo.root, ".gemini", "settings.json")];
  for (const file of configs) {
    if (!fs.existsSync(file)) continue;
    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new UserError(`${file} is not valid JSON. Fix it, then run \`lanes off\` again.`);
    }
    if (!Object.values(settings.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some(isLanesHook)))) continue;
    const rest = withoutLanesHooks(settings);
    if (Object.keys(rest).length > 0) fs.writeFileSync(file, JSON.stringify(rest, null, 2) + "\n");
    else fs.rmSync(file);
    changed.push(path.relative(repo.root, file).split(path.sep).join("/"));
  }
  const cursorFile = path.join(repo.root, ".cursor", "hooks.json");
  const cursor = readConfig<CursorHooks>(cursorFile, "off");
  if (Object.values(cursor.hooks ?? {}).some((list) => list.some(isLanesHook))) {
    const rest = withoutLanesCursorHooks(cursor);
    if (Object.keys(rest).length > 0) fs.writeFileSync(cursorFile, JSON.stringify(rest, null, 2) + "\n");
    else fs.rmSync(cursorFile);
    changed.push(".cursor/hooks.json");
  }
  changed.push(...removeMore(repo.root)); // agents.ts
  for (const a of ADAPTERS) if (fs.existsSync(path.join(repo.root, a.file)) && writeAdapter(repo.root, a, "off", a.remove)) changed.push(a.file);
  for (const f of ["hook.cjs", "server.cjs"]) {
    const file = path.join(repo.root, ".lanes", f);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      changed.push(`.lanes/${f}`);
    }
  }
  for (const name of [".lanes", ".claude", ".codex", ".gemini", ".cursor"]) {
    try {
      fs.rmdirSync(path.join(repo.root, name)); // only when empty
    } catch {
      // missing, or something else lives there: leave it
    }
  }
  const tracked = changed.length > 0 ? git(repo.root, "ls-files", "--", ...changed).split(/\r?\n/).filter(Boolean) : [];
  if (options.commit && tracked.length > 0) {
    git(repo.root, "add", "-A", "--", ...tracked);
    try {
      git(repo.root, "commit", "-m", "chore: remove Lanes", "--", ...tracked);
    } catch {
      throw new UserError("The Lanes files were removed but not committed: git refused the commit (does it know who you are? `git config user.name`). Commit the removal yourself, or run `lanes off` again.");
    }
  }
  return { root: repo.root, changed };
}

export interface Integration {
  mode: "remote" | "local" | "unpushed";
  message: string;
}

/**
 * Makes publishing work out of the box (#102, ADR-0021): with an `origin`, `lanes/main` is fetched from it or created
 * there; without one it is created as a local branch. Never throws: a failure is reported in the message.
 * A new `lanes/main` starts at the remote's default branch plus one setup commit holding only the Lanes files, built
 * without touching the checkout or its index: the checked-out branch's unpushed commits never reach the team (#125,
 * ADR-0023). An empty remote gets a root commit with the setup files alone.
 * shortcut: without a remote the local `lanes/main` starts at the local main/master (else HEAD): nothing is shared.
 */
export function ensureIntegration(root: string, files: string[] = []): Integration {
  const NET = 15_000;
  const run = (args: string[], env: NodeJS.ProcessEnv = {}, timeout?: number) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env: { ...process.env, ...env } }).trim();
  const exists = (ref: string) => {
    try {
      run(["rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  };
  /** `base` plus the setup files, as a commit; no parent when `base` is null. */
  const withSetup = (base: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-index-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, "index") };
      if (base) run(["read-tree", base], env);
      for (const file of files) {
        const blob = run(["hash-object", "-w", "--", file]);
        run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], env);
      }
      const tree = run(["write-tree"], env);
      return run(["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", "chore: set up Lanes"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    run(["remote", "get-url", "origin"]);
  } catch {
    if (!exists("refs/heads/lanes/main")) {
      const base = ["refs/heads/main", "refs/heads/master"].find(exists) ?? "HEAD";
      if (!exists(base)) return { mode: "local", message: "No origin remote and no commit yet: Lanes cannot publish until the repository has a commit." };
      run(["branch", "lanes/main", files.length > 0 ? withSetup(base) : base]);
    }
    return { mode: "local", message: "No origin remote: Lanes works on this machine only (local branch lanes/main). Add an origin and run `lanes init` again to share it with teammates." };
  }
  try {
    if (run(["ls-remote", "--heads", "origin", "refs/heads/lanes/main"], {}, NET) === "") {
      const head = run(["ls-remote", "--symref", "origin", "HEAD"], {}, NET);
      const heads = run(["ls-remote", "--heads", "origin"], {}, NET).split(/\r?\n/).map((l) => l.split("refs/heads/")[1]).filter(Boolean);
      // The default branch; a dangling remote HEAD (empty or renamed) falls back to main, then master.
      const branch = [/^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1], "main", "master"].find((b) => b && heads.includes(b));
      let base: string | null = null;
      if (branch) {
        run(["fetch", "--quiet", "origin", `refs/heads/${branch}`], {}, NET);
        base = run(["rev-parse", "FETCH_HEAD"]);
      }
      // The setup commit init just made, if it sits directly on that branch: lanes/main shares it, so the human's own
      // pushes of it never make Lanes treat their branch as "already pushed" (#132, #111).
      let shared: string | undefined;
      try {
        if (base && run(["log", "-1", "--format=%s", "HEAD"]) === "chore: set up Lanes" && run(["rev-parse", "HEAD^"]) === base) shared = run(["rev-parse", "HEAD"]);
      } catch {
        // no such commit: build one below
      }
      run(["push", "origin", `${shared ?? withSetup(base)}:refs/heads/lanes/main`], {}, NET);
    }
    return { mode: "remote", message: "Publishing to origin lanes/main." };
  } catch (err) {
    const detail = String((err as { stderr?: string }).stderr ?? "").trim().split(/\r?\n/).pop();
    return { mode: "unpushed", message: `Cannot reach or write to origin lanes/main${detail ? ` (${detail})` : ""}. Edits are committed locally only; fix access, then run \`lanes init\` again.` };
  }
}

/** `lanes status`: the server and token the hooks use (env, ~/.lanes/config.json, defaults), unless overridden by flags (#129). */
async function status(server?: string, token?: string): Promise<void> {
  const config = loadConfig();
  const serverUrl = (server ?? config.serverUrl).replace(/\/+$/, "");
  const bearer = token ?? (server ? tokenFor({ ...config, serverUrl, token: undefined }) : tokenFor(config));
  let res: Response;
  try {
    res = await fetch(serverUrl + "/v1/state", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(`${yellow("Lanes is offline")} at ${serverUrl}: coordination is paused, and edits go ahead uncoordinated.`);
    console.log(dim(isLocalServer(serverUrl) ? "Start Claude Code in a repository set up with Lanes (it starts the server by itself), or run `lanes server`." : "Check the address, or ask whoever hosts the server to start it."));
    process.exitCode = 1;
    return;
  }
  if (res.status === 401) {
    throw new UserError(`The Lanes server at ${serverUrl} refused the token. ${isLocalServer(serverUrl) ? "Check ~/.lanes/token." : "If your team uses personal tokens, run `lanes login` or the `lanes join` command your admin sent you; otherwise ask for the team token and run `lanes connect --server <url> --token <token>`."}`);
  }
  if (!res.ok) throw new UserError(`The Lanes server at ${serverUrl} answered with an error (${res.status}). Check the terminal or log where it runs.`);
  const s = (await res.json()) as { agents: { status: string }[]; leases: unknown[]; tasks: { status: string }[] };
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  const active = s.tasks.filter((t) => t.status === "active").length;
  // "N agents" even for 1: packages/hook/test/lan-config.test.ts matches it.
  console.log(`${green("Lanes is running")} at ${serverUrl}: ${s.agents.length} agents (${waiting} waiting), ${s.leases.length} ${s.leases.length === 1 ? "file" : "files"} held, ${active} active ${active === 1 ? "task" : "tasks"}`);
}

/** `lanes doctor`: one line per check, with the next step on a failure. Exit code 1 when any check fails (an "–" line is information, not a failure). */
async function doctor(dir: string, server?: string): Promise<void> {
  let failed = false;
  const ok = (what: string, detail = "") => console.log(`${green("✓")} ${what}${detail ? dim(` ${detail}`) : ""}`);
  const bad = (what: string, next: string) => { failed = true; console.log(`${red("✗")} ${what}\n  ${next}`); };
  const info = (what: string) => console.log(`${dim("–")} ${what}`);
  // One command string with the shell: Node 24 warns (DEP0190) when args go with shell: true. cmd is a fixed program name.
  const version = (cmd: string) => { const r = process.platform === "win32" ? spawnSync(`${cmd} --version`, { encoding: "utf8", shell: true }) : spawnSync(cmd, ["--version"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : undefined; };

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${process.versions.node}`); else bad(`Node ${process.versions.node} is too old`, "Install Node.js 22.18 or newer from https://nodejs.org and restart your terminal.");
  const git = version("git");
  if (git) ok(git); else bad("git is not on your PATH", "Install git (https://git-scm.com) and restart your terminal; Lanes shares edits through git.");

  const repo = git ? findRepo(dir) : null;
  if (!repo) bad(`${dir} is not inside a git repository`, "Run `lanes doctor` inside the repository you work in, or `lanes doctor --dir <repo>`.");
  else {
    ok(`Repository ${repo.label}`, repo.root);
    const hook = fs.existsSync(path.join(repo.root, ".lanes", "hook.cjs"));
    let wired = false;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(repo.root, ".claude", "settings.json"), "utf8")) as ClaudeSettings;
      wired = Object.values(settings.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some(isLanesHook)));
    } catch { /* no settings file, or not JSON: not wired */ }
    if (hook && wired) ok("Lanes is set up here", ".lanes/hook.cjs and .claude/settings.json");
    else bad("Lanes is not set up in this repository", "Run `lanes init` here (VS Code: Lanes: Set Up Repository), then push the commit so teammates get it.");
    if (teamContextOn(repo.root)) ok("Team context is on", "agents get a team brief and heads-ups"); else info("Team context is off: `lanes team on` (VS Code: Lanes: Turn On Team Context) gives agents a team brief. Optional.");
  }

  const config = loadConfig();
  const serverUrl = (server ?? config.serverUrl).replace(/\/+$/, "");
  const bearer = server ? tokenFor({ ...config, serverUrl, token: undefined }) : tokenFor(config);
  let res: Response | undefined;
  try {
    res = await fetch(serverUrl + "/v1/state", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(3000) });
  } catch { /* offline */ }
  if (!res) bad(`No Lanes server answers at ${serverUrl}`, isLocalServer(serverUrl) ? "Normal before the first Claude Code session: it starts the server by itself. Or run `lanes server` (VS Code: Lanes: Start Local Server)." : "Check the address, or ask whoever hosts the server to start it. Edits go ahead uncoordinated meanwhile.");
  else if (res.status === 401) bad(`The server at ${serverUrl} refused your token`, isLocalServer(serverUrl) ? "Check ~/.lanes/token." : "Run `lanes login --server <url>` or the `lanes join` command your admin sent you (VS Code: Lanes: Copy Sign-In Command).");
  else if (!res.ok) bad(`The server at ${serverUrl} answered ${res.status}`, "Check the terminal or log where it runs.");
  else {
    const s = (await res.json()) as { agents: unknown[]; leases: unknown[] };
    ok(`Server ${serverUrl}`, `${s.agents.length} agents, ${s.leases.length} files held`);
    ok(bearer ? "Token accepted" : "No token needed", config.user ? `you are ${config.user}` : "");
  }

  const claude = version("claude");
  if (claude) ok(`Claude Code ${claude.replace(/\s*\(Claude Code\)$/i, "")}`); else info("Claude Code is not on your PATH: Lanes watches it through its hooks (https://claude.com/claude-code). Other agents: `lanes init --agents <names>`.");
  if (failed) { process.exitCode = 1; console.log(dim("\nSomething to fix above. Your edits go ahead whatever state Lanes is in.")); }
  else console.log(green("\nAll good."));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(command === "help" && rest[0] && Object.hasOwn(HELP, rest[0]) ? HELP[rest[0]] : usage());
    return;
  }
  if (!Object.hasOwn(HELP, command)) throw new UsageError(`Unknown command '${command}'. Run \`lanes --help\` for the list.`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP[command]);
    return;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
    args: rest,
    allowPositionals: TEAM_COMMANDS.includes(command),
    options: {
      edit: { type: "boolean" },
      run: { type: "boolean" },
      agent: { type: "string" },
      dir: { type: "string" },
      server: { type: "string" },
      user: { type: "string" },
      token: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "no-commit": { type: "boolean" },
      task: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      "no-gh": { type: "boolean" },
      json: { type: "boolean" },
      file: { type: "string" },
      days: { type: "string" },
      agents: { type: "string" },
      print: { type: "boolean" },
      github: { type: "string" },
    },
  });
  } catch (err) {
    if ((err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) throw new UsageError(`${(err as Error).message.split(". ")[0].replace(/\.$/, "")}. Run \`lanes ${command} --help\`.`);
    throw err;
  }
  const values = parsed.values as { edit?: boolean; run?: boolean; dir?: string; server?: string; user?: string; token?: string; port?: string; host?: string; "no-commit"?: boolean; task?: string; branch?: string; base?: string; "no-gh"?: boolean; json?: boolean; file?: string; days?: string; agents?: string; print?: boolean; github?: string; agent?: string };
  if (values.server !== undefined) checkServerUrl(values.server);
  const port = values.port ?? (command === "server" ? process.env.LANES_PORT : undefined);
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) throw new UsageError(`'${port}' is not a port number. Use a number from 1 to 65535, for example --port 4317.`);
  switch (command) {
    case "init": {
      const dir = startDir(values.dir);
      const agents = values.agents?.split(",").map((a) => a.trim().toLowerCase());
      const unknown = agents?.find((a) => !AGENTS.includes(a));
      if (unknown !== undefined) throw new UsageError(`'${unknown}' is not a supported agent. Use --agents with ${AGENTS.join(", ")} (comma-separated).`);
      const { files, integration, notes } = init(dir, { commit: !values["no-commit"], agents });
      writeUserConfig({ serverUrl: values.server, user: values.user, token: values.token });
      console.log(`Set up Lanes in ${findRepo(dir)!.root}:\n  ${files.join("\n  ")}`);
      console.log(integration.message);
      for (const note of notes) console.log(note);
      if (agents) console.log(`Team tools (MCP), once per machine:\n  ${mcpSetup(agents).join("\n  ")}`);
      const config = loadConfig();
      if (!isLocalServer(config.serverUrl) && !config.token) {
        console.log(`Coordination with ${config.serverUrl} stays off until you have its token: run \`lanes connect --server ${config.serverUrl} --token <token>\` (the server owner's \`lanes server\` prints it).`);
      }
      console.log("Next: push this commit so teammates get it. Start Claude Code here; it starts a local server by itself (teams: `lanes server --host 0.0.0.0` on one machine).");
      return;
    }
    case "off": {
      const { root, changed } = off(startDir(values.dir), { commit: !values["no-commit"] });
      console.log(changed.length > 0 ? `Lanes is off in ${root}. Removed:\n  ${changed.join("\n  ")}\nPush the commit so teammates get it. Claude Code sessions already open keep their hooks until restarted. The lanes/main branch and ~/.lanes are left alone.` : `Lanes was not set up in ${root}: nothing to remove.`);
      return;
    }
    case "connect": {
      if (!values.server || !values.token) throw new UsageError(`lanes connect needs ${[!values.server && "--server <url>", !values.token && "--token <token>"].filter(Boolean).join(" and ")}. Run \`lanes connect --help\`.`);
      writeUserConfig({ serverUrl: values.server, user: values.user, token: values.token });
      console.log(`Hooks and the CLI on this machine now use ${values.server} (saved in ~/.lanes/config.json). VS Code follows unless its lanes.serverUrl setting says otherwise.`);
      return;
    }
    case "server": {
      const env = { ...process.env, LANES_PORT: values.port ?? process.env.LANES_PORT ?? "4317", ...(values.host ? { LANES_HOST: values.host } : {}) };
      const wanted = Number(env.LANES_PORT);
      if (!(await portFree(wanted, values.host ?? "127.0.0.1"))) {
        // The server the hooks start on their own counts as "already running": say so instead of exiting without a word.
        const url = `http://127.0.0.1:${wanted}`;
        const running = await fetch(url + "/v1/state", { headers: { authorization: `Bearer ${loadOrCreateToken()}` }, signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
        if (running) {
          console.log(`A Lanes server is already running at ${url}. Nothing to start; \`lanes status\` shows it.`);
          return;
        }
        throw new UserError(`Port ${wanted} is already in use (by another program, or a Lanes server with a different token). Pick another with \`lanes server --port <n>\`.`);
      }
      console.log(`Token (share only with teammates on your network): ${loadOrCreateToken()}`);
      if (values.host && !["127.0.0.1", "localhost", "::1"].includes(values.host)) {
        const wildcard = values.host === "0.0.0.0" || values.host === "::";
        const addrs = wildcard ? Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address)) : [values.host];
        for (const addr of addrs) console.log(`Teammates: in VS Code run "Lanes: Join Team Server" and enter http://${addr}:${env.LANES_PORT} and the token above (or, with this CLI: lanes connect --server http://${addr}:${env.LANES_PORT} --token <token>).`);
        const name = os.hostname();
        console.log(`Teammates can connect by IP address, ${name} or ${name}.local. Any other name must be listed in LANES_ALLOWED_HOSTS (comma-separated).`);
      }
      spawn(process.execPath, ["--no-warnings", path.join(assetsDir(), "server.cjs")], { stdio: "inherit", env }).on("exit", (code) => process.exit(code ?? 0));
      return;
    }
    case "pr": {
      requireGit();
      const filter: PrFilter = { text: values.task };
      if (values.task && /^[\w-]+$/.test(values.task)) {
        // A task id from the server maps to the title and session the checkpoint trailers carry; without a server it is text.
        try {
          const config = loadConfig();
          const bearer = tokenFor(config);
          const res = await fetch(config.serverUrl.replace(/\/+$/, "") + "/v1/state", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(2000) });
          const task = res.ok ? ((await res.json()) as { tasks: { id: string; title: string; sessionId: string }[] }).tasks.find((t) => t.id === values.task) : undefined;
          if (task) Object.assign(filter, { text: undefined, title: task.title, session: task.sessionId });
        } catch {
          // offline: match on the text
        }
      }
      const r = pr(startDir(values.dir), { filter, branch: values.branch, base: values.base, gh: !values["no-gh"] && ghOnPath() });
      console.log(r.message);
      for (const c of r.commands) console.log(`  ${c}`);
      console.log(`Contributors: ${r.contributors.join(", ")}. The checkpoint commits on lanes/main are untouched.`);
      return;
    }
    case "status":
      return status(values.server, values.token);
    case "doctor":
      return doctor(startDir(values.dir), values.server);
    case "report": {
      if (values.days !== undefined && !(/^\d+$/.test(values.days) && Number(values.days) >= 1 && Number(values.days) <= 365)) throw new UsageError(`'${values.days}' is not a number of days. Use 1 to 365, for example --days 28.`);
      const report = await collectReport({ days: values.days ? Number(values.days) : undefined, server: values.server, token: values.token });
      if (values.file) {
        fs.writeFileSync(path.resolve(values.file), feedbackFile(report) + "\n");
        console.log(`Wrote ${path.resolve(values.file)}. Nothing was sent. Read it, fill in what you like, and email it only if you want to.`);
      } else console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return;
    }
    case "hosted":
      console.log(hostedWaitlist());
      return;
    case "mcp":
      serveMcp(startDir(values.dir));
      return;
    case "app": {
      const config = loadConfig();
      let who: { user: string; repo?: string };
      try {
        who = whoAmI(startDir(values.dir));
      } catch (err) {
        if (!(err instanceof TeamError)) throw err;
        who = { user: config.user ?? os.userInfo().username }; // not in a repository: the page lets you pick one
      }
      // The fragment never reaches the server or its logs; the page moves it to sessionStorage and clears it (ADR-0029).
      const url = `${config.serverUrl}/app#${new URLSearchParams({ token: tokenFor(config) ?? "", user: who.user, ...(who.repo ? { repo: who.repo } : {}) })}`;
      if (values.print) return void console.log(url);
      console.log(`Opening the Lanes app. If no browser opens, paste this link (it holds your token, do not share it):\n${url}`);
      openInBrowser(url);
      return;
    }
    case "login":
      return login((values.server ?? loadConfig().serverUrl).replace(/\/+$/, ""), !values.print);
    case "team": {
      const arg = parsed.positionals[0];
      const dir = startDir(values.dir);
      if (arg === "on" || arg === "off") {
        const file = setTeamContext(dir, arg === "on");
        console.log(`Team context is ${arg} in this repository (${file}). Commit it so teammates get the same setting.`);
      } else if (arg === undefined) {
        const repo = findRepo(dir);
        const on = repo !== null && teamContextOn(repo.root);
        console.log(`Team context is ${on ? "on" : "off"} in this repository. \`lanes team ${on ? "off" : "on"}\` switches it ${on ? "off" : "on"}.`);
      } else throw new UsageError(`'${arg}' is not on or off. Run \`lanes team --help\`.`);
      return;
    }
    case "invite": {
      if (parsed.positionals.length !== 1) throw new UsageError("lanes invite needs one name. Run `lanes invite --help`.");
      const { name, token, github } = await teamPost<{ name: string; token?: string; github?: string }>("/v1/members/invite", { name: parsed.positionals[0], ...(values.github ? { github: values.github } : {}) }, true);
      // Every address of this machine: the teammate uses the one on their network.
      const urls = joinUrls(loadConfig().serverUrl);
      if (github) console.log(`Invited ${name} as GitHub @${github}.\n${urls.map((u) => `Ask ${name} to run: lanes login --server ${u}`).join("\n")}`);
      else console.log(`Send this command to ${name} privately (the token is shown only this once; \`lanes invite ${name}\` again replaces it):\n${urls.map((u) => `  lanes join ${u} ${token} --user "${name}"`).join("\n")}`);
      return;
    }
    case "join": {
      const [url, token] = parsed.positionals;
      if (parsed.positionals.length !== 2) throw new UsageError("lanes join needs <url> <token>, as printed by `lanes invite`.");
      writeUserConfig({ serverUrl: checkServerUrl(url), token, user: values.user });
      let res: Response;
      try {
        res = await fetch(url.replace(/\/+$/, "") + "/v1/members/whoami", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}", signal: AbortSignal.timeout(3000) });
      } catch {
        console.log(`Saved in ~/.lanes/config.json, but ${url} does not answer yet. Coordination starts once it does.`);
        return;
      }
      if (res.status === 401) throw new UserError(`Saved in ~/.lanes/config.json, but ${url} refused the token. Ask for a new one (\`lanes invite <name>\` on the server's machine).`);
      // 403: a shared token, which has no name; 404: an older server. Either way the name stays self-declared (--user).
      if (res.status === 403 || res.status === 404) return void console.log(`Joined ${url}${values.user ? ` as ${values.user}` : ""} with a shared token: names on this server are self-declared.`);
      if (!res.ok) throw new UserError(`Saved in ~/.lanes/config.json, but the server answered ${res.status}.`);
      const { name } = (await res.json()) as { name?: unknown };
      if (typeof name !== "string") throw new UserError("Saved in ~/.lanes/config.json, but the server sent no name for the token.");
      // The server's name for the token wins over --user: it is the name every request is made under anyway (ADR-0030).
      writeUserConfig({ user: name });
      console.log(`Joined ${url} as ${name}${values.user && values.user !== name ? ` (the server's name for this token; --user ${values.user} was ignored)` : ""}. Hooks, the CLI and VS Code on this machine now use your personal token.`);
      return;
    }
    case "remove": {
      if (parsed.positionals.length !== 1) throw new UsageError("lanes remove needs one name. Run `lanes members` to see them.");
      const { removed } = await teamPost<{ removed: boolean }>("/v1/members/remove", { name: parsed.positionals[0] }, true);
      console.log(removed ? `Removed ${parsed.positionals[0]}: their token stopped working.` : `${parsed.positionals[0]} is not a member. Run \`lanes members\` to see them.`);
      return;
    }
    case "members": {
      const { members } = await teamPost<{ members: { name: string; createdAt: number; github?: string }[] }>("/v1/members/list", {}, true);
      if (members.length === 0) return void console.log("No teammates have a personal token yet, so names are self-declared. `lanes invite <name>` gives one.");
      const width = Math.max(...members.map((m) => m.name.length));
      console.log(bold(`${members.length} ${members.length === 1 ? "teammate has" : "teammates have"} a personal token`));
      for (const m of members) console.log(`  ${m.name.padEnd(width)}  invited ${new Date(m.createdAt).toISOString().slice(0, 10)}${m.github ? `  GitHub @${m.github}` : ""}`);
      return;
    }
    case "say":
    case "ask":
    case "requests":
    case "approve":
    case "deny": {
      const who = whoAmI(startDir(values.dir));
      const args = parsed.positionals;
      if (command === "say") {
        if (args.length === 0) throw new UsageError("lanes say needs a message. Run `lanes say --help`.");
        const msg = await teamPost<{ mentions: string[] }>("/v1/team/say", { ...who, text: args.join(" ") });
        console.log(`Sent to the team chat.${msg.mentions.length > 0 ? ` ${msg.mentions.map((m) => "@" + m).join(", ")} ${msg.mentions.length === 1 ? "sees" : "see"} it with their agent's next prompt.` : dim(" Mention @name or @team to reach someone's agent.")}`);
      } else if (command === "ask") {
        if (args.length < 2) throw new UsageError("lanes ask needs a teammate and a request. Run `lanes ask --help`.");
        const r = await teamPost<AgentRequest>("/v1/team/ask", { ...who, to: args[0], text: args.slice(1).join(" "), scope: values.edit ? "edit" : "read" });
        console.log(`Request ${r.id} sent to ${r.to} (${r.scope === "edit" ? "may edit files" : "read only"}). It reaches their agent only after ${r.to} approves it.`);
        console.log(dim("`lanes requests` shows its status and the reply."));
      } else if (command === "requests") {
        const { requests } = await teamPost<{ requests: AgentRequest[] }>("/v1/team/requests", who);
        if (requests.length === 0) return void console.log("No open requests in this repository. `lanes ask <teammate> \"<request>\"` sends one.");
        const waiting = requests.filter((r) => r.status === "pending" && r.to.toLowerCase() === who.user.toLowerCase()).length;
        console.log(bold(`${requests.length} open ${requests.length === 1 ? "request" : "requests"}${waiting ? `, ${waiting} waiting for you` : ""}`));
        for (const line of requestLines(requests, who.user, Date.now(), (col, cell) => (col === 1 ? (STATUS_COLOR[cell.trim()] ?? ((s: string) => s))(cell) : col === 0 ? dim(cell) : cell))) console.log(line);
        if (waiting) console.log(dim("Approve with `lanes approve <id>`, or decline with `lanes deny <id>`."));
      } else {
        if (args.length !== 1) throw new UsageError(`lanes ${command} needs one request id. Run \`lanes requests\` to see them.`);
        const run = command === "approve" && values.run === true;
        if (values.agent !== undefined && values.agent !== "claude" && values.agent !== "codex") throw new UsageError("--agent is claude or codex.");
        // Chosen before approving, so a missing agent doesn't leave the request approved with nobody to run it.
        const agent = run ? (values.agent as "claude" | "codex" | undefined) ?? defaultAgent() : undefined;
        const r = await teamPost<AgentRequest>("/v1/team/decide", { ...who, id: args[0], decision: command === "approve" ? "approve" : "deny", headless: run });
        if (!run) console.log(r.status === "approved" ? `Approved. Your agent gets it with your next prompt: ${r.text}` : `Declined. ${r.from} sees it in their sent requests.`);
        else {
          console.log(`Approved. Running it with ${agent === "codex" ? "Codex" : "Claude Code"} (${r.scope === "edit" ? "in a separate worktree" : "read only"}): ${r.text}`);
          let done: ReturnType<typeof runRequest>;
          try {
            done = runRequest(startDir(values.dir), r, agent);
          } catch (err) {
            // The asker hears it too, instead of waiting on a request that looks handled.
            await teamPost("/v1/team/reply", { ...who, id: r.id, text: `Approved, but the run on ${who.user}'s machine failed: ${(err as Error).message}` }).catch(() => {});
            throw err;
          }
          const reply = done.branch ? `${done.output}\n\n(Changes are on branch ${done.branch} in ${who.user}'s repository, for review.)` : done.output;
          await teamPost("/v1/team/reply", { ...who, id: r.id, text: reply || "(no output)" });
          console.log(`${done.output}\n\nSent the answer back to ${r.from}.${done.branch ? ` The changes are on branch ${done.branch} (worktree ${done.worktree}); review and merge them yourself.` : ""}`);
        }
      }
      return;
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof UserError || err instanceof PrError || err instanceof TeamError ? err.message : `lanes: ${describeFsError(err) ?? (err instanceof Error ? err.message : String(err))}`);
    // Not process.exit() straight away: on Windows it aborts the process (0xC0000409, libuv's "!(handle->flags & UV_HANDLE_CLOSING)"
    // in src\win\async.c) while fetch's sockets are still closing. Exit naturally, as on success; force it only if something hangs.
    process.exitCode = err instanceof UsageError ? 2 : 1;
    setTimeout(() => process.exit(), 2_000).unref();
  });
}
