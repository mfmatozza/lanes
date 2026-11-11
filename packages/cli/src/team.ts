// Multiplayer commands (ADR-0028): `lanes say | ask | requests | approve | deny | team`. Thin calls to the server's
// /v1/team routes, as the person at this terminal; their agents see the result through the hook and `lanes mcp`.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLocalServer, loadConfig, loadOrCreateToken, tokenFor } from "@lanes/core/local.ts";
import { findRepo } from "@lanes/core/repo.ts";
import type { AgentRequest } from "@lanes/core/types.ts";

export class TeamError extends Error {}

/** The same identity the hook sends: config user, else git user.name, else the OS account. */
export function whoAmI(dir: string): { user: string; sessionId: string; repo: string; label: string } {
  const repo = findRepo(dir);
  if (!repo) throw new TeamError(`${dir} is not in a git repository. Run this inside your project, or pass --dir <repo>.`);
  const config = loadConfig();
  let gitName: string | undefined;
  try {
    gitName = execFileSync("git", ["-C", repo.root, "config", "user.name"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    // no git name: the OS account below
  }
  const user = config.user ?? gitName ?? os.userInfo().username;
  return { user, sessionId: `cli-${user}`, repo: repo.id, label: repo.label };
}

/** `admin`: the server's own token when the server is on this machine, even if this person joined with a personal one (members routes). */
export async function teamPost<T>(route: string, body: Record<string, unknown>, admin = false): Promise<T> {
  return teamFetch<T>(route, body, admin);
}

/** GET a server route (`/v1/state`) with the same token and errors as teamPost. */
export const teamGet = <T>(route: string): Promise<T> => teamFetch<T>(route);

async function teamFetch<T>(route: string, body?: Record<string, unknown>, admin = false): Promise<T> {
  const config = loadConfig();
  const bearer = admin && isLocalServer(config.serverUrl) ? loadOrCreateToken() : tokenFor(config);
  let res: Response;
  try {
    res = await fetch(config.serverUrl.replace(/\/+$/, "") + route, {
      method: body ? "POST" : "GET",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new TeamError(`Can't reach the Lanes server at ${config.serverUrl}, so nothing was sent. ${isLocalServer(config.serverUrl) ? "Start Claude Code in a repository set up with Lanes (it starts the server by itself) or run `lanes server`" : "Check that it is running, or ask whoever hosts it"}, then try again.`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new TeamError(data.error ? sentence(data.error) : `The Lanes server answered ${res.status}.`);
  return data;
}

/** A server message ends with a full stop. Not capitalised: it may start with a name ("bea isn't on this team"). */
export const sentence = (text: string): string => text + (/[.!?]$/.test(text) ? "" : ".");

/** A request's status in the words of the browser app and the VS Code Team view. */
export const REQUEST_STATUS: Record<AgentRequest["status"], string> = { pending: "Waiting", approved: "Approved", delivered: "Delivered", denied: "Declined", expired: "Expired" };

/**
 * Requests as aligned columns (id, status, from or to, scope, time left), the text last, and a reply on its own indented line.
 * `style` may colour a cell after it is padded, so escape codes never shift the columns.
 */
export function requestLines(requests: AgentRequest[], me: string, now = Date.now(), style: (column: number, cell: string, r: AgentRequest) => string = (_, cell) => cell): string[] {
  const rows = requests.map((r) => [
    r.id,
    REQUEST_STATUS[r.status] ?? r.status,
    r.to.toLowerCase() === me.toLowerCase() ? `from ${r.from}` : `to ${r.to}`,
    r.scope === "edit" ? "May edit files" : "Read only",
    r.status === "pending" ? `~${Math.max(1, Math.ceil((r.expiresAt - now) / 60_000))} min left` : "",
  ]);
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]!.length))) ?? [];
  return requests.flatMap((r, n) => {
    const cells = rows[n]!.map((cell, i) => (widths[i] ? style(i, cell.padEnd(widths[i]!), r) : "")).filter(Boolean);
    const line = [...cells, r.text].join("  ");
    return r.reply ? [line, `    ${r.to}'s agent replied: ${r.reply}`] : [line];
  });
}

/**
 * `lanes approve <id> --run`: runs an approved request headlessly with this person's own agent and login (multiplayer slice 5).
 * Read scope: Claude Code in plan mode or Codex in its read-only sandbox, so it cannot edit. Edit scope: a separate git
 * worktree on its own branch, so nothing lands in the person's checkout unreviewed. The request text goes in on stdin,
 * never on a command line (no shell injection). LANES_REQUEST_AGENT (a JSON array: program and arguments) replaces the
 * agent's program for tests; the agent's own arguments still follow it, so a stand-in sees exactly what the agent would.
 */
export function runRequest(dir: string, r: AgentRequest, agent: "claude" | "codex" = defaultAgent()): { output: string; branch?: string; worktree?: string } {
  const repo = findRepo(dir);
  if (!repo) throw new TeamError(`${dir} is not in a git repository.`);
  // The id comes from the server and goes into a path and a branch name.
  if (!/^[0-9a-f]{8}$/.test(r.id)) throw new TeamError("The server returned an invalid request id.");
  let cwd = repo.root;
  let branch: string | undefined;
  if (r.scope === "edit") {
    branch = `lanes/request-${r.id}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `lanes-request-${r.id}-`));
    fs.rmdirSync(cwd); // git creates it
    execFileSync("git", ["-C", repo.root, "worktree", "add", "-q", "-b", branch, cwd, "HEAD"], { stdio: "pipe" });
  }
  const custom = process.env.LANES_REQUEST_AGENT ? (JSON.parse(process.env.LANES_REQUEST_AGENT) as string[]) : undefined;
  const [program, ...args] = agentCommand(agent, r.scope);
  const cmd = custom ? custom[0] : program;
  if (custom) args.unshift(...custom.slice(1));
  const prompt = `Your user approved this request from their teammate ${r.from}${r.scope === "read" ? " (read only: do not edit files)" : ""}:\n\n${r.text}`;
  // claude and codex can be .cmd shims on Windows, which need a shell; the arguments are fixed, the request text only goes to stdin.
  // LANES_OFF: the repository's own Lanes hooks would publish these edits to the shared branch before anyone reviewed them.
  const opts = { cwd, input: prompt, encoding: "utf8" as const, timeout: 15 * 60_000, maxBuffer: 10_000_000, env: { ...process.env, LANES_OFF: "1" } };
  // One command string with the shell (Node 24 warns, DEP0190, on args with shell: true); the arguments are fixed flags.
  const res = process.platform === "win32" && !custom ? spawnSync([cmd, ...args].join(" "), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  if (res.error || res.status !== 0) {
    throw new TeamError(`The agent did not finish (${res.error?.message ?? `exit ${res.status}`}). ${String(res.stderr ?? "").trim().split(/\r?\n/).pop() ?? ""}`.trim());
  }
  if (branch) {
    // The edits as one commit on the request branch, so the receiver reviews a branch, not a loose worktree.
    try {
      execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
      execFileSync("git", ["-C", cwd, "commit", "-q", "-m", `Request from ${r.from}: ${r.text.slice(0, 60)}`], { stdio: "pipe" });
    } catch {
      // nothing changed, or no git identity: the changes stay uncommitted in the worktree
    }
  }
  return { output: res.stdout.trim(), branch, worktree: branch ? cwd : undefined };
}

/**
 * The headless command for an approved request; the prompt goes on stdin. Codex (https://learn.chatgpt.com/docs/non-interactive-mode
 * and /docs/developer-commands?surface=cli, formerly developers.openai.com/codex): `codex exec -` reads the prompt from stdin,
 * prints only the final message on stdout, and `--sandbox read-only|workspace-write` bounds what it may change.
 */
export function agentCommand(agent: "claude" | "codex", scope: "read" | "edit"): string[] {
  if (agent === "codex") return ["codex", "exec", "--sandbox", scope === "edit" ? "workspace-write" : "read-only", "-"];
  return ["claude", "-p", "--permission-mode", scope === "edit" ? "acceptEdits" : "plan"];
}

const onPath = (program: string) =>
  (process.platform === "win32" ? spawnSync("where", [program], { stdio: "ignore" }) : spawnSync("sh", ["-c", 'command -v "$1"', "sh", program], { stdio: "ignore" })).status === 0;

/** `--agent` left out: Claude Code if it is installed, else Codex. */
export function defaultAgent(): "claude" | "codex" {
  if (process.env.LANES_REQUEST_AGENT || onPath("claude")) return "claude";
  if (onPath("codex")) return "codex";
  throw new TeamError("Neither claude (Claude Code) nor codex (Codex CLI) is on your PATH, so nothing was approved. Install one and sign in, or approve without --run so your agent gets it with your next prompt.");
}

/** `lanes team on|off`: the committed per-repository switch the hook reads (.lanes/team.json). */
export function setTeamContext(dir: string, on: boolean): string {
  const repo = findRepo(dir);
  if (!repo) throw new TeamError(`${dir} is not in a git repository.`);
  const file = path.join(repo.root, ".lanes", "team.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ context: on }, null, 2) + "\n");
  return file;
}
