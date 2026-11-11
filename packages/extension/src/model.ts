// Pure view logic: turns a server snapshot into what the views show. No VS Code imports, so it is unit-tested.
import type { Agent, AgentRequest, ChatMessage, HookEvent, Lease, Snapshot, Task } from "@lanes/core/types.ts";

export interface UserGroup {
  user: string;
  mine: boolean;
  agents: AgentRow[];
}

export interface AgentRow {
  agent: Agent;
  leases: Lease[];
  task?: Task;
  /** Set when this agent's edits wait to be merged. */
  merge?: MergeItem;
}

export function summarize(snapshot: Snapshot): { agents: number; waiting: number } {
  return { agents: snapshot.agents.length, waiting: snapshot.agents.filter((a) => a.status === "waiting" || a.status === "blocked").length };
}

export function statusBarText(snapshot: Snapshot | null, conn: Connection = "offline"): string {
  if (!snapshot) return conn === "loading" ? "Lanes: connecting…" : conn === "refused" ? "Lanes: token refused" : conn === "error" ? "Lanes: server error" : "Lanes: offline";
  const { agents, waiting } = summarize(snapshot);
  const base = `Lanes: ${agents} ${agents === 1 ? "agent" : "agents"}`;
  return waiting ? `${base}, ${waiting} waiting` : base;
}

/** What the status bar shows: icon and text, and a background only when someone must look (waiting agents, needs merge, a refused token). */
export function statusBar(snapshot: Snapshot | null, conn: Connection, flagged = 0, merges = 0, inbox = 0): { text: string; background?: string } {
  if (!snapshot) {
    const icon = conn === "loading" ? "sync~spin" : conn === "offline" ? "debug-disconnect" : "warning";
    return { text: `$(${icon}) ${statusBarText(null, conn)}`, background: conn === "refused" || conn === "error" ? "statusBarItem.warningBackground" : undefined };
  }
  const { waiting } = summarize(snapshot);
  const text = `$(${waiting ? "watch" : "pulse"}) ${statusBarText(snapshot, conn)}${flagged ? ` $(warning) ${flagged}` : ""}${inbox ? ` $(inbox) ${inbox}` : ""}`;
  return { text, background: merges ? "statusBarItem.errorBackground" : waiting ? "statusBarItem.warningBackground" : undefined };
}

/** Text from the server, safe inside a MarkdownString (a name cannot become a link or a heading). */
export const md = (s: string): string => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
/** A file name as inline code. */
export const mdCode = (s: string): string => "`" + s.replace(/`/g, "'") + "`";

/** The rich status bar hover: who is doing what, who waits, held files and what needs a person, with links into the views. */
export function statusTooltip(snapshot: Snapshot | null, conn: Connection, extra: { me: string; now: number; merges: MergeItem[]; problems: Problem[]; orphans: Lease[]; overlaps: number; inbox?: number }): string {
  if (!snapshot) {
    const links = conn === "refused" ? "[Open token setting](command:workbench.action.openSettings?%22lanes.token%22)" : conn === "error" ? "[Show log](command:lanes.showLog)" : "[Start local server](command:lanes.startServer)";
    return `${md(offlineTooltip(conn))}\n\n${conn === "loading" ? "" : `${links} · `}[Reconnect](command:lanes.reconnect)`;
  }
  const who = (u: string) => (u === extra.me ? "**Your** agent" : `**${md(u)}**'s agent`);
  const lines = snapshot.agents.map((a) =>
    a.status === "waiting" || a.status === "blocked" ? `- $(watch) ${who(a.user)} waits for ${a.blockedOn ? mdCode(a.blockedOn) : "a file"}`
    : a.status === "working" ? `- $(pulse) ${who(a.user)} is editing ${a.lastPath ? mdCode(a.lastPath) : "files"}`
    : `- $(circle-outline) ${who(a.user)} is idle`);
  const held = snapshot.leases.length;
  return [
    snapshot.agents.length ? `**Lanes** is coordinating ${snapshot.agents.length} ${snapshot.agents.length === 1 ? "agent" : "agents"}` : "**Lanes** is running. No agents yet: start Claude Code in a repository set up with Lanes.",
    extra.inbox ? `$(inbox) ${extra.inbox} ${extra.inbox === 1 ? "request is" : "requests are"} waiting for you: [open the Team view](command:lanes.team.focus)` : "",
    lines.join("\n"),
    held ? `$(lock) ${held} ${held === 1 ? "file is" : "files are"} held right now. Other agents wait for them; people are never blocked.` : "",
    ...extra.merges.map((m) => `$(git-merge) **${md(m.user)}**: ${md(m.title)}. Needs merge, nothing is lost.`),
    ...extra.problems.slice(0, 5).map((p) => `$(warning) ${md(p.title)}${p.event.user ? ` (${md(p.event.user)})` : ""}`),
    extra.orphans.length ? `$(lock) ${extra.orphans.length} ${extra.orphans.length === 1 ? "file is" : "files are"} held by no agent` : "",
    md(uncoordinatedLine(snapshot)),
    extra.overlaps ? `$(git-compare) ${extra.overlaps} ${extra.overlaps === 1 ? "task overlaps" : "tasks overlap"} another: see the Tasks view` : "",
    "[Open the Agents view](command:lanes.agents.focus) · [Tasks](command:lanes.tasks.focus) · [Reconnect](command:lanes.reconnect)",
  ].filter(Boolean).join("\n\n");
}

/**
 * You are always blue (like your Explorer badges); teammates get a stable colour from their name. Red, green and yellow
 * are left out: they mean a problem, working and waiting.
 */
const PERSON_COLORS = ["charts.purple", "charts.orange", "terminal.ansiMagenta", "terminal.ansiCyan"];
export function personColor(user: string, mine = false): string {
  if (mine) return "charts.blue";
  // FNV-1a: a multiply-by-31 hash barely varies modulo 4, so most names got the same colour.
  let h = 0x811c9dc5;
  for (const c of user.trim().toLowerCase()) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

/** An agent row's codicon and theme colour: red needs merge, amber waits for a file, green works, muted is idle. */
export function agentIcon(row: AgentRow): [icon: string, color: string] {
  if (row.merge) return ["git-merge", "charts.red"];
  const s = row.agent.status;
  if (s === "waiting" || s === "blocked") return ["watch", "charts.yellow"];
  return s === "working" ? ["pulse", "charts.green"] : ["circle-outline", "disabledForeground"];
}

/** The Explorer decoration of a held file: the holder's initials, a colour contributed in package.json, and what it means. */
export function heldDecoration(lease: Lease | undefined, me: string): { badge: string; tooltip: string; color: string } | undefined {
  if (!lease) return undefined;
  const mine = lease.user === me;
  return {
    badge: initials(lease.user),
    tooltip: mine ? "Held by your agent: teammates' agents wait for it" : `Held by ${lease.user}'s agent — your agent will wait for it`,
    color: mine ? "lanes.heldByYou" : "lanes.heldByTeammate",
  };
}

/** Keys whose value differs between two maps: the only files whose Explorer decoration needs refreshing. */
export function changedKeys(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  return [...new Set([...prev.keys(), ...next.keys()])].filter((k) => prev.get(k) !== next.get(k));
}

/** The status bar tooltip line for edits that went ahead without coordination this week; empty when there were none. */
export function uncoordinatedLine(snapshot: Snapshot | null): string {
  const n = Object.values(snapshot?.uncoordinated ?? {}).reduce((sum, c) => sum + c, 0);
  return n > 0 ? `${n} ${n === 1 ? "edit" : "edits"} went ahead uncoordinated this week (the server was unreachable)` : "";
}

/** What each flagged hook observation means, in the words of the views. */
const PROBLEMS: Record<string, string> = {
  "sync-failed": "Could not bring in teammates' changes",
  "publish-blocked": "Edits kept local: they depend on unshared commits",
  "publish-add-failed": "Files could not be staged",
  "publish-conflict": "Edits kept local: a git operation or conflict is in the way",
  "publish-no-integration-branch": "No shared branch to publish to",
  "publish-retries-exhausted": "Publishing gave up (busy or out of time)",
  "publish-commit-failed": "Commit failed",
  "publish-commit-pending": "A commit is still running",
  "wait-overrun": "Waited too long for a file",
};
export const PROBLEM_WINDOW_MS = 30 * 60_000;

/** Observations after which an agent's edits are committed on its own branch but not shared: the "needs merge" state. Nothing is lost. */
const MERGE_KINDS = new Set(["publish-blocked", "publish-conflict", "publish-retries-exhausted"]);
export const MERGE_WINDOW_MS = 6 * 3600_000;

export interface MergeItem {
  /** user + repository + kind: what "Mark as merged" remembers. */
  key: string;
  user: string;
  sessionId?: string;
  repo: string;
  title: string;
  /** Files the hook named; empty when it only knows that publishing failed (then the files are found with git). */
  paths: string[];
  at: number;
}

/**
 * Edits that wait to be merged, newest first, one per user, repository and kind. `dismissed` maps an item's key to the time it was
 * marked as merged; the item returns only if something newer happened. shortcut: forgotten after 6 hours and on restart; nothing reports "merged".
 */
export function needsMerge(snapshot: Snapshot | null, now: number, dismissed: ReadonlyMap<string, number> = new Map()): MergeItem[] {
  const items = new Map<string, MergeItem>();
  for (const event of snapshot?.events ?? []) {
    if (!MERGE_KINDS.has(event.kind) || now - event.at > MERGE_WINDOW_MS) continue;
    const key = [event.user ?? "", event.repo ?? "", event.kind].join("\u0000");
    const old = items.get(key);
    const paths = [...new Set([...(old?.paths ?? []), ...(event.paths ?? []), ...(event.path ? [event.path] : [])])];
    items.set(key, { key, user: event.user ?? "someone", sessionId: event.sessionId, repo: event.repo ?? "", title: PROBLEMS[event.kind]!, paths, at: Math.max(old?.at ?? 0, event.at) });
  }
  return [...items.values()].filter((i) => i.at > (dismissed.get(i.key) ?? -1)).sort((a, b) => b.at - a.at);
}

/** A path from the server is only ever opened inside a checkout: relative, no `..`, no drive or root. */
export function safeRelPath(p: string): boolean {
  return p !== "" && !/^([a-zA-Z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
}

export type Connection = "loading" | "online" | "offline" | "refused" | "error";

/** What a failed request means to the user: a refused token is fixed in settings; anything else the server answered is an error. */
export function connectionFor(status: number | undefined): Connection {
  return status === undefined ? "offline" : status === 401 || status === 403 ? "refused" : "error";
}

/** The status bar hover when there is no data. Edits always go ahead (ADR-0019), and coordination being off is never silent (M6). */
export function offlineTooltip(conn: Connection): string {
  if (conn === "loading") return "Lanes is connecting to its server…";
  if (conn === "refused") return "Coordination paused: the Lanes server refused your token. Edits still go ahead, uncoordinated. If your team uses personal tokens, run lanes login or lanes join in a terminal. Click to open the token setting.";
  if (conn === "error") return "Coordination paused: the Lanes server answered with an error. Edits still go ahead, uncoordinated. Click to see the log.";
  return "Coordination paused: the Lanes server can't be reached. Edits still go ahead, uncoordinated. Click to start the local server.";
}

/** Which message the view shows: the connection problem, an empty team, or the content. */
export function viewState(conn: Connection, hasContent: boolean): Connection | "empty" | "ready" {
  return conn !== "online" ? conn : hasContent ? "ready" : "empty";
}

export interface Problem {
  event: HookEvent;
  title: string;
}

/** Recent flagged observations, newest first, one per user, kind and file (a repeat only refreshes it). shortcut: a problem fades after 30 minutes; nothing reports "fixed". */
export function problems(snapshot: Snapshot | null, now: number): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const event of [...(snapshot?.events ?? [])].reverse()) {
    const title = PROBLEMS[event.kind];
    if (!title || MERGE_KINDS.has(event.kind) || now - event.at > PROBLEM_WINDOW_MS) continue;
    const key = [event.user, event.kind, event.path ?? event.paths?.join(",")].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ event, title });
  }
  return out;
}

/** Leases whose holder has no registered agent: nothing will ever release them but the lease timeout, or a person. */
export function orphanLeases(snapshot: Snapshot | null): Lease[] {
  if (!snapshot) return [];
  const sessions = new Set(snapshot.agents.map((a) => a.sessionId));
  return snapshot.leases.filter((l) => !sessions.has(l.holder));
}

/** Humans first (you on top), then their agents with the leases each holds and its active task. */
export function groupByUser(snapshot: Snapshot, me: string, merges: MergeItem[] = []): UserGroup[] {
  const groups = new Map<string, UserGroup>();
  for (const agent of snapshot.agents) {
    const group = groups.get(agent.user) ?? { user: agent.user, mine: agent.user === me, agents: [] };
    group.agents.push({
      agent,
      leases: snapshot.leases.filter((l) => l.holder === agent.sessionId),
      task: snapshot.tasks.filter((t) => t.sessionId === agent.sessionId && t.status === "active").at(-1),
      merge: merges.find((m) => m.sessionId === agent.sessionId) ?? merges.find((m) => !m.sessionId && m.user === agent.user && m.repo === agent.repo),
    });
    groups.set(agent.user, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.user.localeCompare(b.user));
}

export interface TaskOverlap {
  /** The other active task. */
  task: Task;
  /** Files both tasks predict or have touched, sorted. */
  files: string[];
}
export interface TaskRow {
  task: Task;
  /** Every file the task predicts or has touched. */
  files: string[];
  overlaps: TaskOverlap[];
}
export interface TaskGroup {
  user: string;
  mine: boolean;
  tasks: TaskRow[];
}
export const DONE_SHOWN = 3;

/**
 * The task board: per person (you first), active tasks newest first, then the last few finished ones. Two active tasks of different
 * agents in the same repository overlap when their files intersect, the rule the server uses when it creates a task (ADR-0018).
 */
export function taskBoard(snapshot: Snapshot | null, me: string): TaskGroup[] {
  const filesOf = (t: Task) => [...new Set([...t.predicted, ...t.touched])];
  const active = (snapshot?.tasks ?? []).filter((t) => t.status === "active");
  const byUser = new Map<string, Task[]>();
  for (const t of snapshot?.tasks ?? []) byUser.set(t.user, [...(byUser.get(t.user) ?? []), t]);
  const groups: TaskGroup[] = [];
  for (const [user, tasks] of byUser) {
    const open = tasks.filter((t) => t.status === "active").sort((a, b) => b.createdAt - a.createdAt);
    const done = tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt)).slice(0, DONE_SHOWN);
    const row = (t: Task): TaskRow => {
      const mine = new Set(filesOf(t));
      const overlaps = t.status !== "active" ? [] : active
        .filter((o) => o.id !== t.id && o.repo === t.repo && o.sessionId !== t.sessionId)
        .map((o) => ({ task: o, files: filesOf(o).filter((f) => mine.has(f)).sort() }))
        .filter((o) => o.files.length > 0);
      return { task: t, files: filesOf(t), overlaps };
    };
    groups.push({ user, mine: user === me, tasks: [...open, ...done].map(row) });
  }
  return groups.sort((a, b) => Number(b.mine) - Number(a.mine) || a.user.localeCompare(b.user));
}

/** Tasks that overlap another, for the status bar hover. */
export const overlapCount = (groups: TaskGroup[]): number => groups.reduce((n, g) => n + g.tasks.filter((t) => t.overlaps.length > 0).length, 0);

/** One line for a task: its state, how many files it touches and, if flagged, with whom. */
export function taskDescription(row: TaskRow, now: number): string {
  const { task, files, overlaps } = row;
  const n = `${files.length} ${files.length === 1 ? "file" : "files"}`;
  if (task.status === "done") return `done ${relativeTime(task.doneAt ?? task.createdAt, now)} · ${n}`;
  const who = [...new Set(overlaps.map((o) => o.task.user))].join(", ");
  const shared = new Set(overlaps.flatMap((o) => o.files)).size;
  return overlaps.length ? `overlaps with ${who} on ${shared} ${shared === 1 ? "file" : "files"} · ${n}` : `working · ${n}`;
}

export function leaseFor(snapshot: Snapshot | null, repo: string, path: string): Lease | undefined {
  return snapshot?.leases.find((l) => l.repo === repo && l.path === path);
}

export function initials(user: string): string {
  const parts = user.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Relative time for the past, the same words as the browser app: "just now", "8 min ago", "3 h ago", "2 d ago". */
export function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** How long a request can still be answered: "~4 min left", or "Expired". */
export function timeLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "Expired";
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `~${m} min left` : `~${Math.round(m / 60)} h left`;
}

/** A request's status in the words of the browser app. */
export const REQUEST_STATUS: Record<AgentRequest["status"], string> = { pending: "Waiting", approved: "Approved", delivered: "Delivered", denied: "Declined", expired: "Expired" };
export const scopeLabel = (scope: AgentRequest["scope"]): string => (scope === "edit" ? "May edit files" : "Read only");

export function agentDescription(row: AgentRow, now: number): string {
  const { agent, task } = row;
  const state = agent.status === "waiting" || agent.status === "blocked" ? `waiting on ${agent.blockedOn ?? "a file"}` : agent.status === "working" ? `editing ${agent.lastPath ?? "…"}` : "idle";
  const text = task ? `${state} · ${task.title}` : `${state} · ${relativeTime(agent.lastSeen, now)}`;
  return row.merge ? `needs merge · ${text}` : text;
}

/** The hover of an agent (Markdown): everything the row only hints at, in plain sentences. */
export function agentTooltip(row: AgentRow, now: number): string {
  const { agent, task, leases } = row;
  const state = agent.status === "waiting" || agent.status === "blocked"
    ? `Waiting for ${agent.blockedOn ? mdCode(agent.blockedOn) : "a file"} that another agent holds. It carries on by itself once the file is free.`
    : agent.status === "working" ? `Editing ${agent.lastPath ? mdCode(agent.lastPath) : "files"}.` : "Idle: no edit in progress.";
  return [
    `**${md(agent.user)}**'s agent in *${md(agent.label)}*`,
    state,
    task ? `Task: ${md(task.title)}` : "",
    leases.length ? `Holds ${leases.map((l) => mdCode(l.path)).join(", ")}: other agents wait for ${leases.length === 1 ? "it" : "them"}.` : "",
    `${agent.edits} ${agent.edits === 1 ? "edit" : "edits"} · last active ${relativeTime(agent.lastSeen, now)}`,
    row.merge ? `**${md(row.merge.title)}.** Nothing is lost: the edits are saved on the agent's branch. Use *Review and merge*.` : "",
  ].filter(Boolean).join("\n\n");
}

/** How long a lease's holder has been silent before the view hints that the lease may be stuck. */
export const STUCK_AFTER_MS = 2 * 60_000;

/** One line for a lease: where it is, and, when its holder has gone quiet, how long (a hint, never a rule: a person decides). */
export function leaseDescription(lease: Lease, holder: Agent | undefined, now: number): string {
  const folder = lease.path.includes("/") ? lease.path.slice(0, lease.path.lastIndexOf("/")) : "";
  const quiet = holder && now - holder.lastSeen > STUCK_AFTER_MS ? `no activity for ${relativeTime(holder.lastSeen, now).replace(" ago", "")}` : "";
  return [folder, quiet].filter(Boolean).join(" · ");
}

/** Delay before the next try after `failures` failures in a row: doubles from `base` up to `max`. */
export function backoffMs(failures: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), max);
}

/** The line that starts a team server from this extension's own CLI (no separate install; node must be on PATH). Forward slashes work in every shell. */
export const teamServerCommand = (extensionPath: string): string => `node "${extensionPath.replace(/\\/g, "/")}/dist/lanes.cjs" server --host 0.0.0.0`;

/** The line that signs in with GitHub (ADR-0031) through this extension's own CLI; it saves the personal token VS Code then uses. */
export const signInCommand = (extensionPath: string, serverUrl: string): string => `node "${extensionPath.replace(/\\/g, "/")}/dist/lanes.cjs" login --server ${serverUrl}`;

/** A ready-to-paste message for a teammate. It holds the team token: only ever put on the clipboard on the user's own request, never logged. */
export function joinMessage(url: string, token: string): string {
  return [
    "Join our Lanes team server (coding agents that never collide).",
    "1. Install the Lanes extension for VS Code, Cursor or Windsurf.",
    '2. Run "Lanes: Join Team Server" from the Command Palette and paste these two values:',
    `   Server: ${url}`,
    `   Token: ${token}`,
    "3. Pull the repository and start Claude Code in it. Your agent shows up in the Lanes view.",
    "The token is a password for our team: do not post it anywhere public.",
  ].join("\n");
}

/** The Team view (multiplayer, ADR-0028): requests waiting for this person's decision first, then their own, then recent chat. */
export function teamView(snapshot: Snapshot | null, me: string): { forMe: AgentRequest[]; fromMe: AgentRequest[]; chat: ChatMessage[] } {
  const team = snapshot?.team;
  const mine = (name: string) => name.toLowerCase() === me.toLowerCase();
  return {
    forMe: (team?.requests ?? []).filter((r) => mine(r.to) && r.status === "pending"),
    fromMe: (team?.requests ?? []).filter((r) => mine(r.from)),
    chat: (team?.chat ?? []).slice(-20).reverse(),
  };
}
