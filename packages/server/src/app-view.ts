// The browser app's view functions (ADR-0029): pure, self-contained, no imports beyond types. app.ts sends their source to
// the browser as is (see APP_JS there), and the CLI's MCP server reuses appView for team_status. Keep every function free of
// outside names: its `toString()` must run on its own in the page.
import type { AgentRequest, AgentStatus, ChatMessage, Snapshot } from "@lanes/core/types.ts";

export interface AppAgent {
  label: string;
  status: AgentStatus;
  task?: string;
  lastPath?: string;
  /** Files its task touched plus the ones it holds right now. */
  files: string[];
  /** Set while it waits for a file; `holder` is the person whose agent holds it, when known. */
  waitingFor?: { path: string; holder?: string };
}

export interface AppView {
  /** Repositories in the snapshot, most recent activity first. */
  repos: string[];
  repo: string;
  people: { user: string; mine: boolean; agents: AppAgent[] }[];
  /** Oldest first, so the newest is at the bottom. */
  chat: ChatMessage[];
  forMe: AgentRequest[];
  fromMe: AgentRequest[];
}

// Every function from here to HTML is self-contained (no outside names, no imports): its source is sent to the browser
// as is, see APP_JS.

/**
 * What the page shows for one person in one repository. The same rules as the VS Code views (groupByUser, teamView in
 * packages/extension/src/model.ts), restated because the server cannot depend on the extension.
 */
export function appView(snapshot: Snapshot, me: string, wanted?: string): AppView {
  const team = snapshot.team ?? { chat: [], requests: [] };
  const seen = new Map<string, number>();
  const touch = (repo: string, at: number) => seen.set(repo, Math.max(seen.get(repo) ?? 0, at));
  for (const a of snapshot.agents) touch(a.repo, a.lastSeen);
  for (const t of snapshot.tasks) touch(t.repo, t.doneAt ?? t.createdAt);
  for (const m of team.chat) touch(m.repo, m.at);
  for (const r of team.requests) touch(r.repo, r.decidedAt ?? r.createdAt);
  if (wanted && !seen.has(wanted)) seen.set(wanted, 0); // the repository `lanes app` was run in, even before anything happened there
  const repos = [...seen.keys()].sort((a, b) => seen.get(b)! - seen.get(a)! || a.localeCompare(b));
  const repo = wanted || repos[0] || "";
  const mine = (name: string) => name.toLowerCase() === me.toLowerCase();
  const groups = new Map<string, { user: string; mine: boolean; agents: AppAgent[] }>();
  for (const a of snapshot.agents.filter((x) => x.repo === repo)) {
    const task = snapshot.tasks.filter((t) => t.sessionId === a.sessionId && t.status === "active").at(-1);
    const held = snapshot.leases.filter((l) => l.holder === a.sessionId).map((l) => l.path);
    const waitingFor = a.status === "waiting" && a.blockedOn ? { path: a.blockedOn, holder: snapshot.leases.find((l) => l.repo === repo && l.path === a.blockedOn)?.user } : undefined;
    const group = groups.get(a.user) ?? { user: a.user, mine: mine(a.user), agents: [] };
    group.agents.push({ label: a.label, status: a.status, task: task?.title, lastPath: a.lastPath, files: [...new Set([...(task?.touched ?? []), ...held])], waitingFor });
    groups.set(a.user, group);
  }
  const requests = team.requests.filter((r) => r.repo === repo);
  return {
    repos,
    repo,
    people: [...groups.values()].sort((a, b) => Number(b.mine) - Number(a.mine) || a.user.localeCompare(b.user)),
    chat: team.chat.filter((m) => m.repo === repo).slice(-50),
    forMe: requests.filter((r) => mine(r.to) && r.status === "pending"),
    fromMe: requests.filter((r) => mine(r.from)).sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** Chat text cut into plain runs and @mentions, by the server's own mention rule (packages/team), for DOM text nodes. */
export function splitMentions(text: string): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/@[\p{L}\p{M}\p{N}_.-]+/gu)) {
    const tag = m[0].replace(/[.-]+$/, "");
    if (tag.length < 2) continue;
    if (m.index! > last) parts.push({ text: text.slice(last, m.index), mention: false });
    parts.push({ text: tag, mention: true });
    last = m.index! + tag.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}

/** One of 8 avatar colours, the same for a name on every screen and in every session. */
export function avatarTone(name: string): number {
  let h = 7;
  for (const c of name.toLowerCase()) h = (h * 31 + c.codePointAt(0)!) % 1000003;
  return h % 8;
}

/** "Ana Bianchi" → "AB", "bob" → "B". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const first = (w: string) => Array.from(w)[0] ?? "";
  return (words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0] ?? "")).toUpperCase() || "?";
}

/** Relative time for the past, as the UX principles ask: "just now", "8 min ago". */
export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
}

/** How long a request can still be answered: "~4 min left". */
export function timeLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "Expired";
  const m = Math.ceil(ms / 60000);
  return m < 60 ? "~" + m + " min left" : "~" + Math.round(m / 60) + " h left";
}

/** Consecutive messages from one person within 5 minutes form one group: one name and avatar, several bubbles. */
export function chatGroups(chat: ChatMessage[]): { user: string; at: number; messages: ChatMessage[] }[] {
  const groups: { user: string; at: number; messages: ChatMessage[] }[] = [];
  for (const m of chat) {
    const g = groups.at(-1);
    if (g && g.user.toLowerCase() === m.user.toLowerCase() && m.at - g.messages.at(-1)!.at < 300000) g.messages.push(m);
    else groups.push({ user: m.user, at: m.at, messages: [m] });
  }
  return groups;
}

/** People whose name, task, branch or files contain the query ("src/auth.ts"). Matching by name keeps all their agents. */
export function filterPeople(people: AppView["people"], query: string): AppView["people"] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  const has = (s?: string) => !!s && s.toLowerCase().includes(q);
  const out: AppView["people"] = [];
  for (const p of people) {
    if (has(p.user)) {
      out.push(p);
      continue;
    }
    const agents = p.agents.filter((a) => has(a.task) || has(a.label) || has(a.lastPath) || has(a.waitingFor?.path) || a.files.some((f) => has(f)));
    if (agents.length) out.push({ ...p, agents });
  }
  return out;
}

/** What one chat @mention of a person looks like: the server drops spaces from names ("Ana Bianchi" → @AnaBianchi). */
export function mentionTag(name: string): string {
  return "@" + name.replace(/\s+/g, "");
}

/** Messages from others after `since`, and how many of them mention me or @team. */
export function unreadSince(chat: ChatMessage[], since: number, me: string): { count: number; mentions: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  let count = 0;
  let mentions = 0;
  for (const m of chat) {
    if (m.at <= since || norm(m.user) === norm(me)) continue;
    count++;
    if (m.mentions.includes(norm(me)) || m.mentions.includes("team")) mentions++;
  }
  return { count, mentions };
}

/** Requests to me and chat mentions of me not in `seen` yet: what a browser notification or a toast announces. */
export function freshAlerts(view: AppView, me: string, seen: Record<string, boolean>): { id: string; title: string; body: string }[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const out: { id: string; title: string; body: string }[] = [];
  for (const r of view.forMe) if (!seen["r:" + r.id]) out.push({ id: "r:" + r.id, title: r.from + " asks your agent", body: r.text });
  for (const m of view.chat) {
    if (seen["m:" + m.id] || norm(m.user) === norm(me) || !(m.mentions.includes(norm(me)) || m.mentions.includes("team"))) continue;
    out.push({ id: "m:" + m.id, title: m.user + " mentioned " + (m.mentions.includes(norm(me)) ? "you" : "@team"), body: m.text });
  }
  return out;
}

/** The keyboard shortcuts, for the handler and the `?` sheet. */
export function shortcuts(): { keys: string; label: string; action: string }[] {
  return [
    { keys: "Ctrl K", label: "Search people, files and actions", action: "palette" },
    { keys: "/", label: "Write in the team chat", action: "chat" },
    { keys: "f", label: "Filter the team by name, task or file", action: "filter" },
    { keys: "j", label: "Next request in your inbox", action: "next" },
    { keys: "k", label: "Previous request in your inbox", action: "prev" },
    { keys: "a", label: "Approve the selected request", action: "approve" },
    { keys: "d", label: "Decline the selected request", action: "decline" },
    { keys: "g i", label: "Go to the inbox", action: "go-inbox" },
    { keys: "g t", label: "Go to the team", action: "go-team" },
    { keys: "g c", label: "Go to the team chat", action: "go-chat" },
    { keys: "g a", label: "Go to the activity", action: "go-activity" },
    { keys: "?", label: "Show these shortcuts", action: "help" },
    { keys: "Esc", label: "Close, or clear the filter", action: "close" },
  ];
}

/** One key press against the shortcut list: `g` waits for a second key. */
export function keyAction(list: { keys: string; action: string }[], pending: string, key: string): { action: string; pending: string } {
  if (pending === "g") return { action: list.find((s) => s.keys === "g " + key)?.action ?? "", pending: "" };
  if (key === "g") return { action: "", pending: "g" };
  return { action: list.find((s) => s.keys === key && key.length === 1)?.action ?? "", pending: "" };
}

export interface PaletteItem {
  action: string;
  value: string;
  label: string;
  hint: string;
}

/** Everything the command palette can do in this view. */
export function paletteItems(view: AppView, me: string): PaletteItem[] {
  const mine = (n: string) => n.toLowerCase() === me.toLowerCase();
  const items: PaletteItem[] = [{ action: "chat", value: "", label: "Message the team", hint: "Chat" }];
  for (const p of view.people) {
    items.push({ action: "person", value: p.user, label: mine(p.user) ? "Go to your agents" : "Go to " + p.user, hint: "Person" });
    if (mine(p.user)) continue;
    items.push({ action: "ask", value: p.user, label: "Ask " + p.user + "'s agent", hint: "Request" });
    items.push({ action: "mention", value: p.user, label: "Mention " + p.user + " in the chat", hint: "Chat" });
  }
  const files = new Set<string>();
  for (const p of view.people) for (const a of p.agents) for (const f of a.files) files.add(f);
  for (const f of files) items.push({ action: "file", value: f, label: "Who is on " + f, hint: "File" });
  for (const r of view.repos) if (r !== view.repo) items.push({ action: "repo", value: r, label: "Switch to " + r, hint: "Repository" });
  items.push({ action: "help", value: "", label: "Keyboard shortcuts", hint: "Help" });
  return items;
}

/** Palette matches, best first: start of the label, start of a word, anywhere, then the letters in order. */
export function paletteFilter(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: { item: PaletteItem; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const text = item.label.toLowerCase();
    const at = text.indexOf(q);
    let score = -1;
    if (at === 0) score = 3;
    else if (at > 0) score = /[\s/._@'-]/.test(text[at - 1]) ? 2 : 1;
    else {
      let j = 0;
      for (const c of text) if (c === q[j]) j++;
      if (j === q.length) score = 0;
    }
    if (score >= 0) scored.push({ item, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((s) => s.item);
}

/** Teammate names for the request composer: prefix matches first, the exact name hides the list. */
export function suggest(names: string[], typed: string, limit = 5): string[] {
  const q = typed.trim().replace(/^@/, "").toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const inside = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...inside].filter((n) => n.toLowerCase() !== q).slice(0, limit);
}

export interface TimelineItem {
  at: number;
  who: string;
  /** Show "who's agent" rather than "who". */
  agent: boolean;
  text: string;
  /** A title, request text or path, shown after the text. */
  subject?: string;
  tone: "start" | "done" | "wait" | "problem" | "ask" | "approved" | "declined" | "reply";
}

/** The last events of one repository, newest first, from what the snapshot holds: tasks, hook reports and requests. */
export function timeline(snapshot: Snapshot, repo: string, limit = 20): TimelineItem[] {
  const items: TimelineItem[] = [];
  const cut = (s: string) => (s.length > 90 ? s.slice(0, 89) + "…" : s);
  for (const t of snapshot.tasks) {
    if (t.repo !== repo) continue;
    items.push({ at: t.createdAt, who: t.user, agent: true, text: "started", subject: t.title, tone: "start" });
    if (t.doneAt) items.push({ at: t.doneAt, who: t.user, agent: true, text: "finished and published", subject: t.title, tone: "done" });
  }
  for (const e of snapshot.events) {
    if (e.repo !== repo) continue;
    const who = e.user || "An agent";
    const agent = !!e.user;
    const what = e.path || (e.paths && e.paths.length ? e.paths[0] + (e.paths.length > 1 ? " +" + (e.paths.length - 1) : "") : undefined);
    if (e.kind === "wait-overrun") {
      const s = Math.round((e.waitedMs ?? 0) / 1000);
      items.push({ at: e.at, who, agent, text: "waited " + (s < 60 ? s + " s" : Math.round(s / 60) + " min") + " for", subject: what, tone: "wait" });
    } else if (e.kind.startsWith("publish-")) items.push({ at: e.at, who, agent, text: "could not publish: " + e.kind.slice(8).replace(/-/g, " "), subject: what, tone: "problem" });
    else if (e.kind.startsWith("sync-")) items.push({ at: e.at, who, agent, text: "could not sync", subject: what, tone: "problem" });
    else if (e.kind === "reapply") items.push({ at: e.at, who, agent, text: "re-applied its edits to", subject: what, tone: "problem" });
    else if (e.kind === "status-failed") items.push({ at: e.at, who, agent, text: "could not read git status", tone: "problem" });
  }
  for (const r of snapshot.team?.requests ?? []) {
    if (r.repo !== repo) continue;
    items.push({ at: r.createdAt, who: r.from, agent: false, text: "asked " + r.to + "'s agent", subject: cut(r.text), tone: "ask" });
    if (r.decidedAt && r.status === "denied") items.push({ at: r.decidedAt, who: r.to, agent: false, text: "declined " + r.from + "'s request", tone: "declined" });
    else if (r.decidedAt && r.status !== "expired") items.push({ at: r.decidedAt, who: r.to, agent: false, text: "approved " + r.from + "'s request", tone: "approved" });
    if (r.repliedAt) items.push({ at: r.repliedAt, who: r.to, agent: true, text: "replied to " + r.from, tone: "reply" });
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** The tab icon, with a red count when something waits for me. Only digits go into the SVG. */
export function faviconBadge(count: number): string {
  const n = count > 9 ? "9+" : String(Math.max(0, Math.floor(count)));
  const mark = "<rect width='32' height='32' rx='8' fill='#181c28'/><path d='M9 6v20M16 6v20M23 6v20' stroke='#6e7896' stroke-width='2.4' stroke-linecap='round'/><path d='M9 12h7' stroke='#4f8cff' stroke-width='3' stroke-linecap='round'/><path d='M16 20h7' stroke='#ff963c' stroke-width='3' stroke-linecap='round'/>";
  const badge = count > 0 ? "<circle cx='23' cy='9' r='9' fill='#e5484d'/><text x='23' y='13' font-size='" + (n.length > 1 ? 10 : 12) + "' font-family='Arial,sans-serif' font-weight='700' text-anchor='middle' fill='#fff'>" + n + "</text>" : "";
  return "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" + mark + badge + "</svg>");
}

