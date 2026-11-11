import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { predictFiles, redactSecrets } from "../src/hook.ts";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { withLanesHooks } from "@lanes/core/settings.ts";
import { git, makeRemoteTeam, makeTeamRepo } from "./helpers.ts";

const EOL = String.fromCharCode(10);
// Hooks spawned by these tests inherit this: their own ~/.lanes, and no auto-started servers unless a test asks
// (an earlier run left a real server listening on port 1).
process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

// Async on purpose: the server under test runs in this process, so a sync spawn would deadlock it.
function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("hook v2 against a real server and a two-person repo", () => {
  let server: RunningServer;
  let repo: ReturnType<typeof makeTeamRepo>;
  const env = (user: string, extra: Record<string, string> = {}) => ({ LANES_SERVER: server.url, LANES_USER: user, LANES_EMAIL: `${user}@example.com`, ...extra });
  const edit = (sessionId: string, cwd: string, file = "src/routes.ts") => ({
    session_id: sessionId,
    cwd,
    tool_name: "Edit",
    tool_input: { file_path: path.join(cwd, file) },
  });
  before(async () => {
    server = await startServer({ port: 0 });
    repo = makeTeamRepo("ana", "bea");
  });
  after(async () => {
    await server.close();
    repo.cleanup();
  });

  test("prompt creates a task silently; overlaps are tracked on the server, not told to the agent (ADR-0018)", async () => {
    const first = await runHook("prompt", { session_id: "s-ana", cwd: repo.wt.ana, prompt: "Add a /health route in src/routes.ts" }, env("ana"));
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, "");
    const second = await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "Add a /version route to the routes file" }, env("bea"));
    assert.equal(second.stdout, "");
    const tasks = server.coordinator.snapshot().tasks;
    assert.deepEqual(tasks.map((t) => [t.user, t.predicted]), [["ana", ["src/routes.ts"]], ["bea", ["src/routes.ts"]]]);
  });

  test("first edit is allowed silently", async () => {
    const res = await runHook("pre", edit("s-ana", repo.wt.ana), env("ana"));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, "");
  });

  test("a wait that runs out never refuses the edit (spike v3: no rejections)", async () => {
    const res = await runHook("pre", edit("s-bea", repo.wt.bea), env("bea", { LANES_WAIT_MS: "300" }));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, "", "allowed, nothing shown");
  });

  test("waiting agent is served right after the holder's edit is published, syncs it and is told to re-read (ADR-0015/0016)", async () => {
    const waiting = runHook("pre", edit("s-bea", repo.wt.bea), env("bea", { LANES_WAIT_MS: "20000" }));
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(path.join(repo.wt.ana, "src", "routes.ts"), 'export const routes = [\n  "/",\n  "/health",\n];\n');
    const post = await runHook("post", edit("s-ana", repo.wt.ana), env("ana"));
    assert.equal(post.code, 0, post.stderr);

    const res = await waiting;
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, "no decision: the user's permission flow is untouched");
    assert.match(out.additionalContext, /src\/routes\.ts has new content since you last read it\. This is expected.* Re-read it/, "agent-only re-read note (spike v2 carry-over)");
    assert.doesNotMatch(out.additionalContext, /lanes|teammate|tell the user|stop/i);
    assert.match(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), /\/health/, "ana's change was synced in");
  });

  test("published commit is signed by the human with Lanes trailers (ADR-0017)", () => {
    const log = git(repo.main, "log", "-1", "--format=%an <%ae> | %cn%n%B", "lanes/main");
    assert.match(log, /^ana <ana@example\.com> \| ana/);
    assert.match(log, /Lanes-Agent: claude-code \(session s-ana\)/);
    assert.match(log, /Lanes-Task: Add a \/health route in src\/routes\.ts/);
    assert.match(log, /Co-authored-by: Claude <noreply@anthropic\.com>/);
    assert.deepEqual({ ...Object.values(server.coordinator.snapshot().editors)[0] }, { "src/routes.ts": ["ana"] });
  });

  test("second person's edit is rebased on top: both signatures in the commit tree", async () => {
    fs.writeFileSync(path.join(repo.wt.bea, "src", "routes.ts"), 'export const routes = [\n  "/",\n  "/health",\n  "/version",\n];\n');
    const post = await runHook("post", edit("s-bea", repo.wt.bea), env("bea"));
    assert.equal(post.code, 0, post.stderr);
    assert.deepEqual(git(repo.main, "log", "--format=%an", "lanes/main").split("\n").slice(0, 2), ["bea", "ana"]);
    assert.deepEqual(Object.values(server.coordinator.snapshot().editors)[0]["src/routes.ts"], ["ana", "bea"]);
  });

  test("concurrent publishes of different files all land, with no identity configured in git (spike v2 bug)", async () => {
    fs.writeFileSync(path.join(repo.wt.ana, "src", "one.ts"), "export const one = 1;\n");
    fs.writeFileSync(path.join(repo.wt.bea, "src", "two.ts"), "export const two = 2;\n");
    const noIdentity = { GIT_CONFIG_GLOBAL: path.join(repo.main, "no-such-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    const [a, b] = await Promise.all([
      runHook("post", edit("s-ana", repo.wt.ana, "src/one.ts"), env("ana", noIdentity)),
      runHook("post", edit("s-bea", repo.wt.bea, "src/two.ts"), env("bea", noIdentity)),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const files = git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main");
    assert.match(files, /src\/one\.ts/);
    assert.match(files, /src\/two\.ts/);
  });

  test("while the user approves an edit, the lease is held instead of expiring; no decision is made", async () => {
    const pre = await runHook("pre", edit("s-hold", repo.wt.ana, "src/held.ts"), env("ana"));
    assert.equal(pre.code, 0, pre.stderr);
    const lease = () => server.coordinator.snapshot().leases.find((l) => l.path === "src/held.ts");
    const before = lease()?.expiresAt ?? 0;
    const res = await runHook("permission", edit("s-hold", repo.wt.ana, "src/held.ts"), env("ana"));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, "", "the approval prompt is left to the user");
    assert.ok((lease()?.expiresAt ?? 0) - Date.now() > 25 * 60_000, "held for ~30 min");
    assert.ok((lease()?.expiresAt ?? 0) > before);
    await runHook("stop", { session_id: "s-hold", cwd: repo.wt.ana }, env("ana"));
    assert.equal(lease(), undefined, "end of turn still releases it");
  });

  test("session start tells the agent (only) that its edits are committed automatically", async () => {
    const res = await runHook("start", { session_id: "s-start", cwd: repo.wt.ana }, env("ana"));
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "SessionStart");
    assert.match(out.additionalContext, /saved automatically as a commit.*your own edits/);
    assert.doesNotMatch(out.additionalContext, /lanes|teammate|tell the user/i);
  });

  test("files a turn creates outside the edit tools are published at the end of the turn; the human's and secrets are not (spike v3d)", async () => {
    const wt = repo.wt.ana;
    const file = (p: string) => path.join(wt, ...p.split("/"));
    // Before the prompt: the human already has an unrelated change, and has staged a file of their own.
    fs.writeFileSync(file("src/human-draft.ts"), "export const draft = 1;" + EOL);
    fs.writeFileSync(file("src/staged-by-human.ts"), "export const staged = 1;" + EOL);
    git(wt, "add", "src/staged-by-human.ts");
    await runHook("prompt", { session_id: "s-gen", cwd: wt, prompt: "Generate src/generated.ts with a script" }, env("ana"));
    // During the turn, a shell command (e.g. a generator) writes files; one looks like a credentials file.
    fs.mkdirSync(file("src/gen"), { recursive: true });
    fs.writeFileSync(file("src/gen/errors.ts"), "export const ERRORS = {};" + EOL);
    fs.writeFileSync(file(".env"), "TOKEN=abc" + EOL);
    const stop = await runHook("stop", { session_id: "s-gen", cwd: wt }, env("ana"));
    assert.equal(stop.code, 0, stop.stderr);
    const shared = git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main");
    assert.match(shared, /src\/gen\/errors\.ts/, "the generated file is published");
    assert.doesNotMatch(shared, /human-draft|staged-by-human/, "the human's own work is not");
    assert.doesNotMatch(shared, /\.env/, "secret-looking files are never published");
    assert.match(git(wt, "diff", "--cached", "--name-only"), /src\/staged-by-human\.ts/, "what the human staged stays staged");
  });

  test("when a publish brings in others' changes, the agent is told which files to re-read (spike v3d)", async () => {
    const write = (wt: string, p: string, text: string) => fs.writeFileSync(path.join(wt, ...p.split("/")), text + EOL);
    write(repo.wt.ana, "src/pricing.ts", "export const rate = 2;");
    assert.equal((await runHook("post", edit("p-ana", repo.wt.ana, "src/pricing.ts"), env("ana"))).code, 0);
    write(repo.wt.bea, "src/bea-notes.ts", "export const n = 1;");
    const res = await runHook("post", edit("p-bea", repo.wt.bea, "src/bea-notes.ts"), env("bea"));
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    assert.match(out.additionalContext, /Newer content arrived for .*src\/pricing\.ts.* re-read them/);
    assert.doesNotMatch(out.additionalContext, /bea-notes|lanes|teammate|ana\b|tell the user/i);
    const again = await runHook("post", edit("p-bea", repo.wt.bea, "src/bea-notes.ts"), env("bea"));
    assert.equal(again.stdout, "", "nothing new arrived: no note");
  });

  test("stop completes the task", async () => {
    await runHook("stop", { session_id: "s-ana", cwd: repo.wt.ana }, env("ana"));
    assert.equal(server.coordinator.snapshot().tasks.find((t) => t.user === "ana")?.status, "done");
  });

  test("a local server that isn't running is started automatically, requires the token, and exits when idle", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const auto = { LANES_SERVER: url, LANES_USER: "ana", LANES_AUTOSTART: "1", LANES_TOKEN: "auto-token", LANES_IDLE_EXIT_MS: "1500" };
    const res = await runHook("pre", edit("s-auto", repo.wt.ana, "src/auto.ts"), auto);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, "", "coordinated, not paused");
    const state = (token?: string) =>
      fetch(`${url}/v1/state`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status, () => 0);
    assert.equal(await state("auto-token"), 200, "the hook started it");
    assert.equal(await state(), 401, "and it requires the token");
    await runHook("stop", { session_id: "s-auto", cwd: repo.wt.ana }, auto); // releases the lease
    await new Promise((r) => setTimeout(r, 4_000));
    assert.equal(await state("auto-token"), 0, "it exited after being idle");
  });

  test("server down: the edit goes ahead silently (fail open, ADR-0019)", async () => {
    const res = await runHook("pre", edit("s-x", repo.wt.ana), { LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana" });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "", "no decision, nothing in the agent's context");
  });

  test("server down: the edit is still committed and published, so no work is lost", async () => {
    fs.writeFileSync(path.join(repo.wt.ana, "src", "offline.ts"), "export const offline = true;\n");
    const res = await runHook("post", edit("s-x", repo.wt.ana, "src/offline.ts"), env("ana", { LANES_SERVER: "http://127.0.0.1:1" }));
    assert.equal(res.code, 0);
    assert.match(git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main"), /src\/offline\.ts/);
  });

  test("server down: other events never block", async () => {
    const down = { LANES_SERVER: "http://127.0.0.1:1" };
    for (const event of ["post", "prompt", "start", "end"]) {
      assert.equal((await runHook(event, { ...edit("s-x", repo.wt.ana), prompt: "x" }, down)).code, 0, event);
    }
  });

  test("files outside git repositories are ignored", async () => {
    const outside = path.parse(repo.main).root;
    const input = { session_id: "s", cwd: outside, tool_name: "Write", tool_input: { file_path: path.join(outside, "x.txt") } };
    const res = await runHook("pre", input, { LANES_SERVER: "http://127.0.0.1:1" });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
  });
});

describe("hook v3: integration branch on a shared remote (two machines)", () => {
  let server: RunningServer;
  let team: ReturnType<typeof makeRemoteTeam>;
  const env = (user: string) => ({ LANES_SERVER: server.url, LANES_USER: user, LANES_EMAIL: `${user}@example.com`, LANES_REMOTE: "origin" });
  const edit = (sessionId: string, cwd: string, file = "src/routes.ts") => ({ session_id: sessionId, cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, file) } });
  before(async () => {
    server = await startServer({ port: 0 });
    team = makeRemoteTeam("ana", "bea");
  });
  after(async () => {
    await server.close();
    team.cleanup();
  });

  test("both clones map to the same repository and file lease (N6)", async () => {
    assert.equal((await runHook("pre", edit("r-ana", team.clone.ana), env("ana"))).code, 0);
    await runHook("pre", edit("r-bea", team.clone.bea), { ...env("bea"), LANES_WAIT_MS: "300" });
    const leases = server.coordinator.snapshot().leases;
    assert.deepEqual(leases.map((l) => [l.user, l.path]), [["ana", "src/routes.ts"]], "bea waited on ana's lease: same repo, same file");
  });

  test("a publish is pushed to origin, and the next holder on the other machine fetches and syncs it", async () => {
    const waiting = runHook("pre", edit("r-bea", team.clone.bea), { ...env("bea"), LANES_WAIT_MS: "20000" });
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(path.join(team.clone.ana, "src", "routes.ts"), 'export const routes = [\n  "/",\n  "/health",\n];\n');
    const post = await runHook("post", edit("r-ana", team.clone.ana), env("ana"));
    assert.equal(post.code, 0, post.stderr);
    assert.match(git(team.origin, "show", "lanes/main:src/routes.ts"), /\/health/, "pushed to origin");
    assert.equal(git(team.origin, "log", "-1", "--format=%an", "lanes/main"), "ana");

    const res = await waiting;
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /Re-read it/);
    assert.match(fs.readFileSync(path.join(team.clone.bea, "src", "routes.ts"), "utf8"), /\/health/, "fetched and synced across clones");
    // bea's edits announced by pre never got their post: until the turn ends they count as in flight and keep other
    // sessions' git operations off bea's working tree (#261). End it, as Claude Code would.
    await runHook("end", { session_id: "r-bea", cwd: team.clone.bea }, env("bea"));
  });

  test("concurrent pushes from both machines all land (push is the compare-and-swap)", async () => {
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(team.clone.ana, "src", `ana${i}.ts`), `export const a${i} = ${i};\n`);
      fs.writeFileSync(path.join(team.clone.bea, "src", `bea${i}.ts`), `export const b${i} = ${i};\n`);
      const [a, b] = await Promise.all([
        runHook("post", edit("r-ana", team.clone.ana, `src/ana${i}.ts`), env("ana")),
        runHook("post", edit("r-bea", team.clone.bea, `src/bea${i}.ts`), env("bea")),
      ]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(b.code, 0, b.stderr);
    }
    const files = git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main");
    for (let i = 0; i < 3; i++) {
      assert.match(files, new RegExp(`src/ana${i}\\.ts`));
      assert.match(files, new RegExp(`src/bea${i}\\.ts`));
    }
    assert.equal(git(team.clone.ana, "status", "--porcelain"), "", "nothing left behind");
  });

  test("overlapping edits made without a lease (server down): never stuck, never lost; the agent re-applies (spike v3c)", async () => {
    const down = (user: string) => ({ ...env(user), LANES_SERVER: "http://127.0.0.1:1" });
    git(team.clone.bea, "pull", "-q", "--rebase", "origin", "lanes/main");
    const routes = (c: string) => path.join(c, "src", "routes.ts");
    fs.writeFileSync(routes(team.clone.ana), 'export const routes = ["/ana"];\n');
    assert.equal((await runHook("post", edit("c-ana", team.clone.ana), down("ana"))).code, 0);

    // bea changed the same line; bea's human also has an unrelated file Lanes must never touch
    fs.writeFileSync(routes(team.clone.bea), 'export const routes = ["/bea"];' + EOL);
    fs.writeFileSync(path.join(team.clone.bea, "src", "notes.ts"), "export const mine = 1;" + EOL);
    const res = await runHook("post", edit("c-bea", team.clone.bea), down("bea"));
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout).hookSpecificOutput;
    assert.match(out.additionalContext, /src\/routes\.ts received newer content .* Re-read the file and apply your change again/);
    assert.doesNotMatch(out.additionalContext, /lanes|teammate|ana|tell the user/i);

    const backup = /git show ([0-9a-f]{12})/.exec(out.additionalContext)![1];
    assert.match(git(team.clone.bea, "show", `${backup}:src/routes.ts`), /\/bea/, "bea's version is kept");
    assert.match(fs.readFileSync(routes(team.clone.bea), "utf8"), /\/ana/, "bea's checkout now has the shared content");
    assert.doesNotMatch(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /notes\.ts/, "never publishes files the agent didn't edit");
    assert.equal(fs.readFileSync(path.join(team.clone.bea, "src", "notes.ts"), "utf8").trim(), "export const mine = 1;", "the human's file is untouched");
    assert.equal(git(team.clone.bea, "status", "--porcelain"), "?? src/notes.ts", "not stuck: only the human's own file is left");

    // the agent re-applies on top, and it publishes normally
    fs.writeFileSync(routes(team.clone.bea), 'export const routes = ["/ana", "/bea"];\n');
    assert.equal((await runHook("post", edit("c-bea", team.clone.bea), down("bea"))).stdout, "");
    assert.match(git(team.origin, "show", "lanes/main:src/routes.ts"), /"\/ana", "\/bea"/);
  });

  test("a conflict found at the end of a turn makes the agent continue once, never loop", async () => {
    const down = (user: string) => ({ ...env(user), LANES_SERVER: "http://127.0.0.1:1" });
    const file = (c: string) => path.join(c, "src", "a.ts");
    const originUrl = git(team.clone.bea, "remote", "get-url", "origin");
    // bea's edit is committed while the remote is unreachable, then ana pushes the same line first
    const offlineEdit = async (content: string) => {
      git(team.clone.bea, "remote", "set-url", "origin", originUrl + "-missing");
      fs.writeFileSync(file(team.clone.bea), content + EOL);
      await runHook("post", edit("d-bea", team.clone.bea, "src/a.ts"), down("bea"));
      git(team.clone.bea, "remote", "set-url", "origin", originUrl);
    };
    const anaPushes = async (content: string) => {
      git(team.clone.ana, "pull", "-q", "--rebase", "origin", "lanes/main");
      fs.writeFileSync(file(team.clone.ana), content + EOL);
      await runHook("post", edit("d-ana", team.clone.ana, "src/a.ts"), down("ana"));
    };
    await offlineEdit("export const a = 'bea';");
    await anaPushes("export const a = 'ana';");
    const stop = await runHook("stop", { session_id: "d-bea", cwd: team.clone.bea }, down("bea"));
    assert.match(JSON.parse(stop.stdout).reason, /src\/a\.ts received newer content/);
    assert.equal(JSON.parse(stop.stdout).decision, "block", "continue the turn to re-apply");

    await offlineEdit("export const a = 'bea2';");
    await anaPushes("export const a = 'ana2';");
    const again = await runHook("stop", { session_id: "d-bea", cwd: team.clone.bea, stop_hook_active: true }, down("bea"));
    assert.equal(again.stdout, "", "already continuing: don't block again");
  });

  test("unreachable remote: the edit is still committed locally, never lost", async () => {
    git(team.clone.ana, "remote", "set-url", "origin", path.join(team.origin, "..", "missing.git"));
    fs.writeFileSync(path.join(team.clone.ana, "src", "offline.ts"), "export const offline = true;\n");
    const post = await runHook("post", edit("r-ana", team.clone.ana, "src/offline.ts"), env("ana"));
    assert.equal(post.code, 0, post.stderr);
    assert.match(git(team.clone.ana, "log", "-1", "--name-only", "--format="), /src\/offline\.ts/);
  });
});

describe("predictFiles", () => {
  let repo: ReturnType<typeof makeTeamRepo>;
  before(() => (repo = makeTeamRepo()));
  after(() => repo.cleanup());

  test("finds explicit paths and module names, ignores generic names", () => {
    assert.deepEqual(predictFiles(repo.main, "Edit src/a.ts please").sort(), ["src/a.ts"]);
    assert.deepEqual(predictFiles(repo.main, "add a route to the ROUTES table"), ["src/routes.ts"]);
    assert.deepEqual(predictFiles(repo.main, "update the index and types"), []);
  });
});

describe("withLanesHooks", () => {
  const existing = { model: "haiku", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] } };

  test("adds all Lanes hooks and keeps existing ones", () => {
    const merged = withLanesHooks(existing, "node", "/x/.lanes/hook.cjs");
    assert.equal(merged.model, "haiku");
    assert.equal(merged.hooks?.PreToolUse.length, 3);
    assert.equal(merged.hooks?.PreToolUse[2].matcher, "Read", "the team-context read heads-up (M.2)");
    assert.equal(merged.hooks?.PreToolUse[0].hooks[0].command, "my-guard");
    const pre = merged.hooks?.PreToolUse[1].hooks[0];
    assert.equal(pre?.command, 'node --no-warnings "/x/.lanes/hook.cjs" pre --lanes; exit 0');
    assert.equal(pre?.onFailure, undefined, "a crashed or timed-out hook must not block the edit (ADR-0019)");
    assert.equal(pre?.timeout, 300);
    assert.match(String(pre?.statusMessage), /coordinating with teammates/);
    for (const event of ["UserPromptSubmit", "PermissionRequest", "PostToolUse", "SessionStart", "Stop", "SessionEnd"]) assert.equal(merged.hooks?.[event].length, 1, event);
  });

  test("is idempotent", () => {
    const once = withLanesHooks(existing, "node", "/x/.lanes/hook.cjs");
    assert.deepEqual(withLanesHooks(once, "node", "/x/.lanes/hook.cjs"), once);
  });
});

describe("security helpers (spike v3c review)", () => {
  test("credentials in a prompt's first line never reach task titles or commit messages", () => {
    const line = "use sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz012345 with AKIAABCDEFGHIJKLMNOP, password=hunter2 on https://bob:pw@git.example.com/x";
    const out = redactSecrets(line);
    for (const secret of ["sk-ant-api03", "ghp_", "AKIAABCD", "hunter2", "bob:pw"]) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
    assert.equal(redactSecrets("Add a GET /health route in src/routes.ts"), "Add a GET /health route in src/routes.ts", "ordinary prompts are untouched");
  });

  test("other tools' hooks that merely look like ours are kept", () => {
    const theirs = { type: "command", command: "node", args: ["/home/x/spike-tools/hook.ts", "pre"] };
    const merged = withLanesHooks({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [theirs] }] } }, "node", "/x/.lanes/hook.cjs");
    assert.deepEqual(merged.hooks?.PreToolUse[0].hooks[0], theirs);
  });
});
