// ADR-0029: the browser app at /app. Static files need no token but keep the Host check; teammate text never becomes markup.
import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import {
  APP_FILES, APP_JS, appView, avatarTone, chatGroups, faviconBadge, filterPeople, freshAlerts, initials, keyAction, mentionTag, paletteFilter, paletteItems,
  shortcuts, splitMentions, suggest, timeAgo, timeLeft, timeline, unreadSince,
} from "../src/app.ts";
import { startServer } from "../src/server.ts";
import type { Snapshot } from "@lanes/core/types.ts";

function get(port: string, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", reject).end();
  });
}

test("/app and /app.js are served without a token, with a strict CSP; the API still needs the token; a foreign Host is refused", async () => {
  const server = await startServer({ port: 0, token: "t" });
  try {
    const port = new URL(server.url).port;
    const page = await get(port, "/app");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"] ?? "", /^text\/html/);
    assert.match(String(page.headers["content-security-policy"]),/default-src 'none'; script-src 'self';.*frame-ancestors 'none'/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.body, /<script src="\/app.js" defer><\/script>/);
    assert.doesNotMatch(page.body, /<script>|<style>| on\w+=| style=/, "nothing inline: the CSP would block it");

    const js = await get(port, "/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"] ?? "", /^text\/javascript/);
    assert.equal((await get(port, "/app.css")).status, 200);
    for (const file of ["/app", "/app.js", "/app.css"]) {
      const head = await get(port, file, {}, "HEAD");
      assert.equal(head.status, 200, `HEAD ${file} answers like GET`);
      assert.equal(head.body, "");
      assert.equal(head.headers["content-type"], APP_FILES[file].headers["content-type"]);
      assert.match(String(head.headers["content-security-policy"]), /default-src 'none'/);
    }

    assert.equal((await get(port, "/app", { host: "evil.example" })).status, 403);
    assert.equal((await get(port, "/v1/state")).status, 401);
    assert.equal((await get(port, "/v1/state", { authorization: "Bearer t" })).status, 200);
    assert.equal((await get(port, "/app.json")).status, 401, "only the listed files skip the token");
  } finally {
    await server.close();
  }
});

test("the page script parses, never writes HTML, and sends the view functions as plain JavaScript", () => {
  new Function(APP_JS); // throws on a syntax error, e.g. type annotations left in a helper's source
  assert.doesNotMatch(APP_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\("(style|on)/);
  for (const name of ["appView", "splitMentions", "avatarTone", "initials", "timeAgo", "timeLeft", "chatGroups", "filterPeople", "mentionTag", "unreadSince", "freshAlerts", "shortcuts", "keyAction", "paletteItems", "paletteFilter", "suggest", "timeline", "faviconBadge"]) {
    assert.ok(APP_JS.includes(`const ${name} = (`), name);
  }
});

test("v3 invariants: same CSP, no inline anything, no outside URL, notifications only on a click, teammate text only as text", () => {
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  for (const f of Object.values(APP_FILES)) assert.equal(f.headers["content-security-policy"], csp, "the CSP is unchanged");
  const html = APP_FILES["/app"].body;
  const css = APP_FILES["/app.css"].body;
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=|<script>|<style/i);
  assert.match(html, /<dialog id="palette"/);
  assert.match(html, /<dialog id="help"/);
  // Only the SVG namespace (never fetched) and the GitHub device page the sign-in links to.
  const urls = [html, APP_JS, css].join("\n").match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  for (const u of urls) assert.ok(u === "http://www.w3.org/2000/svg" || u.startsWith("https://github.com/login/device"), `unexpected URL ${u}`);
  assert.doesNotMatch(APP_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.style\.|setAttribute\("style|\.cssText/);
  assert.doesNotMatch(APP_JS, /\b(import|fetch)\(\s*"https?:/);
  // The permission prompt only ever comes from the bell's click handler.
  assert.equal(APP_JS.split("Notification.requestPermission").length - 1, 1);
  assert.match(APP_JS, /\$\("notify"\)\.onclick = toggleNotify;/);
  assert.match(APP_JS, /function toggleNotify\(\) \{[\s\S]*Notification\.requestPermission/);
  // Undo is only offered for page state: never next to a call that changes the server.
  for (const m of APP_JS.matchAll(/action: "Undo", run: function \(\) \{([^}]*)\}/g)) assert.doesNotMatch(m[1], /post\(|fetch\(/, m[1]);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /@import|url\(|fonts\.googleapis/);
});

test("the page: no inline script, style or handler, a sign-in screen, and honest status lines", () => {
  const html = APP_FILES["/app"].body;
  assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son[a-z]+=/i, "nothing the CSP would block");
  assert.match(html, /id="signin"[^>]*hidden/);
  assert.match(html, /id="gh-start"[^>]*>.*Sign in with GitHub/);
  assert.match(html, /id="gh-link"[^>]*target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Or run <code>lanes app<\/code> in a terminal to open a signed-in link\./);
  assert.match(html, /<link id="favicon" rel="icon" href="data:image\/svg\+xml,/, "a data: icon, which img-src allows");
  assert.ok(APP_JS.includes("Coordination paused: the Lanes server can't be reached. Edits go ahead uncoordinated."));
  assert.ok(APP_JS.includes("Live updates paused, retrying…"));
  assert.ok(APP_JS.includes('"/v1/login/config"') && APP_JS.includes('"/v1/login/github/poll"'));
  assert.doesNotMatch(APP_FILES["/app.css"].body, /@import|url\(|fonts\.googleapis/, "no external fonts or images");
});

test("helpers the page uses: mentions, avatar colour, initials, relative times, chat groups", () => {
  const evil = "<img src=x onerror=alert(1)>";
  assert.deepEqual(splitMentions(`hi @bea, see @team. ${evil}`), [
    { text: "hi ", mention: false }, { text: "@bea", mention: true }, { text: ", see ", mention: false }, { text: "@team", mention: true }, { text: `. ${evil}`, mention: false },
  ]);
  assert.deepEqual(splitMentions("no mention @ here"), [{ text: "no mention @ here", mention: false }]);
  assert.deepEqual(splitMentions("@José-"), [{ text: "@José", mention: true }, { text: "-", mention: false }], "the server's rule: a trailing - or . is not part of it");

  assert.equal(avatarTone("Ana"), avatarTone("ana"), "the same colour whatever the case");
  assert.ok(new Set(["ana", "bob", "cy", "dee", "eve", "fil", "gus", "hal", "ivy", "jo"].map(avatarTone)).size >= 4, "names spread over the palette");
  for (const n of ["", "x", "Zoë Ł"]) assert.ok(avatarTone(n) >= 0 && avatarTone(n) < 8);

  assert.equal(initials("Ana Bianchi"), "AB");
  assert.equal(initials("bob"), "B");
  assert.equal(initials("mario.rossi"), "MR");
  assert.equal(initials("  "), "?");

  const now = 10_000_000;
  assert.equal(timeAgo(now - 10_000, now), "just now");
  assert.equal(timeAgo(now - 8 * 60_000, now), "8 min ago");
  assert.equal(timeAgo(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(timeAgo(now - 2 * 86_400_000, now), "2 d ago");
  assert.equal(timeAgo(now + 5_000, now), "just now", "a clock slightly ahead is not the future");
  assert.equal(timeLeft(now + 4 * 60_000, now), "~4 min left");
  assert.equal(timeLeft(now + 10_000, now), "~1 min left");
  assert.equal(timeLeft(now + 2 * 3_600_000, now), "~2 h left");
  assert.equal(timeLeft(now, now), "Expired");

  const msg = (id: string, user: string, at: number) => ({ id, repo: "r", user, text: id, mentions: [], at });
  const groups = chatGroups([msg("1", "ana", 0), msg("2", "Ana", 60_000), msg("3", "bob", 70_000), msg("4", "ana", 80_000), msg("5", "ana", 80_000 + 6 * 60_000)]);
  assert.deepEqual(groups.map((g) => [g.user, g.messages.map((m) => m.id)]), [["ana", ["1", "2"]], ["bob", ["3"]], ["ana", ["4"]], ["ana", ["5"]]]);
});

const base: Snapshot = { agents: [], leases: [], tasks: [], editors: {}, events: [], serverTime: 0 };
const agent = (user: string, repo: string, extra: Partial<Snapshot["agents"][number]> = {}) => ({ user, sessionId: `${user}-s`, repo, label: "app", status: "working" as const, edits: 0, startedAt: 0, lastSeen: 0, ...extra });

test("appView: the most recently active repository by default, people with tasks, files and who they wait for", () => {
  const snap: Snapshot = {
    ...base,
    agents: [agent("bob", "r1", { status: "waiting", blockedOn: "src/a.ts", lastSeen: 10 }), agent("Ana", "r1", { lastSeen: 20 }), agent("cy", "r2", { lastSeen: 5 })],
    leases: [{ repo: "r1", path: "src/a.ts", holder: "Ana-s", user: "Ana", acquiredAt: 0, expiresAt: 1 }],
    tasks: [{ id: "t", repo: "r1", user: "Ana", sessionId: "Ana-s", title: "Fix login", predicted: [], touched: ["src/b.ts"], status: "active", createdAt: 1 }],
  };
  const v = appView(snap, "bob");
  assert.deepEqual(v.repos, ["r1", "r2"]);
  assert.equal(v.repo, "r1");
  assert.deepEqual(v.people.map((p) => [p.user, p.mine]), [["bob", true], ["Ana", false]]);
  assert.deepEqual(v.people[0].agents[0].waitingFor, { path: "src/a.ts", holder: "Ana" });
  assert.equal(v.people[1].agents[0].task, "Fix login");
  assert.deepEqual(v.people[1].agents[0].files, ["src/b.ts", "src/a.ts"]);
  assert.equal(appView(snap, "bob", "r2").people[0].user, "cy");
  assert.deepEqual(appView(snap, "bob", "new").repos, ["r1", "r2", "new"], "the repository lanes app was run in is listed even when empty");
});

test("appView: chat oldest first and kept as plain text; requests split into for me and from me", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const snap: Snapshot = {
    ...base,
    team: {
      chat: [
        { id: "1", repo: "r", user: "ana", text: "first", mentions: [], at: 1 },
        { id: "2", repo: "r", user: "ana", text: evil, mentions: [], at: 2 },
        { id: "3", repo: "other", user: "ana", text: "elsewhere", mentions: [], at: 0 },
      ],
      requests: [
        { id: "a", repo: "r", from: "ana", to: "Bob", text: evil, scope: "read", status: "pending", createdAt: 1, expiresAt: 9 },
        { id: "b", repo: "r", from: "bob", to: "ana", text: "x", scope: "edit", status: "approved", createdAt: 2, expiresAt: 9, reply: "done" },
        { id: "c", repo: "r", from: "ana", to: "bob", text: "y", scope: "read", status: "denied", createdAt: 3, expiresAt: 9 },
      ],
    },
  };
  const v = appView(snap, "bob");
  assert.deepEqual(v.chat.map((m) => m.text), ["first", evil], "the exact text, for textContent: not escaped, not parsed");
  assert.deepEqual(v.forMe.map((r) => r.id), ["a"]);
  assert.deepEqual(v.fromMe.map((r) => r.id), ["b"]);
});

const person = (user: string, mine: boolean, agents: Partial<ReturnType<typeof appView>["people"][number]["agents"][number]>[]) => ({
  user, mine, agents: agents.map((a) => ({ label: "main", status: "working" as const, files: [], ...a })),
});

test("filterPeople: by name, task, branch or file; a name match keeps every agent", () => {
  const people = [
    person("Ana Bianchi", false, [{ task: "Add OAuth login", files: ["src/auth.ts"] }, { label: "docs", files: ["README.md"] }]),
    person("bob", true, [{ label: "fix/expiry", waitingFor: { path: "src/auth.ts", holder: "Ana Bianchi" } }]),
    person("cy", false, [{ files: ["src/billing.ts"] }]),
  ];
  assert.equal(filterPeople(people, "  "), people);
  assert.deepEqual(filterPeople(people, "SRC/AUTH.ts").map((p) => [p.user, p.agents.length]), [["Ana Bianchi", 1], ["bob", 1]], "who is touching src/auth.ts, waiting included");
  assert.deepEqual(filterPeople(people, "bianchi").map((p) => p.agents.length), [2]);
  assert.deepEqual(filterPeople(people, "oauth").map((p) => p.user), ["Ana Bianchi"]);
  assert.deepEqual(filterPeople(people, "expiry").map((p) => p.user), ["bob"]);
  assert.deepEqual(filterPeople(people, "nothing"), []);
});

test("mentions and unread: the server's rule for names with spaces, @team counts, my own messages never do", () => {
  assert.equal(mentionTag("Ana Bianchi"), "@AnaBianchi");
  assert.deepEqual(splitMentions(mentionTag("Ana Bianchi") + " hi").map((p) => p.mention), [true, false]);
  const chat = [
    { id: "1", repo: "r", user: "ana", text: "old", mentions: [], at: 1 },
    { id: "2", repo: "r", user: "ana", text: "@bobby hi", mentions: ["bobby"], at: 5 },
    { id: "3", repo: "r", user: "Bob By", text: "mine", mentions: ["team"], at: 6 },
    { id: "4", repo: "r", user: "cy", text: "@team", mentions: ["team"], at: 7 },
    { id: "5", repo: "r", user: "cy", text: "plain", mentions: [], at: 8 },
  ];
  assert.deepEqual(unreadSince(chat, 1, "Bob By"), { count: 3, mentions: 2 });
  assert.deepEqual(unreadSince(chat, 8, "Bob By"), { count: 0, mentions: 0 });

  const view = { repos: ["r"], repo: "r", people: [], chat, fromMe: [], forMe: [{ id: "q", repo: "r", from: "ana", to: "bobby", text: "look", scope: "read" as const, status: "pending" as const, createdAt: 1, expiresAt: 2 }] };
  const alerts = freshAlerts(view, "Bob By", {});
  assert.deepEqual(alerts.map((a) => [a.id, a.title]), [["r:q", "ana asks your agent"], ["m:2", "ana mentioned you"], ["m:4", "cy mentioned @team"]]);
  assert.deepEqual(freshAlerts(view, "Bob By", { "r:q": true, "m:2": true, "m:4": true }), [], "seen once, announced once");
});

test("shortcuts: one action per key, g waits for a second key, the sheet lists every key", () => {
  const list = shortcuts();
  assert.equal(new Set(list.map((s) => s.keys)).size, list.length, "no key twice");
  for (const k of ["/", "a", "d", "g t", "g c", "?", "Esc", "Ctrl K"]) assert.ok(list.some((s) => s.keys === k), k);
  assert.deepEqual(keyAction(list, "", "/"), { action: "chat", pending: "" });
  assert.deepEqual(keyAction(list, "", "a"), { action: "approve", pending: "" });
  assert.deepEqual(keyAction(list, "", "d"), { action: "decline", pending: "" });
  assert.deepEqual(keyAction(list, "", "g"), { action: "", pending: "g" });
  assert.deepEqual(keyAction(list, "g", "t"), { action: "go-team", pending: "" });
  assert.deepEqual(keyAction(list, "g", "c"), { action: "go-chat", pending: "" });
  assert.deepEqual(keyAction(list, "g", "x"), { action: "", pending: "" });
  assert.deepEqual(keyAction(list, "", "Escape"), { action: "", pending: "" }, "Esc is handled by the page and the dialogs");
  assert.deepEqual(keyAction(list, "", "A"), { action: "", pending: "" }, "Shift+A is not a");
});

test("palette: people, asks, mentions, files and repositories; best matches first", () => {
  const view = {
    repos: ["r", "other"], repo: "r", chat: [], forMe: [], fromMe: [],
    people: [person("bea", true, [{ files: ["src/a.ts"] }]), person("Ana Bianchi", false, [{ files: ["src/auth.ts", "src/a.ts"] }])],
  };
  const items = paletteItems(view, "bea");
  assert.deepEqual(items.map((i) => i.label), [
    "Message the team", "Go to your agents", "Go to Ana Bianchi", "Ask Ana Bianchi's agent", "Mention Ana Bianchi in the chat",
    "Who is on src/a.ts", "Who is on src/auth.ts", "Switch to other", "Keyboard shortcuts",
  ]);
  assert.deepEqual(paletteFilter(items, "ask").map((i) => i.action), ["ask"]);
  assert.deepEqual(paletteFilter(items, "bianchi").map((i) => i.action), ["person", "ask", "mention"]);
  assert.equal(paletteFilter(items, "auth")[0].value, "src/auth.ts");
  assert.equal(paletteFilter(items, "mstm")[0].label, "Message the team", "letters in order");
  assert.equal(paletteFilter(items, "team")[0].label, "Message the team", "a word start beats letters in order");
  assert.equal(paletteFilter(items, "").length, items.length);
  assert.equal(paletteFilter(items, "", 3).length, 3);
  assert.deepEqual(paletteFilter(items, "zzz"), []);
});

test("suggest: prefix first, then inside, the exact name hides the list", () => {
  const names = ["Ana Bianchi", "bob", "Cyana"];
  assert.deepEqual(suggest(names, ""), names);
  assert.deepEqual(suggest(names, "an"), ["Ana Bianchi", "Cyana"]);
  assert.deepEqual(suggest(names, "@B"), ["bob", "Ana Bianchi"]);
  assert.deepEqual(suggest(names, "bob"), []);
});

test("timeline: tasks, hook reports and request decisions of one repository, newest first", () => {
  const snap: Snapshot = {
    ...base,
    tasks: [
      { id: "t1", repo: "r", user: "ana", sessionId: "s", title: "Fix login", predicted: [], touched: [], status: "done", createdAt: 10, doneAt: 50 },
      { id: "t2", repo: "elsewhere", user: "ana", sessionId: "s", title: "Other", predicted: [], touched: [], status: "active", createdAt: 60 },
    ],
    events: [
      { at: 20, kind: "wait-overrun", user: "bob", repo: "r", path: "src/a.ts", waitedMs: 125_000 },
      { at: 30, kind: "publish-conflict", repo: "r", error: "x" },
    ],
    team: {
      chat: [],
      requests: [
        { id: "q", repo: "r", from: "bob", to: "ana", text: "Explain it", scope: "read", status: "approved", createdAt: 40, expiresAt: 99, decidedAt: 45, reply: "ok", repliedAt: 70 },
        { id: "z", repo: "r", from: "bob", to: "cy", text: "y", scope: "read", status: "denied", createdAt: 41, expiresAt: 99, decidedAt: 42 },
        { id: "e", repo: "r", from: "bob", to: "cy", text: "late", scope: "read", status: "expired", createdAt: 43, expiresAt: 44 },
      ],
    },
  };
  const t = timeline(snap, "r");
  assert.deepEqual(t.map((i) => [i.at, i.tone, i.who, i.agent, i.text]), [
    [70, "reply", "ana", true, "replied to bob"],
    [50, "done", "ana", true, "finished and published"],
    [45, "approved", "ana", false, "approved bob's request"],
    [43, "ask", "bob", false, "asked cy's agent"],
    [42, "declined", "cy", false, "declined bob's request"],
    [41, "ask", "bob", false, "asked cy's agent"],
    [40, "ask", "bob", false, "asked ana's agent"],
    [30, "problem", "An agent", false, "could not publish: conflict"],
    [20, "wait", "bob", true, "waited 2 min for"],
    [10, "start", "ana", true, "started"],
  ]);
  assert.equal(t.find((i) => i.tone === "wait")?.subject, "src/a.ts");
  assert.equal(timeline(snap, "r", 2).length, 2);
  assert.deepEqual(timeline(base, "r"), [], "an empty snapshot, or an older server without team, has no events");
});

test("faviconBadge: the mark, plus a red count only when something waits; never more than 9+", () => {
  const svg = (n: number) => decodeURIComponent(faviconBadge(n).slice("data:image/svg+xml,".length));
  assert.ok(faviconBadge(0).startsWith("data:image/svg+xml,"));
  assert.doesNotMatch(svg(0), /<circle/);
  assert.match(svg(3), /<circle[^>]*\/><text[^>]*>3<\/text>/);
  assert.match(svg(42), />9\+<\/text>/);
  assert.doesNotMatch(svg(-1), /<circle/);
});
