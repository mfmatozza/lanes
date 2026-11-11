// `lanes mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0, no dependency) that gives any MCP-capable agent
// (Codex, Cursor, Gemini CLI, Claude Code…) the multiplayer team tools (ADR-0028). An agent can read what a person sees in
// the Team view, but there is deliberately no tool to approve or decline a request: approval stays with the person.
import * as readline from "node:readline";
import { findRepo, teamContextOn } from "@lanes/core/repo.ts";
import type { AgentRequest, Snapshot } from "@lanes/core/types.ts";
import { appView } from "@lanes/server/app-view.ts";
import { requestLines, TeamError, teamGet, teamPost, whoAmI } from "./team.ts";

// The extension's version, set by scripts/build.mjs; "dev" when run from source.
declare const __LANES_VERSION__: string | undefined;
const VERSION = typeof __LANES_VERSION__ === "string" ? __LANES_VERSION__ : "dev";

// Agent-facing wording stays factual and never asks the agent to stop or to check with its user (ADR-0028).
const TOOLS = [
  // For agents without Lanes hooks, these two are all the team context they get: the descriptions say when to call them.
  { name: "team_brief", description: "Call at the start of each task: what teammates' agents in this repository are working on, plus new team chat messages and approved requests for your user. Information only.", inputSchema: { type: "object", properties: {} } },
  {
    name: "team_check_file",
    description: "Call before editing a file teammates may also be working on: whether a teammate's agent is changing it (or the given lines) right now. Information only: your edit is never blocked, and nothing needs your user's confirmation.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Repository-relative path, for example src/auth.ts" }, startLine: { type: "integer", description: "Optional: first line you will change" }, endLine: { type: "integer", description: "Optional: last line you will change" } }, required: ["path"] },
  },
  { name: "team_say", description: "Post a short message to the team chat. @name or @team reaches that person's agent with their next prompt.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The message" } }, required: ["text"] } },
  { name: "team_ask", description: "Send a request to a teammate's agent. It reaches their agent only after that teammate approves it.", inputSchema: { type: "object", properties: { to: { type: "string", description: "The teammate's name" }, text: { type: "string", description: "What their agent should do" }, scope: { type: "string", enum: ["read", "edit"], description: "read (default): their agent may only look; edit: it may change files" } }, required: ["to", "text"] } },
  { name: "team_requests", description: "Open requests sent to and by your user in this repository, with their status.", inputSchema: { type: "object", properties: {} } },
  { name: "team_status", description: "Who is working on what in this repository now: each teammate's agents, their status, files and tasks, and whether team context is on. Information only.", inputSchema: { type: "object", properties: {} } },
  { name: "team_members", description: "The teammates the Lanes server knows, and whether each has a personal token. Information only.", inputSchema: { type: "object", properties: {} } },
];

/** MCP `instructions`, which some clients add to the model's context. */
const INSTRUCTIONS =
  "Lanes shares context between the coding agents of one team. Call team_brief when you start a task and team_check_file before editing a file. team_status and team_members show the team as your user sees it. All of these are information only. Edits are never blocked and none of this needs your user's confirmation.";

export async function callTool(name: string, args: Record<string, unknown>, dir: string): Promise<string> {
  const who = whoAmI(dir);
  const mcpWho = { ...who, sessionId: `mcp-${who.user}` };
  switch (name) {
    case "team_brief": {
      const brief = await teamPost<{ text: string; deliver?: string[] }>("/v1/team/context", mcpWho);
      // The tool result goes straight back to the agent, so its approved requests count as delivered now.
      if (brief.deliver?.length) await teamPost("/v1/team/ack", { ...mcpWho, ids: brief.deliver }).catch(() => {});
      return brief.text || "Nothing new from the team.";
    }
    case "team_check_file":
    case "team_heads_up": { // the old name, for agents configured before it was renamed
      const [start, end] = [Number(args.startLine), Number(args.endLine ?? args.startLine)];
      const range = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start ? [start, end] : undefined;
      return (await teamPost<{ text: string }>("/v1/team/context", { ...mcpWho, path: String(args.path ?? ""), range })).text || "No teammate is changing this file.";
    }
    case "team_say":
      await teamPost("/v1/team/say", { ...who, text: args.text });
      return "Sent to the team chat.";
    case "team_ask": {
      const r = await teamPost<AgentRequest>("/v1/team/ask", { ...who, to: args.to, text: args.text, scope: args.scope === "edit" ? "edit" : "read" });
      return `Request ${r.id} sent to ${r.to}. It reaches their agent only after they approve it.`;
    }
    case "team_requests": {
      const { requests } = await teamPost<{ requests: AgentRequest[] }>("/v1/team/requests", who);
      return requests.length > 0 ? requestLines(requests, who.user).join("\n") : "No open requests.";
    }
    case "team_status":
      return statusText(await teamGet<Snapshot>("/v1/state"), who.user, who.repo, teamContextOn(findRepo(dir)!.root));
    case "team_members": {
      // The state first, so a server that is down is the error. Members are listed only on the server's machine (403 elsewhere).
      const state = await teamGet<Snapshot>("/v1/state");
      const members = await teamPost<{ members: Member[] }>("/v1/members/list", {}, true).then((r) => r.members, (err) => (err instanceof TeamError ? undefined : Promise.reject(err)));
      return membersText(state, members);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

type Member = { name: string; github?: string };

/** The Team view as text: the browser app's own appView for this repository, one line per agent. */
export function statusText(snapshot: Snapshot, me: string, repo: string, context: boolean): string {
  const lines = [`Team context is ${context ? "on" : "off"} in this repository.`];
  const { people } = appView(snapshot, me, repo);
  if (people.length === 0) lines.push("No agents in this repository right now.");
  for (const p of people) {
    lines.push(`${p.user}${p.mine ? " (your user)" : ""}:`);
    for (const a of p.agents) {
      const state = a.waitingFor ? `waiting on ${a.waitingFor.path}${a.waitingFor.holder ? ` (held by ${a.waitingFor.holder}'s agent)` : ""}` : a.status;
      const files = a.files.length > 0 ? `; files: ${a.files.slice(0, 8).join(", ")}${a.files.length > 8 ? ` and ${a.files.length - 8} more` : ""}` : "";
      lines.push(`  ${a.label}: ${state}${a.task ? `; task "${a.task}"` : ""}${files}`);
    }
  }
  return lines.join("\n");
}

/** Everyone the server has seen (agents, tasks, chat) plus its members. `members` undefined: not readable from this machine. */
export function membersText(snapshot: Snapshot, members: Member[] | undefined): string {
  const byName = new Map((members ?? []).map((m) => [m.name.toLowerCase(), m]));
  const names = new Map<string, string>();
  for (const n of [...byName.values()].map((m) => m.name).concat([...snapshot.agents, ...snapshot.tasks, ...(snapshot.team?.chat ?? [])].map((x) => x.user))) {
    if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
  }
  const lines = names.size === 0 ? ["The server knows no teammates yet."] : [...names.values()].sort((a, b) => a.localeCompare(b)).map((n) => {
    if (!members) return n;
    const m = byName.get(n.toLowerCase());
    return m ? `${n}: personal token${m.github ? ` (GitHub @${m.github})` : ""}` : `${n}: no personal token (name is self-declared)`;
  });
  if (!members) lines.push("Whether each has a personal token can only be read on the server's machine.");
  return lines.join("\n");
}

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

export async function handle(msg: Message, dir: string): Promise<object | undefined> {
  if (msg.id === undefined) return undefined; // notifications need no answer
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lanes", version: VERSION }, instructions: INSTRUCTIONS });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const text = await callTool(name, (msg.params?.arguments as Record<string, unknown>) ?? {}, dir);
        return reply({ content: [{ type: "text", text }] });
      } catch (err) {
        // Tool failures are results, so the agent reads them and carries on (fail open).
        return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

export function serveMcp(dir: string): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Message;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    handle(msg, dir).then((out) => out && process.stdout.write(JSON.stringify(out) + "\n"));
  });
}
