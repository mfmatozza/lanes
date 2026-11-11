// Loads the real bundle (dist/extension.cjs) against a stub of the vscode API and a live server.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import Module, { createRequire } from "node:module";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Coordinator } from "@lanes/server/coordinator.ts";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { locate } from "@lanes/core/repo.ts";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";

process.env.LANES_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "lanes-ext-home-")); // the extension writes ~/.lanes/config.json (#123)

const BUNDLE = fileURLToPath(new URL("../dist/extension.cjs", import.meta.url));
const TOKEN = "t".repeat(40);

interface Bar { text: string }
const commands = new Map<string, (...a: unknown[]) => unknown>();
const bars: Bar[] = [];
const messages: string[] = [];
const executed: unknown[][] = [];
const decorators: { provideFileDecoration(u: unknown): any }[] = [];
const providers = new Map<string, { getChildren(n?: unknown): any[]; getTreeItem(n: any): Record<string, any> }>();
const contexts = () => executed.filter((a) => a[0] === "setContext" && a[1] === "lanes.agentsState").map((a) => a[2]);
let settings: Record<string, string> = {};
let folder = "";
let firstFolders: string[] = []; // more workspace folders, listed before `folder` (multi-root)
const shown: string[] = [];
const logged: string[] = []; // everything written to the Lanes output channel
const clipboard: string[] = [];
const inputs: (string | undefined)[] = []; // answers to showInputBox, in order
const choices: (string | undefined)[] = []; // the button picked in the next information message
const opened: string[] = []; // URLs given to env.openExternal

class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
const vscodeStub = {
  EventEmitter: Emitter,
  StatusBarAlignment: { Left: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class { label: string; collapsibleState?: number; constructor(label: string, collapsibleState?: number) { this.label = label; this.collapsibleState = collapsibleState; } },
  ThemeIcon: class { id: string; color?: { id: string }; constructor(id: string, color?: { id: string }) { this.id = id; this.color = color; } },
  ThemeColor: class { id: string; constructor(id: string) { this.id = id; } },
  MarkdownString: class { value: string; constructor(value = "") { this.value = value; } toString() { return this.value; } },
  FileDecoration: class { badge: string; tooltip: string; color: unknown; constructor(badge: string, tooltip: string, color: unknown) { this.badge = badge; this.tooltip = tooltip; this.color = color; } },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }), parse: (u: string) => ({ toString: () => u }) },
  window: {
    createOutputChannel: () => ({ appendLine: (l: string) => { logged.push(l); }, append: (l: string) => { logged.push(l); }, dispose() {} }),
    showInputBox: () => Promise.resolve(inputs.shift()),
    createStatusBarItem: () => { const b = { text: "", show() {}, dispose() {} } as Bar & Record<string, unknown>; bars.push(b); return b; },
    registerTreeDataProvider: (id: string, provider: { getChildren(n?: unknown): unknown[]; getTreeItem(n: unknown): Record<string, unknown> }) => { providers.set(id, provider); return { dispose() {} }; },
    registerFileDecorationProvider: (p: { provideFileDecoration(u: unknown): any }) => { decorators.push(p); return { dispose() {} }; },
    showQuickPick: (items: string[]) => Promise.resolve(items.at(-1)), // only asked when several folders are repositories (a home directory that is a git repository counts)
    showTextDocument: (uri: { fsPath: string }) => { shown.push(uri.fsPath); return Promise.resolve(); },
    showInformationMessage: (m: string) => { messages.push(m); return Promise.resolve(choices.shift()); },
    showWarningMessage: (m: string) => { messages.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m: string) => { messages.push(m); },
  },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { writeText: (t: string) => { clipboard.push(t); return Promise.resolve(); } }, openExternal: (u: { toString(): string }) => { opened.push(u.toString()); return Promise.resolve(true); } },
  commands: { registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: (...a: unknown[]) => { executed.push(a); } },
  workspace: {
    getConfiguration: () => ({ get: (k: string, d?: string) => settings[k] ?? d, update: (k: string, v: string) => { settings[k] = v; return Promise.resolve(); } }),
    get workspaceFolders() { return folder ? [...firstFolders, folder].map((p) => ({ uri: { fsPath: p } })) : undefined; },
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
};

const openSubs: { dispose?: () => void }[] = []; // disposed in after(), so a failing assertion cannot leave a poll timer running
let server: RunningServer;
const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
before(async () => {
  (Module as unknown as { _load: unknown })._load = function (request: string, ...rest: unknown[]) {
    return request === "vscode" ? vscodeStub : realLoad.call(this, request, ...rest);
  };
  server = await startServer({ port: 0, token: TOKEN, coordinator: new Coordinator() });
});
after(async () => {
  for (const s of openSubs) s.dispose?.();
  (Module as unknown as { _load: unknown })._load = realLoad;
  await server.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("activates, shows the live agent count, then offline when the server goes away", async () => {
  assert.ok(fs.existsSync(BUNDLE), "run `npm run build` first");
  settings = { serverUrl: server.url, token: TOKEN, userName: "Ana" };
  const ext = createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void };
  const subs = openSubs;
  ext.activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
  for (const id of ["lanes.startServer", "lanes.stopServer", "lanes.setupRepository", "lanes.reconnect", "lanes.showLog", "lanes.releaseLease", "lanes.openTaskFile", "lanes.openAgentFile", "lanes.reviewMerge", "lanes.dismissMerge"]) assert.ok(commands.has(id), id);

  await wait(300);
  assert.equal(bars[0]!.text, "$(pulse) Lanes: 0 agents");

  server.coordinator.session({ user: "Bea", sessionId: "b1", repo: "r", label: "app", event: "start" });
  await wait(500); // well under the 1 s poll: only the live stream (#48) can have delivered this
  assert.equal(bars[0]!.text, "$(pulse) Lanes: 1 agent");

  // #130: a hook problem and a lease nobody holds an agent for show up as a warning with an explanation.
  server.coordinator.observe({ kind: "publish-blocked", user: "Bea", repo: "r", paths: ["a.bin"] });
  server.coordinator.check({ user: "Ghost", sessionId: "gone", repo: "r", label: "app", tool: "Edit", paths: ["x.ts"] });
  (server.coordinator as unknown as { agents: Map<string, unknown> }).agents.delete("gone"); // a lease whose agent is gone
  await wait(500);
  assert.match(bars[0]!.text, /Lanes: 1 agent \$\(warning\) 2$/);
  assert.match(String((bars[0] as unknown as { tooltip: string }).tooltip), /Edits kept local/);
  assert.equal((bars[0] as unknown as { backgroundColor?: { id: string } }).backgroundColor?.id, "statusBarItem.errorBackground", "needs merge is the one red state");
  const agentsView = providers.get("lanes.agents")!;
  const beaRow = agentsView.getTreeItem(agentsView.getChildren()[0]);
  assert.equal(beaRow.iconPath.id, "account");
  assert.match(beaRow.iconPath.color.id, /^(charts|terminal)\./, "each person has a colour");
  assert.equal(agentsView.getTreeItem(agentsView.getChildren(agentsView.getChildren()[0])[0]).iconPath.color.id, "charts.red", "Bea's agent needs merge");

  // #60: two tasks on the same file show up in the Tasks view, flagged, pushed by the stream.
  const tasks = providers.get("lanes.tasks")!;
  assert.deepEqual(tasks.getChildren(), [], "no tasks yet: the view shows its empty message");
  assert.ok(executed.some((a) => a[1] === "lanes.tasksState" && a[2] === "empty"));
  server.coordinator.createTask({ user: "Ana", sessionId: "a1", repo: "r", label: "app", title: "refactor auth", predicted: ["src/auth.ts"] });
  server.coordinator.createTask({ user: "Bea", sessionId: "b1", repo: "r", label: "app", title: "rate limit", predicted: ["src/auth.ts", "src/api.ts"] });
  await wait(500);
  const people = tasks.getChildren();
  assert.deepEqual(people.map((p) => p.group.user), ["Ana", "Bea"], "you first");
  const bea = tasks.getChildren(people[1]);
  assert.match(String(tasks.getTreeItem(bea[0]).description), /^overlaps with Ana on 1 file/);
  assert.equal(tasks.getChildren(bea[0])[0].overlap.files[0], "src/auth.ts");
  assert.match(String((bars[0] as unknown as { tooltip: string }).tooltip), /2 tasks overlap another/);

  await server.close();
  await wait(1300);
  assert.equal(bars[0]!.text, "$(debug-disconnect) Lanes: offline");
  assert.match(String((bars[0] as unknown as { tooltip: string }).tooltip), /^Coordination paused/, "never silent about it (M6)");
  assert.ok(executed.some((a) => a[1] === "lanes.teamState" && a[2] === "offline"), "the Team view says so too");
  assert.deepEqual([...new Set(contexts())], ["loading", "empty", "ready", "offline"], "the view moves through loading, empty, content and offline");
  for (const s of subs) s.dispose?.();
});

test("Start Local Server does nothing but explain when lanes.serverUrl is another machine (#201)", async () => {
  settings = { serverUrl: "http://lanes.invalid:4317", token: TOKEN, userName: "Ana" };
  const before = bars.length;
  const subs = openSubs;
  (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
  try {
    assert.equal((bars[before] as unknown as { name?: string }).name, "Lanes");
    await commands.get("lanes.startServer")!();
    assert.match(messages.at(-1) ?? "", /another machine \(lanes\.invalid:4317\)/);
  } finally {
    for (const s of subs) s.dispose?.();
  }
});

test("the team commands copy the exact server line and a join message with the token, and the token never reaches the log (#252)", async () => {
  const extPath = path.dirname(path.dirname(BUNDLE));
  settings = { serverUrl: "http://127.0.0.1:4317", token: "secret-team-token-xyz", userName: "Ana" };
  const subs: { dispose?: () => void }[] = [];
  (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: extPath });
  try {
    clipboard.length = 0;
    logged.length = 0;
    commands.get("lanes.copyServerCommand")!();
    await wait(50);
    assert.equal(clipboard.at(-1), `node "${extPath.replace(/\\/g, "/")}/dist/lanes.cjs" server --host 0.0.0.0`);
    assert.ok(fs.existsSync(path.join(extPath, "dist", "lanes.cjs")), "the line points at a file that ships");
    commands.get("lanes.copyJoinMessage")!();
    await wait(50);
    const msg = clipboard.at(-1) ?? "";
    assert.match(msg, /Server: http:\/\/[^\s:]+:4317\n/);
    assert.doesNotMatch(msg, /Server: http:\/\/(127\.0\.0\.1|localhost)/, "a loopback address is useless to a teammate");
    assert.ok(msg.includes("Token: secret-team-token-xyz"));
    assert.ok(messages.some((m) => /holds your team token/.test(m)));
    assert.ok(!logged.join("\n").includes("secret-team-token-xyz"), "the token is never logged");
  } finally {
    for (const s of subs) s.dispose?.();
  }
});

test("Join Team Server saves the address and the token as settings, and does nothing when cancelled", async () => {
  settings = { serverUrl: "http://127.0.0.1:4317", userName: "Ana" };
  const subs: { dispose?: () => void }[] = [];
  (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
  try {
    inputs.push(undefined);
    await commands.get("lanes.joinTeam")!();
    assert.equal(settings.token, undefined);
    inputs.push(" http://10.1.2.3:4317 ", " team-tok ");
    await commands.get("lanes.joinTeam")!();
    assert.equal(settings.serverUrl, "http://10.1.2.3:4317");
    assert.equal(settings.token, "team-tok");
    assert.ok(!logged.join("\n").includes("team-tok"));
  } finally {
    for (const s of subs) s.dispose?.();
  }
});

test("first run: one notification that links to the walkthrough, shown once, not a tab that steals focus (#252)", async () => {
  const store = new Map<string, unknown>();
  const globalState = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); } };
  settings = { serverUrl: "http://127.0.0.1:1", userName: "Ana" }; // nothing listens: offline
  const run = async () => {
    const subs: { dispose?: () => void }[] = [];
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, globalState, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    for (let i = 0; i < 100 && !messages.some((m) => /Lanes is installed/.test(m)) && !store.has("lanes.welcomed"); i++) await wait(100);
    await wait(100);
    for (const s of subs) s.dispose?.();
  };
  messages.length = 0;
  executed.length = 0;
  choices.push("Get Started");
  await run();
  assert.equal(messages.filter((m) => /Lanes is installed/.test(m)).length, 1);
  assert.ok(executed.some((a) => a[0] === "workbench.action.openWalkthrough" && a[1] === "MicheleFMatozza.lanes#lanes.start"));
  messages.length = 0;
  await run();
  assert.equal(messages.filter((m) => /Lanes is installed/.test(m)).length, 0, "only once");
});

test("Set Up Repository writes and commits the hook using the bundled files", async () => {
  const { main, cleanup } = makeRepo();
  try {
    Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" });
    folder = main;
    await commands.get("lanes.setupRepository")!();
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")));
    assert.ok(fs.existsSync(path.join(main, ".lanes", "server.cjs")));
    assert.ok(messages.some((m) => /set up and committed/.test(m) && m.length < 120), "a short confirmation, not cut off by VS Code");
    assert.match(messages.at(-1) ?? "", /No origin remote/); // a repository without an origin is its own warning
  } finally {
    folder = "";
    cleanup();
  }
});

test("multi-root: Set Up Repository and opening a lease use the folder that is the repository, not the first one", async () => {
  const { main, cleanup } = makeRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-plain-"));
  try {
    Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" });
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain); // a developer's home directory may itself be a git repository
    firstFolders = [plain];
    folder = main;
    await commands.get("lanes.setupRepository")!();
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")), "set up in the repository folder");
    assert.ok(!fs.existsSync(path.join(plain, ".lanes")), "not in the first folder");
    const repo = locate(path.join(main, "src", "a.ts"))!.repo.id;
    shown.length = 0;
    await commands.get("lanes.openLease")!({ repo, path: "src/a.ts", holder: "h", user: "Bea", acquiredAt: 0, expiresAt: 1 });
    assert.deepEqual(shown, [path.join(main, "src", "a.ts")]);
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
    firstFolders = [];
    folder = "";
    fs.rmSync(plain, { recursive: true, force: true });
    cleanup();
  }
});

test("multi-root: 'you' is the git user of the repository folder", async () => {
  const { main, cleanup } = makeRepo();
  const srv = await startServer({ port: 0, token: TOKEN, coordinator: new Coordinator() });
  const subs: { dispose?: () => void }[] = [];
  try {
    git(main, "config", "user.name", "Zed");
    const repo = locate(path.join(main, "src", "a.ts"))!.repo.id;
    srv.coordinator.session({ user: "Zed", sessionId: "z1", repo, label: "app", event: "start" });
    srv.coordinator.session({ user: "Amy", sessionId: "m1", repo, label: "app", event: "start" });
    firstFolders = [os.tmpdir()];
    folder = main;
    settings = { serverUrl: srv.url, token: TOKEN };
    const before = bars.length;
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    const agents = providers.get("lanes.agents")!;
    const labels = () => agents.getChildren().map((n) => String(agents.getTreeItem(n).label));
    // Polled, not a fixed wait: the first snapshot can take over a second under a full parallel test run.
    for (let i = 0; i < 50 && labels().join() !== "Zed (you),Amy"; i++) await wait(100);
    assert.ok(bars[before]);
    assert.deepEqual(labels(), ["Zed (you)", "Amy"]);
    // Amy's agent takes a file: the Explorer shows her initials in the teammate colour, and nothing for a file nobody holds.
    srv.coordinator.check({ user: "Amy", sessionId: "m1", repo, label: "app", tool: "Edit", paths: ["src/a.ts"] });
    const deco = decorators.at(-1)!;
    const file = { fsPath: path.join(main, "src", "a.ts"), scheme: "file" };
    for (let i = 0; i < 50 && !deco.provideFileDecoration(file); i++) await wait(100);
    const held = deco.provideFileDecoration(file);
    assert.deepEqual([held.badge, held.color.id], ["AM", "lanes.heldByTeammate"]);
    assert.match(held.tooltip, /Held by Amy's agent/);
    assert.equal(deco.provideFileDecoration({ fsPath: path.join(main, "README.md"), scheme: "file" }), undefined);
  } finally {
    firstFolders = [];
    folder = "";
    for (const s of subs) s.dispose?.();
    await srv.close();
    cleanup();
  }
});

test("a setting that is cleared is removed from ~/.lanes/config.json again, so the hooks stop using the old server and token", async () => {
  const file = path.join(process.env.LANES_HOME!, "config.json");
  const store = new Map<string, unknown>();
  const globalState = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); } };
  const run = () => {
    const subs: { dispose?: () => void }[] = [];
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, globalState, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    for (const s of subs) s.dispose?.();
  };
  fs.writeFileSync(file, JSON.stringify({ user: "Ana" }));
  settings = { serverUrl: "http://10.9.9.9:4317", token: "team-token" };
  run();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { user: "Ana", serverUrl: "http://10.9.9.9:4317", token: "team-token" });
  settings = {};
  run();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { user: "Ana" }, "only what the extension wrote is removed");
  // The display name is never written for the hooks: it would change the commit author of every repository (review #8).
  settings = { userName: "Ana Lima" };
  run();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).user, "Ana");
});

test("Review and merge opens a read-only comparison of the shared version and the checkout's copy, and changes nothing", async () => {
  const { main, cleanup } = makeRepo();
  const srv = await startServer({ port: 0, token: TOKEN, coordinator: new Coordinator() });
  try {
    git(main, "branch", "lanes/main");
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 2;\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "agent edit");
    const head = git(main, "rev-parse", "HEAD");
    const repo = locate(path.join(main, "src", "a.ts"))!.repo.id;
    folder = main;
    settings = { serverUrl: srv.url, token: TOKEN, userName: "Ana" };
    srv.coordinator.session({ user: "Ana", sessionId: "a1", repo, label: "app", event: "start" });
    srv.coordinator.observe({ kind: "publish-blocked", user: "Ana", sessionId: "a1", repo, paths: ["src/a.ts"] });
    srv.coordinator.observe({ kind: "publish-blocked", user: "Bea", sessionId: "b1", repo, paths: ["src/other.ts"] });

    const before = bars.length;
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: openSubs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    await wait(400);
    assert.match(bars[before]!.text, /\$\(warning\) 2$/, "both people's needs-merge items are counted");

    executed.length = 0;
    const item = { key: "k", user: "Ana", repo, title: "Edits kept local", paths: ["src/a.ts"], at: 1 };
    await commands.get("lanes.reviewMerge")!({ kind: "merge", item });
    const diff = executed.find((a) => a[0] === "vscode.diff")!;
    assert.ok(diff, "a comparison was opened");
    const [left, right] = [(diff[1] as { fsPath: string }).fsPath, (diff[2] as { fsPath: string }).fsPath];
    assert.equal(fs.readFileSync(left, "utf8"), "export const a = 1;\n", "left: the shared version");
    assert.equal(right, path.join(main, "src", "a.ts"), "right: this checkout's copy");

    // A teammate's file, or a path that climbs out of the checkout, is never opened.
    executed.length = 0;
    await commands.get("lanes.reviewMerge")!({ kind: "merge", item: { ...item, paths: ["../../etc/passwd"] } });
    assert.ok(!executed.some((a) => String(a[2]).includes("passwd")));

    // Once the shared branch has the same file, there is nothing to compare.
    git(main, "branch", "-f", "lanes/main", "HEAD");
    executed.length = 0;
    messages.length = 0;
    await commands.get("lanes.reviewMerge")!({ kind: "merge", item });
    assert.ok(!executed.some((a) => a[0] === "vscode.diff"), "no empty comparison");
    assert.match(messages.at(-1) ?? "", /already matches the shared version/);

    assert.equal(git(main, "rev-parse", "HEAD"), head);
    assert.equal(git(main, "status", "--porcelain"), "", "nothing in the repository changed");
  } finally {
    folder = "";
    for (const s of openSubs.splice(0)) s.dispose?.();
    await srv.close();
    cleanup();
  }
});

test("falls back to polling when the live stream is unavailable (a server that cannot upgrade)", async () => {
  let agents = 1;
  const old = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ agents: Array.from({ length: agents }, (_, i) => ({ user: "Bea", sessionId: `b${i}`, repo: "r", label: "app", status: "idle", edits: 0, startedAt: 0, lastSeen: 0 })), leases: [], tasks: [], editors: {}, events: [], serverTime: 0 }));
  });
  await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
  const subs = openSubs;
  try {
    settings = { serverUrl: `http://127.0.0.1:${(old.address() as AddressInfo).port}`, token: TOKEN, userName: "Ana" };
    const before = bars.length;
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    const bar = bars[before]!;
    await wait(400);
    assert.equal(bar.text, "$(pulse) Lanes: 1 agent");
    agents = 2;
    await wait(1500);
    assert.equal(bar.text, "$(pulse) Lanes: 2 agents", "the poll noticed the change");
  } finally {
    for (const s of subs) s.dispose?.();
    old.closeAllConnections();
    await new Promise((r) => old.close(r));
  }
});

test("Start Local Server works again after Stop Local Server (a killed process has no exit code)", async () => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  settings = { serverUrl: `http://127.0.0.1:${port}`, token: TOKEN, userName: "Ana" };
  const before = bars.length;
  const subs: { dispose?: () => void }[] = [];
  (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
  const bar = bars[before]!;
  try {
    await commands.get("lanes.startServer")!();
    await wait(2500);
    assert.equal(bar.text, "$(pulse) Lanes: 0 agents");
    commands.get("lanes.stopServer")!();
    await wait(2500);
    assert.match(bar.text, /offline/);
    messages.length = 0;
    await commands.get("lanes.startServer")!();
    await wait(2500);
    assert.equal(messages.filter((m) => /already running/.test(m)).length, 0);
    assert.equal(bar.text, "$(pulse) Lanes: 0 agents");
  } finally {
    commands.get("lanes.stopServer")!();
    for (const s of subs) s.dispose?.();
  }
});

test("Start Local Server is noticed right away, not after the poll's backoff (#198)", async () => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  settings = { serverUrl: `http://127.0.0.1:${port}`, token: TOKEN, userName: "Ana" };
  const before = bars.length;
  const subs = openSubs;
  (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
  const bar = bars[before]!;
  try {
    await wait(4500); // failed polls at 0, 1 and 3 s: the next one is 4 s later
    assert.equal(bar.text, "$(debug-disconnect) Lanes: offline");
    await commands.get("lanes.startServer")!();
    await wait(2500);
    assert.equal(bar.text, "$(pulse) Lanes: 0 agents");
  } finally {
    commands.get("lanes.stopServer")!();
    for (const s of subs) s.dispose?.();
  }
});

test("Team view (ADR-0028): a request for you pops up once with Approve and Decline, and Approve decides it", async () => {
  const srv = await startServer({ port: 0, token: TOKEN });
  try {
    settings = { serverUrl: srv.url, token: TOKEN, userName: "Ana" };
    const subs: { dispose?: () => void }[] = [];
    openSubs.push(...subs);
    choices.push("Approve");
    const ext = createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void };
    ext.activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    for (const id of ["lanes.teamSay", "lanes.teamAsk", "lanes.approveRequest", "lanes.denyRequest", "lanes.teamContextOn"]) assert.ok(commands.has(id), id);
    const post = (route: string, body: object) => fetch(srv.url + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }).then((r) => r.json());
    const bea = { user: "Bea", sessionId: "b1", repo: "r", label: "app" };
    const asked = await post("/v1/team/ask", { ...bea, to: "ana", text: "Explain the cache", scope: "read" });
    await post("/v1/team/say", { ...bea, text: "@ana ping" });
    for (let i = 0; i < 30 && !messages.some((m) => /Bea asks your agent \(read only\): Explain the cache/.test(m)); i++) await wait(100);
    assert.equal(messages.filter((m) => /Bea asks your agent/.test(m)).length, 1, "notified once");
    const team = providers.get("lanes.team")!;
    for (let i = 0; i < 30 && (await post("/v1/team/requests", { ...bea })).requests[0].status === "pending"; i++) await wait(100);
    assert.equal((await post("/v1/team/requests", bea)).requests[0].status, "approved");
    assert.equal(asked.status, "pending");
    await wait(200);
    const sections = team.getChildren();
    assert.deepEqual(sections.map((s) => s.label), ["Inbox", "Sent requests", "Team chat"], "the same sections as the browser app");
    const label = (n: unknown) => String(team.getTreeItem(n).label);
    assert.deepEqual(team.getChildren(sections[0]).map(label), ["Nothing waiting for you"], "approved, so the inbox shows its empty state");
    assert.equal(team.getTreeItem(team.getChildren(sections[1]).at(-1)).command.command, "lanes.teamAsk", "a way to ask, right where requests are");
    const chat = team.getChildren(sections[2]);
    assert.equal(team.getTreeItem(chat[0]).command.command, "lanes.teamSay");
    assert.match(label(chat[1]), /^Bea: @ana ping$/);
    assert.equal(team.getTreeItem(chat[1]).iconPath.id, "mention", "a message that mentions you stands out");
    assert.ok(executed.some((a) => a[1] === "lanes.teamState" && a[2] === "ready"));
    for (const s of subs) s.dispose?.();
  } finally {
    await srv.close();
  }
});

test("team context: the Team view hints while it is off, the two commands switch it, and the context key follows", async () => {
  const { main, cleanup } = makeRepo();
  const srv = await startServer({ port: 0, token: TOKEN });
  const subs: { dispose?: () => void }[] = [];
  const key = () => executed.filter((a) => a[0] === "setContext" && a[1] === "lanes.teamContext").at(-1)?.[2];
  try {
    settings = { serverUrl: srv.url, token: TOKEN, userName: "Ana" };
    folder = main;
    executed.length = 0;
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    assert.equal(key(), "off", "read on activation");
    const team = providers.get("lanes.team")!;
    for (let i = 0; i < 30 && team.getChildren().length === 0; i++) await wait(100);
    const first = team.getTreeItem(team.getChildren()[0]);
    assert.match(String(first.label), /^Team context is off in this repository: agents don't get the team brief yet/);
    assert.equal(first.command.command, "lanes.teamContextOn");
    await commands.get("lanes.teamContextOn")!();
    assert.equal(key(), "on");
    assert.deepEqual(team.getChildren().map((n) => String(team.getTreeItem(n).label)), ["Inbox", "Sent requests", "Team chat"], "no hint once it is on");
    messages.length = 0;
    await commands.get("lanes.teamContextOff")!();
    assert.equal(key(), "off");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".lanes", "team.json"), "utf8")), { context: false }, "the same file lanes team off writes");
    assert.match(messages.at(-1) ?? "", /agents there no longer get the team brief\. Commit \.lanes\/team\.json/);
  } finally {
    folder = "";
    for (const s of subs) s.dispose?.();
    await srv.close();
    cleanup();
  }
});

test("Open Team App opens the browser only when the server answers, and otherwise says how to start it", async () => {
  const srv = await startServer({ port: 0, token: TOKEN });
  const subs: { dispose?: () => void }[] = [];
  try {
    settings = { serverUrl: "http://127.0.0.1:1", token: TOKEN, userName: "Ana" };
    (createRequire(import.meta.url)(BUNDLE) as { activate(c: unknown): void }).activate({ subscriptions: subs, extensionPath: path.dirname(path.dirname(BUNDLE)) });
    opened.length = 0;
    messages.length = 0;
    await commands.get("lanes.openApp")!();
    assert.equal(opened.length, 0, "the browser stays closed");
    assert.equal(messages.at(-1), "The Lanes server at http://127.0.0.1:1 is not answering, so the app can't open. Start it with Lanes: Start Local Server, or check lanes.serverUrl.");
    settings.serverUrl = srv.url;
    await commands.get("lanes.openApp")!();
    assert.equal(opened.length, 1);
    assert.ok(opened[0]!.startsWith(srv.url + "/app#"), opened[0]);
  } finally {
    for (const s of subs) s.dispose?.();
    await srv.close();
  }
});
