// Hook corner cases (multiplayer/research/use-cases-and-corner-cases.md, Q.1): odd git states and odd files, a damaged
// config, a refused token and a slow server. ADR-0019 throughout: the hook exits 0 with no decision, and no edit is lost.
// Every repository is a temp folder under os.tmpdir(); LANES_HOME is a temp folder; no server is auto-started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { git, makeRemoteTeam, makeRepo, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(event: string, input: object | string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

let server: RunningServer;
const env = (user: string, extra: Record<string, string> = {}) => ({ LANES_SERVER: server.url, LANES_USER: user, LANES_EMAIL: `${user}@example.com`, ...extra });
const call = (session: string, cwd: string, file: string, tool = "Edit") => ({ session_id: session, cwd, tool_name: tool, tool_input: { file_path: path.join(cwd, file) } });
before(async () => {
  server = await startServer({ port: 0 });
});
after(() => server.close());

/** pre, write, post: one agent edit through the hook, as Claude Code runs it. */
async function edit(session: string, cwd: string, file: string, content: string | Buffer, user = "ana", extra: Record<string, string> = {}, tool = "Edit") {
  const pre = await runHook("pre", call(session, cwd, file, tool), env(user, extra));
  assert.equal(pre.code, 0, pre.stderr);
  assert.doesNotMatch(pre.stdout, /permissionDecision|"decision"/);
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  const post = await runHook("post", call(session, cwd, file, tool), env(user, extra));
  assert.equal(post.code, 0, post.stderr);
  return post;
}
const shared = (repo: string, file: string, ref = "lanes/main") => git(repo, "show", `${ref}:${file}`);

test("a config.json that is valid JSON but not an object (null, a list, wrong types) never crashes the hook", async () => {
  const repo = makeTeamRepo("ana");
  try {
    for (const content of ["null", "[]", '"x"', '{"serverUrl": 5, "user": {"x": 1}, "token": []}']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-bad-"));
      fs.writeFileSync(path.join(home, "config.json"), content);
      const r = await runHook("pre", call("s-cfg", repo.wt.ana, "src/a.ts"), { LANES_HOME: home, LANES_USER: "ana", LANES_SERVER: server.url });
      assert.equal(r.code, 0, `${content}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /TypeError|at .*\.ts:\d+/, content);
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    repo.cleanup();
  }
});

test("garbage on stdin and an unknown event: exit 0, nothing printed", async () => {
  for (const [event, input] of [["pre", "{not json"], ["post", "[1,2"], ["bogus", "{}"], ["pre", ""]] as const) {
    const r = await runHook(event, input, env("ana"));
    assert.equal(r.code, 0, `${event} ${input}`);
    assert.equal(r.stdout, "");
  }
});

test("a refused token (rotated or revoked): the edit goes ahead with no decision, and is still committed and published", async () => {
  const guarded = await startServer({ port: 0, token: "the-new-token" });
  const repo = makeTeamRepo("ana");
  try {
    const extra = { LANES_SERVER: guarded.url, LANES_TOKEN: "the-old-token" };
    const post = await edit("s-tok", repo.wt.ana, "src/a.ts", "export const a = 2;\n", "ana", extra);
    assert.match(post.stderr, /coordination paused/);
    assert.equal(shared(repo.main, "src/a.ts"), "export const a = 2;", "published without the server");
    assert.equal(guarded.coordinator.snapshot().leases.length, 0);
  } finally {
    await guarded.close();
    repo.cleanup();
  }
});

test("a server that accepts the task but never answers the team brief: the prompt hook ends in about 2 s, silent", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const slow = http.createServer((req, res) => {
    if (req.url === "/v1/team/context") return; // never answers
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"task":{}}'));
  });
  slow.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  const repo = makeTeamRepo("ana");
  try {
    fs.mkdirSync(path.join(repo.wt.ana, ".lanes"), { recursive: true });
    fs.writeFileSync(path.join(repo.wt.ana, ".lanes", "team.json"), '{"context": true}');
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const r = await runHook("prompt", { session_id: "s-slow", cwd: repo.wt.ana, prompt: "Fix it" }, env("ana", { LANES_SERVER: url, LANES_TOKEN: "t" }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.ok(r.ms < 8_000, `${r.ms} ms: inside the 15 s prompt hook timeout`);
  } finally {
    for (const s of sockets) s.destroy();
    slow.close();
    repo.cleanup();
  }
});

test("detached HEAD: the edit is committed and published to the shared branch, so a later checkout cannot orphan it", async () => {
  const repo = makeTeamRepo("ana");
  try {
    git(repo.wt.ana, "checkout", "-q", "--detach");
    await edit("s-det", repo.wt.ana, "src/a.ts", "export const a = 3;\n");
    assert.equal(shared(repo.main, "src/a.ts"), "export const a = 3;");
  } finally {
    repo.cleanup();
  }
});

test("a path with spaces, #, quotes and non-ASCII parts, and a non-ASCII user name, are published byte-exact", async () => {
  const repo = makeTeamRepo("ana");
  try {
    const file = "docs/My Notes #1/Zoë's ünïcödé 文件 'x'.md";
    await edit("s-uni", repo.wt.ana, file, "# hi\n", "Zoë Ångström");
    assert.equal(shared(repo.main, file), "# hi");
    assert.equal(git(repo.main, "log", "-1", "--format=%an", "lanes/main"), "Zoë Ångström");
  } finally {
    repo.cleanup();
  }
});

test("a binary file written whole is published with its exact bytes", async () => {
  const repo = makeTeamRepo("ana");
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x0d, 0x0a]);
    await edit("s-bin", repo.wt.ana, "assets/logo.png", bytes, "ana", {}, "Write");
    const out = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const child = spawn("git", ["-C", repo.main, "show", "lanes/main:assets/logo.png"]);
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("close", () => resolve(Buffer.concat(chunks)));
    });
    assert.deepEqual(out, bytes);
  } finally {
    repo.cleanup();
  }
});

test("core.autocrlf=true with CRLF in the working tree: the edit publishes and nothing is left staged or failed", async () => {
  const repo = makeTeamRepo("ana");
  try {
    git(repo.wt.ana, "config", "core.autocrlf", "true");
    const post = await edit("s-crlf", repo.wt.ana, "src/a.ts", "export const a = 4;\r\nexport const b = 5;\r\n");
    assert.doesNotMatch(post.stdout, /failed/);
    assert.equal(shared(repo.main, "src/a.ts"), "export const a = 4;\nexport const b = 5;", "stored with LF, as git normalises");
    assert.equal(git(repo.wt.ana, "diff", "--cached", "--name-only"), "");
  } finally {
    repo.cleanup();
  }
});

test("a file deleted between the edit and its publish: exit 0, the lease is released, the checkout keeps nothing staged", async () => {
  const repo = makeTeamRepo("ana");
  try {
    const pre = await runHook("pre", call("s-del", repo.wt.ana, "src/routes.ts"), env("ana"));
    assert.equal(pre.code, 0, pre.stderr);
    fs.rmSync(path.join(repo.wt.ana, "src", "routes.ts"));
    const post = await runHook("post", call("s-del", repo.wt.ana, "src/routes.ts"), env("ana"));
    assert.equal(post.code, 0, post.stderr);
    assert.ok(!server.coordinator.snapshot().leases.some((l) => l.holder === "s-del"), "released");
    assert.equal(git(repo.wt.ana, "diff", "--cached", "--name-only"), "");
  } finally {
    repo.cleanup();
  }
});

test("a stale index.lock left by a crashed git: the edit stays on disk, and is published once the lock is gone", async () => {
  const repo = makeTeamRepo("ana");
  try {
    const lock = path.resolve(repo.wt.ana, git(repo.wt.ana, "rev-parse", "--git-path", "index.lock"));
    fs.writeFileSync(lock, "");
    await edit("s-lock", repo.wt.ana, "src/a.ts", "export const a = 6;\n");
    assert.equal(fs.readFileSync(path.join(repo.wt.ana, "src", "a.ts"), "utf8"), "export const a = 6;\n", "never lost");
    fs.rmSync(lock);
    const stop = await runHook("stop", { session_id: "s-lock", cwd: repo.wt.ana }, env("ana"));
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(shared(repo.main, "src/a.ts"), "export const a = 6;");
  } finally {
    repo.cleanup();
  }
});

test("the human switches branch between two edits: both edits reach the shared branch", async () => {
  const repo = makeTeamRepo("ana");
  try {
    await edit("s-sw", repo.wt.ana, "src/a.ts", "export const a = 7;\n");
    git(repo.wt.ana, "switch", "-q", "-c", "feature/other");
    await edit("s-sw", repo.wt.ana, "src/b.ts", "export const b = 7;\n");
    assert.equal(shared(repo.main, "src/a.ts"), "export const a = 7;");
    assert.equal(shared(repo.main, "src/b.ts"), "export const b = 7;");
  } finally {
    repo.cleanup();
  }
});

test("sparse checkout: an edit inside the cone publishes, and files outside it stay intact on the shared branch", async () => {
  const team = makeRemoteTeam("ana");
  try {
    const clone = team.clone.ana;
    fs.mkdirSync(path.join(clone, "docs"), { recursive: true });
    fs.writeFileSync(path.join(clone, "docs", "guide.md"), "guide\n");
    git(clone, "add", "docs/guide.md");
    git(clone, "commit", "-q", "-m", "docs");
    git(clone, "push", "-q", "origin", "HEAD:lanes/main");
    git(clone, "sparse-checkout", "set", "src");
    assert.ok(!fs.existsSync(path.join(clone, "docs", "guide.md")));
    await edit("s-sparse", clone, "src/a.ts", "export const a = 8;\n");
    assert.equal(shared(team.origin, "src/a.ts"), "export const a = 8;");
    assert.equal(shared(team.origin, "docs/guide.md"), "guide", "not deleted by the sparse clone");
  } finally {
    team.cleanup();
  }
});

test("a file inside a submodule: it is the submodule's own repository, so nothing is committed for it and the superproject's shared branch is untouched", async () => {
  const repo = makeTeamRepo("ana");
  const lib = makeRepo();
  try {
    git(repo.wt.ana, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.main, "lib");
    git(repo.wt.ana, "commit", "-q", "-m", "add lib");
    const before = git(repo.main, "rev-parse", "lanes/main");
    await edit("s-sub", repo.wt.ana, "lib/src/a.ts", "export const a = 9;\n");
    assert.equal(fs.readFileSync(path.join(repo.wt.ana, "lib", "src", "a.ts"), "utf8"), "export const a = 9;\n", "the edit is on disk");
    assert.equal(git(repo.main, "rev-parse", "lanes/main"), before);
    assert.equal(git(path.join(repo.wt.ana, "lib"), "status", "--porcelain"), "M src/a.ts", "left for the human, not committed");
  } finally {
    repo.cleanup();
    lib.cleanup();
  }
});
