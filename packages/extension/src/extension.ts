// VS Code extension: shows every teammate's agents and the files they hold. It never blocks anyone (ADR-0019).
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { init } from "@lanes/cli/cli.ts";
import { connectEvents, type EventsClient } from "@lanes/core/ws.ts";
import { isLoopback, loadConfig, tokenFor, writeUserConfig } from "@lanes/core/local.ts";
import { findRepo, gitUserName, locate, teamContextOn as teamContextIn } from "@lanes/core/repo.ts";
import type { AgentRequest, ChatMessage, Lease, Snapshot } from "@lanes/core/types.ts";
import { setTeamContext } from "@lanes/cli/team.ts";
import { agentDescription, agentIcon, agentTooltip, backoffMs, changedKeys, connectionFor, groupByUser, heldDecoration, md, mdCode, personColor, relativeTime, joinMessage, teamServerCommand, signInCommand, timeLeft, scopeLabel, REQUEST_STATUS, leaseDescription, leaseFor, needsMerge, offlineTooltip, orphanLeases, problems, safeRelPath, statusBar, statusTooltip, taskBoard, teamView, taskDescription, overlapCount, viewState, type AgentRow, type Connection, type MergeItem, type Problem, type TaskGroup, type TaskOverlap, type TaskRow, type UserGroup } from "./model.ts";
import { sharedContent, sharedRef, unsharedFiles } from "./merge.ts";

const POLL_MS = 1000;
const MAX_BACKOFF_MS = 15_000;

type Node =
  | { kind: "user"; group: UserGroup }
  | { kind: "agent"; row: AgentRow }
  | { kind: "lease"; lease: Lease }
  | { kind: "problems"; list: Problem[] }
  | { kind: "problem"; problem: Problem }
  | { kind: "orphans"; leases: Lease[] }
  | { kind: "merges"; items: MergeItem[] }
  | { kind: "merge"; item: MergeItem };

type TeamNode =
  | { kind: "section"; label: string; icon: string; color: string; count?: number; items: TeamNode[] }
  | { kind: "request"; request: AgentRequest; mine: boolean }
  | { kind: "reply"; request: AgentRequest }
  | { kind: "chat"; message: ChatMessage }
  /** An empty state or an action: one line of text, optionally a command on click. */
  | { kind: "hint"; label: string; icon: string; color: string; command?: string; tooltip?: string };

/** A codicon in a theme colour: it follows light, dark and high-contrast themes. */
const icon = (id: string, color: string) => new vscode.ThemeIcon(id, new vscode.ThemeColor(color));
const markdown = (text: string) => Object.assign(new vscode.MarkdownString(text), { supportThemeIcons: true });

type TaskNode =
  | { kind: "person"; group: TaskGroup }
  | { kind: "task"; row: TaskRow }
  | { kind: "overlap"; row: TaskRow; overlap: TaskOverlap };

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Lanes");
  const config = () => vscode.workspace.getConfiguration("lanes");
  const DEFAULT_URL = "http://127.0.0.1:4317";
  const urlSetting = () => config().get<string>("serverUrl", DEFAULT_URL).replace(/\/+$/, "");
  // Left at its default, the setting gives way to the server `lanes join` or `lanes login` saved in ~/.lanes/config.json (ADR-0030).
  // shortcut: a setting explicitly set to the default address counts as unset; read inspect() if that ever matters.
  const serverUrl = () => (urlSetting() !== DEFAULT_URL ? urlSetting() : loadConfig().serverUrl.replace(/\/+$/, "") || DEFAULT_URL);
  // git user.name of the first folder that is a repository (not folder 0 in a multi-root workspace). Cached: it is read for every
  // tree row and badge, and each git call costs about 25 ms on Windows.
  let gitName: { roots: string; name: string | null; at: number } | undefined;
  const me = () => {
    // Then the name the hooks and the CLI use (lanes init/connect --user), so a team request addressed to it shows up here.
    const explicit = config().get<string>("userName") || loadConfig().user;
    if (explicit) return explicit;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!gitName || gitName.roots !== roots.join("|") || Date.now() - gitName.at > 30_000) {
      const dir = roots.find((r) => fs.existsSync(path.join(r, ".git"))) ?? roots.find((r) => locate(path.join(r, "x"))) ?? roots[0] ?? process.cwd();
      gitName = { roots: roots.join("|"), name: gitUserName(dir), at: Date.now() };
    }
    return gitName.name || process.env.USERNAME || process.env.USER || "me";
  };
  const validUrl = (): URL | undefined => {
    try {
      const u = new URL(serverUrl());
      return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
    } catch {
      return undefined;
    }
  };
  // The setting first, then the personal token `lanes join` or `lanes login` saved for this same server, then a local server's own token.
  const token = () => {
    const saved = loadConfig();
    return config().get<string>("token") || (saved.serverUrl === serverUrl() ? tokenFor(saved) : tokenFor({ serverUrl: serverUrl() })) || "";
  };
  // The hooks run outside VS Code and cannot read its settings: pass them on through ~/.lanes/config.json (#123).
  const shareSettings = () => {
    const url = urlSetting() !== DEFAULT_URL ? urlSetting() : undefined;
    const t = config().get<string>("token") || undefined;
    const wrote = context.globalState?.get<{ serverUrl?: string; token?: string }>("lanes.shared") ?? {};
    try {
      // A setting cleared since it was passed on is removed again (otherwise the hooks keep using the old server or token), but only
      // what this extension wrote: `lanes connect` may own the rest.
      const fields = { serverUrl: url ?? (wrote.serverUrl ? null : undefined), token: t ?? (wrote.token ? null : undefined) };
      if (fields.serverUrl !== undefined || fields.token !== undefined) writeUserConfig(fields);
      void context.globalState?.update("lanes.shared", { serverUrl: url, token: t });
    } catch (err) {
      out.appendLine(`Could not save the server settings for the hooks: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  shareSettings();

  let snapshot: Snapshot | null = null;
  let conn: Connection = "loading";
  // Set when the server says this team uses personal tokens and ours is the shared one: the Team view then shows how to sign in.
  let needsSignIn = false;
  // "Mark as merged" (key -> time). shortcut: kept in memory only, so a restart shows the flag again until it fades.
  const dismissed = new Map<string, number>();
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let serverProc: ChildProcess | undefined;
  const changed = new vscode.EventEmitter<void>();
  const tasksChanged = new vscode.EventEmitter<void>();
  const teamChanged = new vscode.EventEmitter<void>();
  const decorationsChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  // The snapshot stream (#48) is preferred; polling /v1/state is the fallback whenever it is down (old server, blocked upgrade).
  let stream: EventsClient | undefined;
  let streamOpen = false;
  let streamFailures = 0;
  let streamRetryAt = 0;
  function openStream(): void {
    if (stream || Date.now() < streamRetryAt) return;
    const url = serverUrl().replace(/^http/, "ws") + "/v1/events";
    const mine: { c?: EventsClient } = {};
    mine.c = stream = connectEvents(url, { authorization: `Bearer ${token()}` }, {
      onOpen: () => {
        streamOpen = true;
        streamFailures = 0;
        out.appendLine("Live updates connected");
      },
      onMessage: (text) => {
        try {
          const msg = JSON.parse(text) as { type?: string; snapshot?: Snapshot };
          if (msg.type !== "snapshot" || !msg.snapshot) return;
          failures = 0;
          conn = "online";
          snapshot = msg.snapshot;
          render();
        } catch {
          /* a bad frame is ignored; the next snapshot replaces it */
        }
      },
      onClose: (reason) => {
        if (stream !== mine.c) return; // closed on purpose
        stream = undefined;
        if (streamOpen) out.appendLine(`Live updates lost (${reason}); polling instead`);
        streamOpen = false;
        streamFailures++;
        streamRetryAt = Date.now() + backoffMs(streamFailures, 1000, 30_000);
        clearTimeout(timer);
        void poll(); // right away, so the views notice an outage within a second
      },
    });
  }
  function closeStream(): void {
    const s = stream;
    stream = undefined;
    streamOpen = false;
    s?.close();
  }

  // The same request decides "offline" in the status bar and whether Open Team App can open.
  const getState = (ms: number) => fetch(serverUrl() + "/v1/state", { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(ms) });

  let disposed = false; // a poll still in flight when the extension is disposed must not re-arm itself
  async function poll(): Promise<void> {
    if (disposed) return;
    if (streamOpen) {
      // The stream is the source of truth; this only re-arms in case it dies silently (it reports its own closing).
      timer = setTimeout(poll, MAX_BACKOFF_MS);
      return;
    }
    try {
      if (!validUrl()) throw Object.assign(new Error(`lanes.serverUrl is not a valid address (${serverUrl()}); use something like http://127.0.0.1:4317`), { status: 0 });
      const res = await getState(3000);
      if (!res.ok) throw Object.assign(new Error(`server answered ${res.status}${res.status === 401 ? " (check lanes.token)" : ""}`), { status: res.status });
      const next = (await res.json()) as Snapshot;
      if (failures) out.appendLine(`Connected to ${serverUrl()}`);
      failures = 0;
      conn = "online";
      snapshot = next;
      openStream(); // the server answers: try the live stream (it backs off by itself)
    } catch (err) {
      if (failures === 0) out.appendLine(`Server unreachable: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
      snapshot = null;
      conn = connectionFor((err as { status?: number }).status);
    }
    if (disposed) return;
    render();
    timer = setTimeout(poll, backoffMs(failures, POLL_MS, MAX_BACKOFF_MS));
  }

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = "lanes.statusClick";
  bar.name = "Lanes";
  bar.show();

  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    getChildren(node?: Node): Node[] {
      if (!snapshot) return [];
      if (!node) {
        const merges = needsMerge(snapshot, snapshot.serverTime, dismissed);
        const nodes: Node[] = groupByUser(snapshot, me(), merges).map((group) => ({ kind: "user", group }));
        // Needs-merge items whose agent is gone (or is not listed) still need showing.
        if (merges.length > 0) nodes.push({ kind: "merges", items: merges });
        const list = problems(snapshot, snapshot.serverTime);
        if (list.length > 0) nodes.push({ kind: "problems", list });
        const orphans = orphanLeases(snapshot);
        if (orphans.length > 0) nodes.push({ kind: "orphans", leases: orphans });
        return nodes;
      }
      if (node.kind === "merges") return node.items.map((item) => ({ kind: "merge", item }));
      if (node.kind === "problems") return node.list.map((problem) => ({ kind: "problem", problem }));
      if (node.kind === "orphans") return node.leases.map((lease) => ({ kind: "lease", lease }));
      if (node.kind === "user") return node.group.agents.map((row) => ({ kind: "agent", row }));
      if (node.kind === "agent") return node.row.leases.map((lease) => ({ kind: "lease", lease }));
      return [];
    },
    getTreeItem(node: Node): vscode.TreeItem {
      if (node.kind === "user") {
        const { agents, mine, user } = node.group;
        const n = agents.length;
        const waiting = agents.filter((r) => r.agent.status === "waiting" || r.agent.status === "blocked").length;
        const held = agents.reduce((sum, r) => sum + r.leases.length, 0);
        const item = new vscode.TreeItem(mine ? `${user} (you)` : user, vscode.TreeItemCollapsibleState.Expanded);
        item.description = [`${n} ${n === 1 ? "agent" : "agents"}`, waiting ? `${waiting} waiting` : "", held ? `${held} ${held === 1 ? "file" : "files"} held` : ""].filter(Boolean).join(" · ");
        item.tooltip = markdown(`**${md(user)}**${mine ? " (you)" : ""}: ${item.description}. Files held by ${mine ? "your" : "their"} agents carry ${mine ? "your" : "their"} initials in the Explorer.`);
        item.iconPath = icon("account", personColor(user, mine));
        return item;
      }
      if (node.kind === "agent") {
        const { agent } = node.row;
        const item = new vscode.TreeItem(agent.label, node.row.leases.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        const now = snapshot?.serverTime ?? Date.now();
        item.description = agentDescription(node.row, now);
        item.tooltip = markdown(agentTooltip(node.row, now));
        item.accessibilityInformation = { label: `${agent.user}'s agent ${agent.label}: ${agentDescription(node.row, now)}`, role: "treeitem" };
        item.iconPath = icon(...agentIcon(node.row));
        item.contextValue = agent.lastPath ? "agent" : "agentIdle";
        return item;
      }
      if (node.kind === "merges") {
        const item = new vscode.TreeItem("Needs merge", vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.items.length}`;
        item.tooltip = "Edits that are saved on an agent's branch but not shared yet. Nothing is lost. Use Review and merge to compare.";
        item.iconPath = icon("git-merge", "charts.red");
        return item;
      }
      if (node.kind === "merge") {
        const { item: m } = node;
        const item = new vscode.TreeItem(m.title);
        item.description = [m.user, m.paths.length ? `${m.paths.length} ${m.paths.length === 1 ? "file" : "files"}` : ""].filter(Boolean).join(" · ");
        item.tooltip = [m.title, m.paths.length ? m.paths.join("\n") : "The files are found when you review.", m.user === me() ? "Click to review and merge." : `Only ${m.user} can merge this from their own checkout.`].join("\n");
        item.iconPath = icon("git-merge", "charts.red");
        item.contextValue = m.user === me() ? "merge" : "mergeOther";
        if (m.user === me()) item.command = { command: "lanes.reviewMerge", title: "Review and merge", arguments: [node] };
        return item;
      }
      if (node.kind === "problems") {
        const item = new vscode.TreeItem("Problems", vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.list.length);
        item.iconPath = icon("warning", "charts.red");
        return item;
      }
      if (node.kind === "orphans") {
        const item = new vscode.TreeItem("Files held by no agent", vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.leases.length}: release them from the right-click menu`;
        item.tooltip = "These files are still marked as held, but their agent is gone. They free up by themselves within minutes, or you can release them now.";
        item.iconPath = icon("lock", "list.warningForeground");
        return item;
      }
      if (node.kind === "problem") {
        const { event, title } = node.problem;
        const item = new vscode.TreeItem(title);
        item.description = [event.user, event.path ?? event.paths?.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
        item.tooltip = [title, event.error].filter(Boolean).join("\n");
        item.iconPath = icon("warning", "charts.red");
        return item;
      }
      const item = new vscode.TreeItem(path.posix.basename(node.lease.path));
      const holder = snapshot?.agents.find((a) => a.sessionId === node.lease.holder);
      const now = snapshot?.serverTime ?? Date.now();
      item.description = leaseDescription(node.lease, holder, now) || path.posix.dirname(node.lease.path);
      const mine = node.lease.user === me();
      item.tooltip = markdown(`${mdCode(node.lease.path)}

Held by ${mine ? "**your** agent" : `**${md(node.lease.user)}**'s agent`} for one edit, since ${relativeTime(node.lease.acquiredAt, now)}. It frees up by itself once the edit is shared. Other agents wait for it; people are never blocked.

Release it only if the agent is gone: the edit it is making goes ahead either way.`);
      item.iconPath = icon("lock", !holder ? "list.warningForeground" : mine ? "lanes.heldByYou" : "lanes.heldByTeammate");
      item.contextValue = "lease";
      item.command = { command: "lanes.openLease", title: "Open", arguments: [node.lease] };
      return item;
    },
  };

  // The Tasks view (#60): who is working on what, with overlapping files flagged. A heads-up for people; nothing is blocked.
  const tasksTree: vscode.TreeDataProvider<TaskNode> = {
    onDidChangeTreeData: tasksChanged.event,
    getChildren(node?: TaskNode): TaskNode[] {
      if (!snapshot) return [];
      if (!node) return taskBoard(snapshot, me()).map((group) => ({ kind: "person", group }));
      if (node.kind === "person") return node.group.tasks.map((row) => ({ kind: "task", row }));
      if (node.kind === "task") return node.row.overlaps.map((overlap) => ({ kind: "overlap", row: node.row, overlap }));
      return [];
    },
    getTreeItem(node: TaskNode): vscode.TreeItem {
      const now = snapshot?.serverTime ?? Date.now();
      if (node.kind === "person") {
        const open = node.group.tasks.filter((r) => r.task.status === "active").length;
        const item = new vscode.TreeItem(node.group.mine ? `${node.group.user} (you)` : node.group.user, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${open} ${open === 1 ? "task" : "tasks"} in progress`;
        item.iconPath = icon("account", personColor(node.group.user, node.group.mine));
        return item;
      }
      if (node.kind === "task") {
        const { row } = node;
        const flagged = row.overlaps.length > 0;
        const item = new vscode.TreeItem(row.task.title || "Untitled task", flagged ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.description = taskDescription(row, now);
        item.tooltip = [row.task.title, taskDescription(row, now), row.files.length ? `Files: ${row.files.join(", ")}` : "No files known yet", flagged ? "Both agents carry on: nothing is blocked. You may want to talk to each other." : ""].filter(Boolean).join("\n");
        item.accessibilityInformation = { label: `${row.task.user}'s task ${row.task.title}: ${taskDescription(row, now)}`, role: "treeitem" };
        item.iconPath = flagged ? icon("warning", "charts.orange") : row.task.status === "done" ? icon("check", "disabledForeground") : icon("pulse", "charts.green");
        return item;
      }
      const { overlap } = node;
      const item = new vscode.TreeItem(`${overlap.task.user}: ${overlap.task.title}`);
      item.description = overlap.files.join(", ");
      item.tooltip = `${overlap.task.user}'s task also involves ${overlap.files.join(", ")}. Click to open ${overlap.files[0]}.`;
      item.iconPath = icon("git-compare", "charts.orange");
      item.command = { command: "lanes.openTaskFile", title: "Open overlapping file", arguments: [node] };
      return item;
    },
  };

  // The Team view (multiplayer, ADR-0028), the same sections as the browser app: Inbox, Sent requests, Team chat.
  // Hints are muted; the sign-in hint is amber because chat and requests are off until it is done.
  const hint = (label: string, icon: string, command?: string, tooltip?: string, color = "descriptionForeground"): TeamNode => ({ kind: "hint", label, icon, color, command, tooltip });
  const REQUEST_ICON: Record<AgentRequest["status"], [icon: string, color: string]> = { pending: ["watch", "charts.yellow"], approved: ["check", "charts.green"], delivered: ["check-all", "charts.green"], denied: ["close", "disabledForeground"], expired: ["history", "disabledForeground"] };
  const teamTree: vscode.TreeDataProvider<TeamNode> = {
    onDidChangeTreeData: teamChanged.event,
    getChildren(node?: TeamNode): TeamNode[] {
      if (node) return node.kind === "section" ? node.items : node.kind === "request" && node.mine && node.request.reply ? [{ kind: "reply", request: node.request }] : [];
      if (!snapshot) return []; // the welcome view says why (connecting, paused, token refused, server error)
      const view = teamView(snapshot, me());
      return [
        ...(teamCtx === "off" ? [hint("Team context is off in this repository: agents don't get the team brief yet. Turn it on", "info", "lanes.teamContextOn", "Agents in this repository then get a short team brief with each prompt. Commit .lanes/team.json so teammates get it too.")] : []),
        ...(needsSignIn ? [hint("Sign in to use team chat and requests", "account", "lanes.copySignInCommand", "This team uses personal tokens. Click to copy the sign-in command (Sign in with GitHub), or run the lanes join command your admin sent you.", "charts.yellow")] : []),
        { kind: "section", label: "Inbox", icon: "inbox", color: view.forMe.length ? "charts.yellow" : "descriptionForeground", count: view.forMe.length, items: view.forMe.length ? view.forMe.map((request) => ({ kind: "request", request, mine: false })) : [hint("Nothing waiting for you", "check")] },
        { kind: "section", label: "Sent requests", icon: "send", color: "charts.blue", items: [...view.fromMe.map((request): TeamNode => ({ kind: "request", request, mine: true })), hint("Ask a teammate's agent…", "person-add", "lanes.teamAsk", "It reaches their agent only after they approve it.")] },
        { kind: "section", label: "Team chat", icon: "comment-discussion", color: "charts.blue", items: view.chat.length ? [hint("Message the team…", "edit", "lanes.teamSay", "@name or @team reaches their agents."), ...view.chat.map((message): TeamNode => ({ kind: "chat", message }))] : [hint("No messages yet. Say hello to the team.", "comment", "lanes.teamSay")] },
      ];
    },
    getTreeItem(node: TeamNode): vscode.TreeItem {
      const now = snapshot?.serverTime ?? Date.now();
      if (node.kind === "section") {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = icon(node.icon, node.color);
        if (node.count) item.description = String(node.count);
        return item;
      }
      if (node.kind === "hint") {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = icon(node.icon, node.color);
        if (node.tooltip) item.tooltip = node.tooltip;
        if (node.command) item.command = { command: node.command, title: node.label };
        return item;
      }
      if (node.kind === "chat") {
        const m = node.message;
        const item = new vscode.TreeItem(`${m.user}: ${m.text}`);
        item.description = relativeTime(m.at, now);
        item.tooltip = `${m.user}, ${relativeTime(m.at, now)}\n${m.text}`;
        const forMe = (m.mentions ?? []).some((x) => x.toLowerCase() === me().toLowerCase() || x.toLowerCase() === "team");
        item.iconPath = icon(forMe ? "mention" : "comment", personColor(m.user, m.user === me()));
        return item;
      }
      const r = node.request;
      if (node.kind === "reply") {
        const item = new vscode.TreeItem(`${r.to}'s agent replied: ${r.reply}`);
        item.tooltip = r.reply;
        item.iconPath = icon("reply", personColor(r.to, r.to === me()));
        return item;
      }
      if (!node.mine) {
        const item = new vscode.TreeItem(`${r.from}: ${r.text}`);
        item.description = `${scopeLabel(r.scope)} · ${timeLeft(r.expiresAt, now)}`;
        item.tooltip = `${r.from} asks your agent (${scopeLabel(r.scope).toLowerCase()}):\n${r.text}\n\nApprove and your agent gets it with your next prompt. Nothing reaches your agent until you approve.`;
        item.iconPath = icon("mail", r.status === "pending" ? "charts.yellow" : "disabledForeground");
        item.accessibilityInformation = { label: `${r.from} asks your agent, ${scopeLabel(r.scope)}, ${timeLeft(r.expiresAt, now)}: ${r.text}`, role: "treeitem" };
        if (r.status === "pending") item.contextValue = "request";
        return item;
      }
      const item = new vscode.TreeItem(`To ${r.to}: ${r.text}`, r.reply ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.description = `${REQUEST_STATUS[r.status] ?? r.status} · ${scopeLabel(r.scope)} · ${relativeTime(r.decidedAt ?? r.createdAt, now)}`;
      item.tooltip = `To ${r.to} (${scopeLabel(r.scope).toLowerCase()}): ${r.text}\n${r.status === "pending" ? `Waiting for ${r.to} to approve it (${timeLeft(r.expiresAt, now)}).` : r.status === "delivered" ? `Approved and sent to ${r.to}'s agent.` : `${REQUEST_STATUS[r.status] ?? r.status}.`}`;
      item.iconPath = icon(...(REQUEST_ICON[r.status] ?? ["circle-outline", "disabledForeground"]));
      return item;
    },
  };

  /** The repository a team command acts on, with this person's identity (same fields the hook sends). */
  async function teamWho(): Promise<{ user: string; sessionId: string; repo: string; label: string } | undefined> {
    const folder = await pickFolder();
    const loc = folder ? locate(path.join(folder, "x")) : null;
    if (!loc) return void vscode.window.showInformationMessage("Open a git repository folder to use the team chat and requests.");
    return { user: me(), sessionId: `vscode-${me()}`, repo: loc.repo.id, label: loc.repo.label };
  }
  const copySignIn = () => copy(signInCommand(context.extensionPath, serverUrl()), "Copied. Paste it in a terminal: it shows a code to enter on GitHub, then VS Code uses your personal token.");
  async function teamPost(route: string, body: object): Promise<{ error?: string; id?: string; status?: string } | undefined> {
    const res = await fetch(serverUrl() + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(body) }).catch(() => undefined);
    if (!res) return void vscode.window.showWarningMessage("Couldn't reach the Lanes server, so nothing was sent. Edits still go ahead. Try again once it's back (Lanes: Reconnect).");
    const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string; status?: string };
    if (res.status === 403 && /personal token/i.test(data.error ?? "")) {
      needsSignIn = true;
      render();
      return void Promise.resolve(vscode.window.showWarningMessage("This team uses personal tokens, so chat and requests need yours. Sign in with GitHub (lanes login), or run the lanes join command your admin sent you.", "Copy Sign-In Command")).then((c) => c && copySignIn());
    }
    if (!res.ok) return void vscode.window.showWarningMessage(`Couldn't send: ${data.error ?? `the Lanes server answered ${res.status}`}.`);
    if (needsSignIn) {
      needsSignIn = false;
      render();
    }
    return data;
  }
  async function teamSay(): Promise<void> {
    const who = await teamWho();
    const text = who && (await vscode.window.showInputBox({ title: "Message the team", prompt: "@name or @team reaches their agents", placeHolder: "I'm renaming getUser to fetchUser in session.ts", ignoreFocusOut: true }));
    if (who && text?.trim()) await teamPost("/v1/team/say", { ...who, text });
  }
  async function teamAsk(): Promise<void> {
    const who = await teamWho();
    if (!who) return;
    const people = [...new Set((snapshot?.agents ?? []).filter((a) => a.repo === who.repo && a.user.toLowerCase() !== who.user.toLowerCase()).map((a) => a.user))];
    const to = people.length ? await vscode.window.showQuickPick(people, { title: "Ask a teammate's agent (1 of 3)", placeHolder: "Whose agent?" }) : await vscode.window.showInputBox({ title: "Ask a teammate's agent (1 of 3)", prompt: "Your teammate's name, as Lanes shows it", ignoreFocusOut: true });
    const text = to?.trim() && (await vscode.window.showInputBox({ title: `Ask ${to}'s agent (2 of 3)`, prompt: "It reaches their agent only after they approve it", placeHolder: "Explain how session expiry works", ignoreFocusOut: true }));
    if (!to?.trim() || !text?.trim()) return;
    const scope = await vscode.window.showQuickPick(["Read only", "May edit files"], { title: `What may ${to}'s agent do? (3 of 3)`, placeHolder: "Read only: it can look but not change files. May edit files: it works on its own branch." });
    if (!scope) return;
    const r = await teamPost("/v1/team/ask", { ...who, to: to.trim(), text, scope: scope === "May edit files" ? "edit" : "read" });
    if (r) void vscode.window.showInformationMessage(`Request sent to ${to}. It reaches their agent only after they approve it; its status shows under Sent requests.`);
  }
  async function decide(request: AgentRequest | undefined, decision: "approve" | "deny"): Promise<void> {
    if (!request) return;
    const loc = folderFor(request.repo);
    const r = await teamPost("/v1/team/decide", { user: me(), sessionId: `vscode-${me()}`, repo: request.repo, label: loc ? path.basename(loc) : "repo", id: request.id, decision });
    if (r?.status === "approved") void vscode.window.showInformationMessage("Approved. Your agent gets it with your next prompt.");
    else if (r) void vscode.window.showInformationMessage(`Declined. ${request.from} sees it in their sent requests.`);
  }
  // "on" or "off" in the first open folder that is a repository, undefined with none. Read on activation and after the two commands, not per render.
  // shortcut: in a multi-root workspace it follows the first repository folder, not the one picked last; read the picked one if that matters.
  let teamCtx: "on" | "off" | undefined;
  function readTeamContext(): void {
    const root = (vscode.workspace.workspaceFolders ?? []).map((f) => findRepo(f.uri.fsPath)?.root).find(Boolean);
    teamCtx = root ? (teamContextIn(root) ? "on" : "off") : undefined;
    void vscode.commands.executeCommand("setContext", "lanes.teamContext", teamCtx);
    teamChanged.fire();
  }
  /** The same path as `lanes team on|off`: writes .lanes/team.json, which the person commits. */
  async function switchTeamContext(on: boolean): Promise<void> {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const file = setTeamContext(folder, on);
      const name = path.basename(path.dirname(path.dirname(file)));
      void vscode.window.showInformationMessage(on ? `Team context is on in ${name}: agents there get a short team brief with each prompt. Commit .lanes/team.json so teammates get it too.` : `Team context is off in ${name}: agents there no longer get the team brief. Commit .lanes/team.json so teammates get the same setting.`);
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    readTeamContext();
  }
  /** The browser app (ADR-0029), only once the server answers: otherwise the browser would show a bare connection error. */
  async function openApp(): Promise<void> {
    const answers = await getState(2000).then(() => true, () => false);
    if (!answers) return void Promise.resolve(vscode.window.showWarningMessage(`The Lanes server at ${serverUrl()} is not answering, so the app can't open. Start it with Lanes: Start Local Server, or check lanes.serverUrl.`, "Start Local Server")).then((c) => c && startServer());
    // The token goes in the fragment, which the browser never sends to the server.
    await vscode.env.openExternal(vscode.Uri.parse(`${serverUrl()}/app#${new URLSearchParams({ token: token(), user: me() })}`));
  }
  // A new request for this person: one notification with the decision buttons, never repeated.
  const notified = new Set<string>();
  function notifyRequests(): void {
    for (const r of teamView(snapshot, me()).forMe) {
      if (notified.has(r.id)) continue;
      notified.add(r.id);
      void Promise.resolve(vscode.window.showInformationMessage(`${r.from} asks your agent (${r.scope === "edit" ? "may edit files" : "read only"}): ${r.text}`, "Approve", "Decline")).then((choice) => {
        if (choice) void decide(r, choice === "Approve" ? "approve" : "deny");
      });
    }
  }

  function render(): void {
    const now = snapshot?.serverTime ?? Date.now();
    const list = problems(snapshot, now);
    const orphans = orphanLeases(snapshot);
    const merges = needsMerge(snapshot, now, dismissed);
    const flagged = list.length + orphans.length + merges.length;
    const board = taskBoard(snapshot, me());
    const inbox = teamView(snapshot, me()).forMe.length;
    const look = statusBar(snapshot, conn, flagged, merges.length, inbox);
    bar.text = look.text;
    bar.backgroundColor = look.background ? new vscode.ThemeColor(look.background) : undefined;
    const tip = markdown(statusTooltip(snapshot, conn, { me: me(), now, merges, problems: list, orphans, overlaps: snapshot ? overlapCount(board) : 0, inbox }));
    // Only these commands run from the hover's links; names and paths from the server are escaped, so they cannot add links.
    tip.isTrusted = { enabledCommands: ["lanes.agents.focus", "lanes.tasks.focus", "lanes.team.focus", "lanes.reconnect", "lanes.startServer", "lanes.showLog", "workbench.action.openSettings"] };
    bar.tooltip = tip;
    bar.accessibilityInformation = { label: `${bar.text.replace(/\$\([^)]*\)\s*/g, "")}. ${!snapshot ? offlineTooltip(conn) : inbox > 0 ? `${inbox} ${inbox === 1 ? "request is" : "requests are"} waiting for you: open the Team view` : "Open the Lanes agents view"}` };
    const content = !!snapshot && (snapshot.agents.length > 0 || flagged > 0);
    void vscode.commands.executeCommand("setContext", "lanes.agentsState", viewState(conn, content));
    // Once per install, until a server answers: a notification (not a tab that steals focus) that links to the walkthrough.
    if ((conn === "offline" || conn === "refused") && context.globalState && !context.globalState.get("lanes.welcomed")) {
      void context.globalState.update("lanes.welcomed", true);
      void Promise.resolve(vscode.window.showInformationMessage("Lanes is installed. Two steps and your team's agents show up here.", "Get Started", "Join a Team Server")).then((choice) => {
        if (choice === "Get Started") void vscode.commands.executeCommand("workbench.action.openWalkthrough", "MicheleFMatozza.lanes#lanes.start");
        else if (choice) void joinTeam();
      });
    }
    if (snapshot && snapshot.agents.length > 0) void vscode.commands.executeCommand("setContext", "lanes.sawAgent", true); // completes the last walkthrough step
    void vscode.commands.executeCommand("setContext", "lanes.tasksState", viewState(conn, board.length > 0));
    void vscode.commands.executeCommand("setContext", "lanes.teamState", viewState(conn, true));
    changed.fire();
    tasksChanged.fire();
    teamChanged.fire();
    notifyRequests();
    refreshDecorations();
  }

  // Explorer badges: only the files whose holder changed since the last snapshot are refreshed, not the whole tree.
  // shortcut: the file is found as <open folder>/<lease path>; a folder opened through a symlink may miss a refresh until the next change.
  let decorated = new Map<string, string>();
  function refreshDecorations(): void {
    const next = new Map<string, string>();
    for (const lease of snapshot?.leases ?? []) {
      const root = safeRelPath(lease.path) ? folderFor(lease.repo) : undefined;
      if (root) next.set(path.join(root, lease.path), `${lease.user}\u0000${lease.user === me()}`);
    }
    const uris = changedKeys(decorated, next).map((p) => vscode.Uri.file(p));
    decorated = next;
    if (uris.length) decorationsChanged.fire(uris);
  }

  // Resolved once per file and checkout root, never on every snapshot.
  const located = new Map<string, ReturnType<typeof locate>>();
  const locateCached = (uri: vscode.Uri) => {
    if (uri.scheme !== "file") return null;
    if (!located.has(uri.fsPath)) located.set(uri.fsPath, locate(uri.fsPath));
    return located.get(uri.fsPath) ?? null;
  };

  const decorations: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationsChanged.event,
    provideFileDecoration(uri) {
      const loc = locateCached(uri);
      const d = heldDecoration(loc ? leaseFor(snapshot, loc.repo.id, loc.path) : undefined, me());
      return d && new vscode.FileDecoration(d.badge, d.tooltip, new vscode.ThemeColor(d.color));
    },
  };

  // C6: warn once per lease when a human types into a file a teammate's agent holds. Never blocks.
  const warned = new Set<string>();
  const onEdit = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.contentChanges.length === 0) return;
    const loc = locateCached(e.document.uri);
    const lease = loc && leaseFor(snapshot, loc.repo.id, loc.path);
    if (!lease || lease.user === me()) return;
    const key = `${lease.holder}:${lease.path}:${lease.acquiredAt}`;
    if (warned.has(key)) return;
    warned.add(key);
    void vscode.window.showWarningMessage(`${lease.user}'s agent is editing ${lease.path} right now. You can keep typing, but your changes may conflict with its edit.`);
  });

  function reconnect(): void {
    clearTimeout(timer);
    closeStream();
    streamRetryAt = 0;
    failures = 0;
    void poll();
  }

  function startServer(): void {
    const url = validUrl();
    if (!url) return void vscode.window.showErrorMessage(`lanes.serverUrl is not a valid address (${serverUrl()}). Use something like http://127.0.0.1:4317.`, "Open Setting").then((c) => c && vscode.commands.executeCommand("workbench.action.openSettings", "lanes.serverUrl"));
    // A team server runs on its own machine; starting one here on its port would only mislead (#201).
    if (!isLoopback(url.href)) return void vscode.window.showWarningMessage(`lanes.serverUrl points at another machine (${url.host}). Start the Lanes server there, or set lanes.serverUrl to http://127.0.0.1:4317 to use a local one.`);
    if (serverProc) return void vscode.window.showInformationMessage("The Lanes server is already running.");
    const script = path.join(context.extensionPath, "dist", "server.cjs");
    // VS Code's own Node runtime: users need no separate Node install.
    serverProc = spawn(process.execPath, ["--no-warnings", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LANES_PORT: url.port || "4317", LANES_TOKEN: token() },
      windowsHide: true,
    });
    serverProc.stdout?.on("data", (d) => {
      out.append(String(d));
      if (/listening/.test(String(d))) reconnect(); // not after the poll's backoff of up to 15 s (#198)
    });
    serverProc.stderr?.on("data", (d) => out.append(String(d)));
    const proc = serverProc;
    proc.on("exit", (code) => {
      out.appendLine(`Server exited (${code})`);
      if (serverProc === proc) serverProc = undefined; // so Start works again after Stop (a killed process has exitCode null)
    });
    out.appendLine(`Starting Lanes server on ${url.host}`);
  }

  /** The repository to act on: the only open folder, the one folder that is a git checkout, or the user's pick (multi-root workspaces). */
  async function pickFolder(): Promise<string | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) return void vscode.window.showErrorMessage("Open a repository folder first (File > Open Folder).");
    const repos = roots.filter((r) => locate(path.join(r, "x")));
    if (roots.length === 1 || repos.length === 1) return repos[0] ?? roots[0];
    return vscode.window.showQuickPick(repos.length ? repos : roots, { title: "Which repository?", placeHolder: "Pick a folder" });
  }

  async function setUp(): Promise<void> {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const { files, integration, notes } = init(folder, { commit: true, assets: path.join(context.extensionPath, "dist") });
      out.appendLine(`Set up Lanes: ${files.join(", ")}`);
      out.appendLine(integration.message);
      for (const note of notes) out.appendLine(note);
      // A short toast: VS Code cuts long ones off. Anything that needs attention (no origin, no access) is its own warning.
      void vscode.window.showInformationMessage("Lanes is set up and committed. Push the commit so teammates get it.");
      if (integration.mode !== "remote") void vscode.window.showWarningMessage(integration.message);
      for (const note of notes) void vscode.window.showInformationMessage(note);
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  /** Clipboard on the user's own request only. The text may hold the token, so it is never written to the output channel. */
  const copy = (text: string, done: string) => void Promise.resolve(vscode.env.clipboard.writeText(text)).then(() => vscode.window.showInformationMessage(done));

  function copyJoinMessage(): void {
    let url = serverUrl();
    if (isLoopback(url)) {
      // The address teammates can reach: this machine's first non-loopback IPv4 (the CLI lists them all).
      const lan = Object.values(os.networkInterfaces()).flatMap((l) => l ?? []).find((a) => a.family === "IPv4" && !a.internal);
      url = `http://${lan?.address ?? os.hostname()}:${validUrl()?.port || "4317"}`;
    }
    copy(joinMessage(url, token()), "Copied the join message. It holds your team token: send it only to teammates.");
  }

  /** The teammate's side: two prompts instead of two settings to find. The settings are machine-scoped, so they stay out of the repository and of Settings Sync. */
  async function joinTeam(): Promise<void> {
    const url = await vscode.window.showInputBox({ title: "Join a team server (1 of 2)", prompt: "The server address from your teammate, for example http://192.168.1.20:4317", ignoreFocusOut: true, validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : "Use an address like http://192.168.1.20:4317") });
    if (!url) return;
    const secret = await vscode.window.showInputBox({ title: "Join a team server (2 of 2)", prompt: "The token from your teammate: the team token, or the personal token in your lanes join command", password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : "Paste the token") });
    if (!secret) return;
    await config().update("serverUrl", url.trim(), vscode.ConfigurationTarget.Global);
    await config().update("token", secret.trim(), vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage("Connecting to the team server. Your agent shows up here once the repository is set up and Claude Code runs in it.");
  }

  async function release(node?: Node): Promise<void> {
    if (node?.kind !== "lease") return;
    const res = await fetch(serverUrl() + "/v1/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
      body: JSON.stringify({ repo: node.lease.repo, path: node.lease.path }),
    }).catch(() => undefined);
    out.appendLine(`Released lease on ${node.lease.path} (held by ${node.lease.user}): ${res?.ok ? "ok" : "failed"}`);
    if (!res?.ok) void vscode.window.showWarningMessage(`Could not release ${node.lease.path}: the Lanes server did not answer. Try again in a moment.`);
  }

  /** The open folder that is a checkout of `repo`, or undefined. */
  // Cached per set of open folders for 30 s: the badges ask for every held file on every snapshot.
  let folderRepos: { roots: string; at: number; ids: Map<string, string> } | undefined;
  const folderFor = (repo: string) => {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!folderRepos || folderRepos.roots !== roots.join("|") || Date.now() - folderRepos.at > 30_000) {
      const ids = new Map<string, string>();
      for (const root of roots) { const id = locate(path.join(root, "x"))?.repo.id; if (id && !ids.has(id)) ids.set(id, root); }
      folderRepos = { roots: roots.join("|"), at: Date.now(), ids };
    }
    return folderRepos.ids.get(repo);
  };

  async function openAgentFile(node?: Node): Promise<void> {
    if (node?.kind !== "agent" || !node.row.agent.lastPath) return;
    const { lastPath, repo } = node.row.agent;
    const root = folderFor(repo);
    if (!root || !safeRelPath(lastPath)) return void vscode.window.showInformationMessage(`${lastPath} is not in a folder you have open.`);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, lastPath))).then(undefined, () => vscode.window.showInformationMessage(`${lastPath} does not exist in your copy yet.`));
  }

  /**
   * Needs merge, one click: a read-only side-by-side of the shared version and this checkout's copy. It writes nothing to the
   * repository and discards nothing; the agent's commits stay on its branch (docs/product/user-journeys.md, journey 6).
   */
  let sharedDir: string | undefined;
  let sharedCopies = 0;
  async function reviewMerge(node?: Node): Promise<void> {
    if (node?.kind !== "merge") return;
    const { item } = node;
    const root = folderFor(item.repo);
    if (!root) return void vscode.window.showInformationMessage("Open the repository folder where this happened to review it.");
    const ref = sharedRef(root);
    if (!ref) return void vscode.window.showInformationMessage("This checkout has no shared branch (lanes/main) to compare with. Run Lanes: Set Up Repository first.");
    const files = (item.paths.length ? item.paths.filter(safeRelPath) : []).filter((p) => fs.existsSync(path.join(root, p)));
    const candidates = files.length ? files : unsharedFiles(root, ref);
    if (candidates.length === 0) {
      dismissed.set(item.key, Date.now());
      render();
      return void vscode.window.showInformationMessage("Nothing left to merge: your copy matches the shared branch.");
    }
    const pick = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates, { title: "Which file do you want to compare?", placeHolder: "Pick a file" });
    if (!pick) return;
    const theirs = sharedContent(root, ref, pick);
    if (theirs.equals(fs.readFileSync(path.join(root, pick)))) {
      dismissed.set(item.key, Date.now());
      render();
      return void vscode.window.showInformationMessage(`${pick} already matches the shared version: nothing to merge.`);
    }
    // The shared side is a temporary copy: changing it changes nothing.
    sharedDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "lanes-shared-")); // removed when the extension is deactivated
    const left = path.join(sharedDir, `${++sharedCopies}-${path.basename(pick)}`);
    fs.writeFileSync(left, theirs);
    await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(left), vscode.Uri.file(path.join(root, pick)), `${path.basename(pick)}: shared version ↔ your copy`);
    const choice = await vscode.window.showInformationMessage("Merge what you need on the right and save. Nothing is lost: the agent's edits stay saved on its branch.", "Mark as merged");
    if (choice === "Mark as merged") dismissMerge(node);
  }

  function dismissMerge(node?: Node): void {
    if (node?.kind !== "merge") return;
    dismissed.set(node.item.key, Date.now());
    out.appendLine(`Marked as merged: ${node.item.title} (${node.item.user})`);
    render();
  }

  context.subscriptions.push(
    out, bar, onEdit, changed, decorationsChanged,
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("lanes")) { needsSignIn = false; shareSettings(); reconnect(); } }),
    vscode.window.registerTreeDataProvider("lanes.agents", tree),
    vscode.window.registerTreeDataProvider("lanes.tasks", tasksTree),
    tasksChanged,
    vscode.window.registerTreeDataProvider("lanes.team", teamTree),
    teamChanged,
    vscode.commands.registerCommand("lanes.teamSay", teamSay),
    vscode.commands.registerCommand("lanes.teamAsk", teamAsk),
    vscode.commands.registerCommand("lanes.approveRequest", (node?: TeamNode) => decide(node?.kind === "request" ? node.request : undefined, "approve")),
    vscode.commands.registerCommand("lanes.denyRequest", (node?: TeamNode) => decide(node?.kind === "request" ? node.request : undefined, "deny")),
    vscode.commands.registerCommand("lanes.teamContextOn", () => switchTeamContext(true)),
    vscode.commands.registerCommand("lanes.teamContextOff", () => switchTeamContext(false)),
    vscode.commands.registerCommand("lanes.copySignInCommand", copySignIn),
    vscode.commands.registerCommand("lanes.openApp", openApp),
    vscode.commands.registerCommand("lanes.openTaskFile", async (node?: TaskNode) => {
      if (node?.kind !== "overlap") return;
      const file = node.overlap.files.find(safeRelPath);
      const root = file && folderFor(node.row.task.repo);
      if (!file || !root) return void vscode.window.showInformationMessage(`${node.overlap.files[0] ?? "That file"} is not in a folder you have open.`);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, file))).then(undefined, () => vscode.window.showInformationMessage(`${file} does not exist in your copy yet.`));
    }),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand("lanes.startServer", startServer),
    vscode.commands.registerCommand("lanes.stopServer", () => {
      if (!serverProc) return void vscode.window.showInformationMessage("No Lanes server was started from this VS Code window.");
      serverProc.kill();
    }),
    vscode.commands.registerCommand("lanes.setupRepository", setUp),
    vscode.commands.registerCommand("lanes.copyServerCommand", () => copy(teamServerCommand(context.extensionPath), "Copied. Run it in a terminal on the machine that hosts the team server.")),
    vscode.commands.registerCommand("lanes.copyJoinMessage", copyJoinMessage),
    vscode.commands.registerCommand("lanes.joinTeam", joinTeam),
    vscode.commands.registerCommand("lanes.reconnect", reconnect),
    vscode.commands.registerCommand("lanes.releaseLease", release),
    vscode.commands.registerCommand("lanes.statusClick", () => {
      if (snapshot) void vscode.commands.executeCommand(teamView(snapshot, me()).forMe.length > 0 ? "lanes.team.focus" : "lanes.agents.focus");
      else if (conn === "refused") void vscode.commands.executeCommand("workbench.action.openSettings", "lanes.token");
      else if (conn === "error") out.show?.();
      else if (conn !== "loading") startServer();
    }),
    vscode.commands.registerCommand("lanes.openAgentFile", openAgentFile),
    vscode.commands.registerCommand("lanes.reviewMerge", reviewMerge),
    vscode.commands.registerCommand("lanes.dismissMerge", dismissMerge),
    vscode.commands.registerCommand("lanes.showLog", () => out.show?.()),
    vscode.commands.registerCommand("lanes.openLease", async (lease: Lease) => {
      const root = folderFor(lease.repo);
      if (root && safeRelPath(lease.path)) await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, lease.path))).then(undefined, () => vscode.window.showInformationMessage(`${lease.path} does not exist in your copy yet.`));
    }),
    { dispose: () => { disposed = true; clearTimeout(timer); closeStream(); serverProc?.kill(); if (sharedDir) fs.rmSync(sharedDir, { recursive: true, force: true }); } },
  );
  readTeamContext();
  render();
  void poll();
}

export function deactivate(): void {}
