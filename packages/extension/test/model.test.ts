import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Agent, Snapshot } from "@lanes/core/types.ts";
import { REQUEST_STATUS, timeLeft, agentDescription, agentIcon, agentTooltip, backoffMs, changedKeys, heldDecoration, md, mdCode, personColor, statusBar, statusTooltip, connectionFor, groupByUser, initials, leaseDescription, leaseFor, needsMerge, offlineTooltip, orphanLeases, problems, relativeTime, safeRelPath, statusBarText, taskBoard, taskDescription, teamView, overlapCount, uncoordinatedLine, viewState } from "../src/model.ts";

const agent = (user: string, sessionId: string, status: Agent["status"] = "idle", extra: Partial<Agent> = {}): Agent => ({
  user, sessionId, repo: "r", label: "app", status, edits: 0, startedAt: 0, lastSeen: 0, ...extra,
});
const snap = (agents: Agent[], leases: Snapshot["leases"] = [], tasks: Snapshot["tasks"] = []): Snapshot => ({ agents, leases, tasks, editors: {}, events: [], serverTime: 0 });

test("status bar shows offline, counts and waiting agents", () => {
  assert.equal(statusBarText(null), "Lanes: offline");
  assert.equal(statusBarText(snap([agent("A", "1")])), "Lanes: 1 agent");
  assert.equal(statusBarText(snap([agent("A", "1"), agent("B", "2", "waiting")])), "Lanes: 2 agents, 1 waiting");
});

test("groups put you first, then people alphabetically, with leases and the active task per agent", () => {
  const s = snap(
    [agent("Zed", "z"), agent("Bea", "b"), agent("Ana", "a1"), agent("Ana", "a2")],
    [{ repo: "r", path: "x.ts", holder: "a1", user: "Ana", acquiredAt: 0, expiresAt: 1 }],
    [
      { id: "t1", repo: "r", user: "Ana", sessionId: "a1", title: "old", predicted: [], touched: [], status: "done", createdAt: 0 },
      { id: "t2", repo: "r", user: "Ana", sessionId: "a1", title: "new", predicted: [], touched: [], status: "active", createdAt: 1 },
    ],
  );
  const groups = groupByUser(s, "Zed");
  assert.deepEqual(groups.map((g) => g.user), ["Zed", "Ana", "Bea"]);
  const ana = groups[1]!;
  assert.equal(ana.agents.length, 2);
  assert.equal(ana.agents[0]!.leases[0]!.path, "x.ts");
  assert.equal(ana.agents[0]!.task?.title, "new");
  assert.equal(ana.agents[1]!.task, undefined);
});

test("leaseFor matches repo and path exactly", () => {
  const s = snap([], [{ repo: "r", path: "a/b.ts", holder: "h", user: "U", acquiredAt: 0, expiresAt: 1 }]);
  assert.ok(leaseFor(s, "r", "a/b.ts"));
  assert.equal(leaseFor(s, "r", "a/B.ts"), undefined);
  assert.equal(leaseFor(s, "other", "a/b.ts"), undefined);
  assert.equal(leaseFor(null, "r", "a/b.ts"), undefined);
});

test("initials handle one name, two names, extra spaces and empty", () => {
  assert.equal(initials("Ana"), "AN");
  assert.equal(initials("  ana  maria  rossi "), "AR");
  assert.equal(initials(""), "?");
});

test("relative time and descriptions", () => {
  assert.equal(relativeTime(0, 30_000), "just now", "the same words as the browser app");
  assert.equal(relativeTime(0, 50_000), "1 min ago");
  assert.equal(relativeTime(0, 8 * 60_000), "8 min ago");
  assert.equal(relativeTime(0, 3 * 3600_000), "3 h ago");
  assert.equal(relativeTime(0, 50 * 3600_000), "2 d ago");
  assert.equal(timeLeft(10 * 60_000, 6 * 60_000 + 1), "~4 min left");
  assert.equal(timeLeft(0, 1), "Expired");
  assert.equal(REQUEST_STATUS.denied, "Declined");
  assert.equal(agentDescription({ agent: agent("A", "1", "waiting", { blockedOn: "a.ts" }), leases: [] }, 0), "waiting on a.ts · just now");
  assert.equal(agentDescription({ agent: agent("A", "1", "working", { lastPath: "b.ts" }), leases: [] }, 0), "editing b.ts · just now");
});

test("problems lists recent flagged observations, newest first, once per user, kind and file", () => {
  const ev = (at: number, kind: string, extra: object = {}) => ({ at, kind, user: "Ana", ...extra });
  const s = { ...snap([]), events: [ev(1_000, "sync-failed"), ev(2_000, "sync-failed"), ev(3_000, "publish-add-failed", { paths: ["a.bin"] }), ev(4_000, "synced"), ev(5_000, "wait-overrun", { path: "x.ts" })] };
  const list = problems(s, 6_000);
  assert.deepEqual(list.map((p) => p.event.kind), ["wait-overrun", "publish-add-failed", "sync-failed"]);
  assert.equal(list[2]!.event.at, 2_000, "the repeat refreshed the entry");
  assert.deepEqual(problems(s, 6_000 + 31 * 60_000), [], "old ones fade");
  assert.deepEqual(problems(null, 0), []);
  assert.equal(problems({ ...snap([]), events: undefined } as unknown as Snapshot, 0).length, 0, "an older server without events");
});

test("backoff doubles from the base and stops at the maximum", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 1000, 15_000)), [1000, 1000, 2000, 4000, 8000, 15_000, 15_000]);
});

test("orphanLeases are leases whose session has no registered agent", () => {
  const lease = (holder: string) => ({ repo: "r", path: holder + ".ts", holder, user: "U", acquiredAt: 0, expiresAt: 1 });
  const s = snap([agent("A", "alive")], [lease("alive"), lease("ghost")]);
  assert.deepEqual(orphanLeases(s).map((l) => l.holder), ["ghost"]);
  assert.deepEqual(orphanLeases(null), []);
});

const ev = (at: number, kind: string, extra: object = {}) => ({ at, kind, user: "Bea", repo: "r", sessionId: "b1", ...extra });

test("needs merge: only the kinds that leave edits unshared, merged per user and kind, newest first, hidden once marked", () => {
  const s = { ...snap([agent("Bea", "b1")]), events: [ev(1_000, "publish-blocked", { paths: ["a.ts"] }), ev(2_000, "publish-blocked", { paths: ["b.ts", "a.ts"] }), ev(3_000, "publish-conflict", { error: "rebase in progress" }), ev(4_000, "sync-failed"), ev(5_000, "publish-add-failed")] };
  const items = needsMerge(s, 6_000);
  assert.deepEqual(items.map((i) => i.title.slice(0, 20)), ["Edits kept local: a ", "Edits kept local: th"]);
  assert.deepEqual(items.find((i) => i.paths.length)?.paths, ["a.ts", "b.ts"]);
  assert.equal(items.find((i) => !i.paths.length)?.at, 3_000);
  const blocked = items.find((i) => i.paths.length)!;
  assert.equal(needsMerge(s, 6_000, new Map([[blocked.key, 2_000]])).length, 1, "marked as merged");
  const later = { ...s, events: [...s.events, ev(7_000, "publish-blocked", { paths: ["c.ts"] })] };
  assert.equal(needsMerge(later, 8_000, new Map([[blocked.key, 2_000]])).length, 2, "something newer brings it back");
  assert.deepEqual(needsMerge(s, 6_000 + 7 * 3600_000), [], "old ones fade");
  assert.deepEqual(needsMerge(null, 0), []);
  assert.equal(problems(s, 6_000).some((p) => p.event.kind.startsWith("publish-blocked")), false, "not listed twice");
});

test("an agent needs merge when an item names its session, or its user and repository when it names none", () => {
  const s = { ...snap([agent("Bea", "b1"), agent("Bea", "b2"), agent("Cy", "c1")]), events: [ev(1_000, "publish-blocked", { paths: ["a.ts"] }), ev(2_000, "publish-conflict", { sessionId: undefined })] };
  const rows = groupByUser(s, "Bea", needsMerge(s, 3_000)).flatMap((g) => g.agents);
  assert.deepEqual(rows.map((r) => [r.agent.sessionId, r.merge?.title.slice(0, 20)]), [["b1", "Edits kept local: th"], ["b2", "Edits kept local: a "], ["c1", undefined]]);
  assert.match(agentDescription(rows[0]!, 0), /^needs merge · /);
  assert.match(agentTooltip(rows[0]!, 0), /Nothing is lost/);
});

test("paths from the server are opened only inside a checkout", () => {
  for (const ok of ["a.ts", "src/a b.ts", "dir/..name/x"]) assert.ok(safeRelPath(ok), ok);
  for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "C:\\x", "C:/x", "\\\\host\\share", "a\\..\\b", "a\0b"]) assert.ok(!safeRelPath(bad), bad);
});

test("the view says what is wrong: connecting, offline, refused token, server error, empty team, or content", () => {
  assert.equal(connectionFor(undefined), "offline");
  assert.equal(connectionFor(401), "refused");
  assert.equal(connectionFor(403), "refused");
  assert.equal(connectionFor(500), "error");
  assert.equal(viewState("loading", false), "loading");
  assert.equal(viewState("online", false), "empty");
  assert.equal(viewState("online", true), "ready");
  assert.equal(viewState("offline", true), "offline", "stale content is never shown as live");
  assert.equal(statusBarText(null, "loading"), "Lanes: connecting…");
  assert.equal(statusBarText(null, "refused"), "Lanes: token refused");
  assert.equal(statusBarText(null, "error"), "Lanes: server error");
  for (const c of ["loading", "offline", "refused", "error"] as const) assert.ok(offlineTooltip(c).length > 10);
  assert.match(offlineTooltip("offline"), /^Coordination paused: .*Edits still go ahead/, "never silent about coordination being off (M6)");
  assert.match(offlineTooltip("refused"), /lanes login or lanes join/);
});

test("a lease hints that it may be stuck when its holder has been quiet for over 2 minutes", () => {
  const lease = { repo: "r", path: "src/api.ts", holder: "a", user: "Ana", acquiredAt: 0, expiresAt: 1 };
  assert.equal(leaseDescription(lease, agent("Ana", "a", "idle", { lastSeen: 0 }), 60_000), "src");
  assert.equal(leaseDescription(lease, agent("Ana", "a", "idle", { lastSeen: 0 }), 8 * 60_000), "src · no activity for 8 min");
  assert.equal(leaseDescription({ ...lease, path: "x.ts" }, undefined, 1e9), "");
});

const task = (id: string, user: string, sessionId: string, files: string[], extra: Partial<Snapshot["tasks"][number]> = {}) =>
  ({ id, repo: "r", user, sessionId, title: `task ${id}`, predicted: files, touched: [], status: "active" as const, createdAt: Number(id.slice(1)), ...extra });

test("task board: per person, you first, active newest first, three finished at most, overlaps flagged both ways", () => {
  const s = snap([], [], [
    task("t1", "Ana", "a1", ["src/auth.ts", "src/x.ts"]),
    task("t2", "Bea", "b1", ["src/auth.ts"], { touched: ["src/y.ts", "src/x.ts"] }),
    task("t3", "Ana", "a2", ["lonely.ts"]),
    task("t4", "Ana", "a1", ["src/auth.ts"], { status: "done", doneAt: 40 }),
    task("t5", "Ana", "a1", [], { status: "done", doneAt: 50 }),
    task("t6", "Ana", "a1", [], { status: "done", doneAt: 60 }),
    task("t7", "Ana", "a1", [], { status: "done", doneAt: 70 }),
  ]);
  const board = taskBoard(s, "Bea");
  assert.deepEqual(board.map((g) => g.user), ["Bea", "Ana"]);
  const ana = board[1]!.tasks;
  assert.deepEqual(ana.map((r) => r.task.id), ["t3", "t1", "t7", "t6", "t5"], "active first (newest first), then the three latest finished");
  const t1 = ana.find((r) => r.task.id === "t1")!;
  assert.deepEqual(t1.overlaps.map((o) => [o.task.id, o.files]), [["t2", ["src/auth.ts", "src/x.ts"]]]);
  assert.deepEqual(board[0]!.tasks[0]!.overlaps.map((o) => [o.task.id, o.files]), [["t1", ["src/auth.ts", "src/x.ts"]]], "the other side sees it too");
  assert.deepEqual(ana.find((r) => r.task.id === "t3")!.overlaps, []);
  assert.equal(ana.find((r) => r.task.status === "done")!.overlaps.length, 0, "a finished task is never flagged");
  assert.equal(overlapCount(board), 2);
  assert.equal(taskDescription(t1, 0), "overlaps with Bea on 2 files · 2 files");
  assert.equal(taskDescription(ana[0]!, 0), "working · 1 file");
  assert.equal(taskDescription(ana[2]!, 10_070), "done just now · 0 files");
});

test("task board: tasks of one agent, or of different repositories, never overlap; no snapshot is an empty board", () => {
  const s = snap([], [], [task("t1", "Ana", "a1", ["f.ts"]), task("t2", "Ana", "a1", ["f.ts"]), task("t3", "Bea", "b1", ["f.ts"], { repo: "other" })]);
  assert.equal(overlapCount(taskBoard(s, "Ana")), 0);
  assert.deepEqual(taskBoard(null, "Ana"), []);
  assert.deepEqual(taskBoard({ ...s, tasks: undefined } as unknown as Snapshot, "Ana"), []);
});

test("the status bar tooltip says how many edits went ahead uncoordinated this week, only when there are some (#223)", () => {
  assert.equal(uncoordinatedLine(null), "");
  assert.equal(uncoordinatedLine(snap([])), "");
  assert.equal(uncoordinatedLine({ ...snap([]), uncoordinated: { a: 1 } }), "1 edit went ahead uncoordinated this week (the server was unreachable)");
  assert.match(uncoordinatedLine({ ...snap([]), uncoordinated: { a: 2, b: 3 } }), /^5 edits went ahead uncoordinated this week/);
});

test("team view: pending requests to you (any case), your own requests, newest chat first; no team data is empty", () => {
  const req = (from: string, to: string, status: "pending" | "approved") => ({ id: from + to, repo: "r", from, to, text: "t", scope: "read" as const, status, createdAt: 0, expiresAt: 1 });
  const s = { ...snap([]), team: { requests: [req("Bea", "ana", "pending"), req("Bea", "Ana", "approved"), req("Ana", "Bea", "pending")], chat: [1, 2].map((at) => ({ id: String(at), repo: "r", user: "Bea", text: `m${at}`, mentions: [], at })) } };
  const v = teamView(s, "Ana");
  assert.deepEqual(v.forMe.map((r) => r.id), ["Beaana"]);
  assert.deepEqual(v.fromMe.map((r) => r.id), ["AnaBea"]);
  assert.deepEqual(v.chat.map((m) => m.text), ["m2", "m1"]);
  assert.deepEqual(teamView(null, "Ana"), { forMe: [], fromMe: [], chat: [] });
});

test("person colours are stable theme colours from the name; you are always blue; red is kept for problems (#263)", () => {
  assert.equal(personColor("Ana", true), "charts.blue");
  for (const name of ["Ana", "Bea", "Carl", "Dan", "émile", ""]) {
    assert.equal(personColor(name), personColor(name), "deterministic");
    assert.equal(personColor(` ${name.toUpperCase()} `), personColor(name), "case and spaces do not change it");
    assert.match(personColor(name), /^(charts\.(purple|orange)|terminal\.ansi(Magenta|Cyan))$/);
  }
  assert.ok(new Set(["Ana", "Bea", "Carl", "Dan", "Eve", "Finn"].map((n) => personColor(n))).size > 2, "people get different colours");
});

test("agent icons: red needs merge, amber waits, green works, muted idle (#263)", () => {
  const row = (status: Agent["status"], merge = false) => ({ agent: agent("A", "1", status), leases: [], merge: merge ? ({} as never) : undefined });
  assert.deepEqual(agentIcon(row("working")), ["pulse", "charts.green"]);
  assert.deepEqual(agentIcon(row("waiting")), ["watch", "charts.yellow"]);
  assert.deepEqual(agentIcon(row("blocked")), ["watch", "charts.yellow"]);
  assert.deepEqual(agentIcon(row("idle")), ["circle-outline", "disabledForeground"]);
  assert.deepEqual(agentIcon(row("working", true)), ["git-merge", "charts.red"]);
});

test("Explorer decoration: initials, a contributed colour and a plain tooltip; nothing for a file nobody holds (#263)", () => {
  const lease = { repo: "r", path: "src/a.ts", holder: "h", user: "Ana Rossi", acquiredAt: 0, expiresAt: 1 };
  assert.deepEqual(heldDecoration(lease, "Bea"), { badge: "AR", tooltip: "Held by Ana Rossi's agent — your agent will wait for it", color: "lanes.heldByTeammate" });
  const mine = heldDecoration(lease, "Ana Rossi")!;
  assert.equal(mine.color, "lanes.heldByYou");
  assert.match(mine.tooltip, /^Held by your agent/);
  assert.equal(heldDecoration(undefined, "Bea"), undefined);
  assert.ok(heldDecoration({ ...lease, user: "bartholomew" }, "x")!.badge.length <= 2);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const colors = manifest.contributes.colors.map((c: { id: string; defaults: object }) => [c.id, Object.keys(c.defaults).sort().join()]);
  assert.deepEqual(colors, [["lanes.heldByTeammate", "dark,highContrast,highContrastLight,light"], ["lanes.heldByYou", "dark,highContrast,highContrastLight,light"]]);
});

test("only files whose holder changed get their decoration refreshed (#263)", () => {
  const prev = new Map([["a", "Ana"], ["b", "Bea"], ["c", "Cy"]]);
  const next = new Map([["a", "Ana"], ["b", "Dan"], ["d", "Eve"]]);
  assert.deepEqual(changedKeys(prev, next).sort(), ["b", "c", "d"]);
  assert.deepEqual(changedKeys(next, next), []);
});

test("status bar: pulse when running, amber with waiting agents, red only for needs merge, 'Lanes: offline' when unreachable (#263)", () => {
  assert.deepEqual(statusBar(null, "offline"), { text: "$(debug-disconnect) Lanes: offline", background: undefined });
  assert.deepEqual(statusBar(null, "loading"), { text: "$(sync~spin) Lanes: connecting…", background: undefined });
  assert.equal(statusBar(null, "refused").background, "statusBarItem.warningBackground");
  assert.deepEqual(statusBar(snap([agent("A", "1", "working")]), "online"), { text: "$(pulse) Lanes: 1 agent", background: undefined });
  assert.deepEqual(statusBar(snap([agent("A", "1"), agent("B", "2", "waiting")]), "online"), { text: "$(watch) Lanes: 2 agents, 1 waiting", background: "statusBarItem.warningBackground" });
  assert.deepEqual(statusBar(snap([agent("A", "1")]), "online", 2, 1), { text: "$(pulse) Lanes: 1 agent $(warning) 2", background: "statusBarItem.errorBackground" });
});

test("status bar tooltip: who does what, in Markdown, with names escaped so they cannot add links (#263)", () => {
  const s = snap([agent("Ana", "a", "working", { lastPath: "src/auth.ts" }), agent("[x](command:evil)", "b", "waiting", { blockedOn: "src/auth.ts" })], [{ repo: "r", path: "src/auth.ts", holder: "a", user: "Ana", acquiredAt: 0, expiresAt: 1 }]);
  const tip = statusTooltip(s, "online", { me: "Ana", now: 0, merges: [], problems: [], orphans: [], overlaps: 1 });
  assert.match(tip, /\*\*Your\*\* agent is editing `src\/auth\.ts`/);
  assert.match(tip, /waits for `src\/auth\.ts`/);
  assert.match(tip, /1 file is held right now/);
  assert.match(tip, /1 task overlaps another/);
  assert.ok(!tip.includes("[x](command:evil)"), "escaped");
  assert.match(statusTooltip(null, "offline", { me: "Ana", now: 0, merges: [], problems: [], orphans: [], overlaps: 0 }), /command:lanes\.startServer/);
  assert.equal(md("a_b*c"), "a\\_b\\*c");
  assert.equal(mdCode("a`b"), "`a'b`");
});

test("status bar and its hover count the requests waiting for you, with a link to the Team view", () => {
  const s = snap([agent("A", "1")]);
  assert.equal(statusBar(s, "online", 0, 0, 2).text, "$(pulse) Lanes: 1 agent $(inbox) 2");
  assert.equal(statusBar(null, "offline", 0, 0, 2).text, "$(debug-disconnect) Lanes: offline");
  const extra = { me: "A", now: 0, merges: [], problems: [], orphans: [], overlaps: 0 };
  assert.match(statusTooltip(s, "online", { ...extra, inbox: 1 }), /\$\(inbox\) 1 request is waiting for you: \[open the Team view\]\(command:lanes\.team\.focus\)/);
  assert.doesNotMatch(statusTooltip(s, "online", extra), /waiting for you/);
});
