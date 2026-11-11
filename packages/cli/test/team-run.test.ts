// `lanes approve --run` (multiplayer slice 5): runs an approved request with the receiver's agent and sends the answer back.
// The agent is a stand-in (LANES_REQUEST_AGENT) that echoes the prompt it got on stdin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { git, makeRepo } from "../../hook/test/helpers.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
let server: RunningServer;
let repo: ReturnType<typeof makeRepo>;
before(async () => {
  server = await startServer({ port: 0 });
  repo = makeRepo();
});
after(async () => {
  await server.close();
  repo.cleanup();
});

const ECHO = [process.execPath, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync('agent-was-here.txt',s+' ARGS='+process.argv.slice(1).join(' ')+' LANES_OFF='+process.env.LANES_OFF);console.log('ANSWER: '+s.slice(s.lastIndexOf(String.fromCharCode(10))+1))})", "--"];
function lanes(user: string, ...args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, "--dir", repo.main], { env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: server.url, LANES_USER: user, LANES_REQUEST_AGENT: JSON.stringify(ECHO), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("read scope: runs in the checkout, the answer goes back to the asker, and the asker's agent sees it", async () => {
  const asked = await lanes("ana", "ask", "bea", "Where is the cache configured?");
  const id = /Request (\w+)/.exec(asked.out)![1];
  const run = await lanes("bea", "approve", id, "--run");
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /ANSWER: Where is the cache configured\?/);
  const seen = fs.readFileSync(path.join(repo.main, "agent-was-here.txt"), "utf8");
  assert.match(seen, /teammate ana \(read only: do not edit files\)/);
  assert.match(seen, / ARGS=-p --permission-mode plan LANES_OFF=1$/, "Claude Code in plan mode by default");
  fs.rmSync(path.join(repo.main, "agent-was-here.txt"));
  const ctx = await fetch(server.url + "/v1/team/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "ana", sessionId: "s-ana", repo: (await (await fetch(server.url + "/v1/state")).json()).team.requests[0].repo }) }).then((r) => r.json());
  assert.match(ctx.text, /Reply from bea's agent .*ANSWER: Where is the cache configured\?/);
});

test("edit scope: runs in a separate worktree on its own branch, never in the receiver's checkout", async () => {
  const asked = await lanes("ana", "ask", "bea", "Add a README", "--edit");
  const id = /Request (\w+)/.exec(asked.out)![1];
  const run = await lanes("bea", "approve", id, "--run");
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, new RegExp(`branch lanes/request-${id}`));
  assert.ok(!fs.existsSync(path.join(repo.main, "agent-was-here.txt")), "not in the receiver's checkout");
  const worktree = /\(worktree (.+?)\)/.exec(run.out)![1];
  assert.match(fs.readFileSync(path.join(worktree, "agent-was-here.txt"), "utf8"), /LANES_OFF=1$/, "the repository's Lanes hooks are off for the run");
  assert.match(git(repo.main, "log", "-1", "--format=%s", `lanes/request-${id}`), /^Request from ana: Add a README/, "committed on the request branch");
  assert.throws(() => git(repo.main, "rev-parse", "--verify", "lanes/main"), "nothing published to a shared branch");
  assert.match(git(repo.main, "branch", "--list", `lanes/request-${id}`), /request/);
  git(repo.main, "worktree", "remove", "--force", worktree);
});

test("--agent codex: codex exec reads the prompt from stdin, in the read-only sandbox or, to edit, workspace-write in the request worktree", async () => {
  const read = /Request (\w+)/.exec((await lanes("ana", "ask", "bea", "Explain the cache")).out)![1];
  const r1 = await lanes("bea", "approve", read, "--run", "--agent", "codex");
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Running it with Codex/);
  assert.match(fs.readFileSync(path.join(repo.main, "agent-was-here.txt"), "utf8"), / ARGS=exec --sandbox read-only - LANES_OFF=1$/);
  fs.rmSync(path.join(repo.main, "agent-was-here.txt"));
  const edit = /Request (\w+)/.exec((await lanes("ana", "ask", "bea", "Fix it", "--edit")).out)![1];
  const r2 = await lanes("bea", "approve", edit, "--run", "--agent", "codex");
  assert.equal(r2.code, 0, r2.err);
  const worktree = /\(worktree (.+?)\)/.exec(r2.out)![1];
  assert.match(fs.readFileSync(path.join(worktree, "agent-was-here.txt"), "utf8"), / ARGS=exec --sandbox workspace-write - LANES_OFF=1$/);
  git(repo.main, "worktree", "remove", "--force", worktree);
});

test("--agent must be claude or codex, checked before anything is approved", async () => {
  const id = /Request (\w+)/.exec((await lanes("ana", "ask", "bea", "Anything else")).out)![1];
  const run = await lanes("bea", "approve", id, "--run", "--agent", "gemini");
  assert.equal(run.code, 2);
  assert.match(run.err, /--agent is claude or codex/);
  const state = await (await fetch(server.url + "/v1/state")).json();
  assert.equal(state.team.requests.find((q: { id: string }) => q.id === id).status, "pending");
});

test("only the receiver can run it", async () => {
  const asked = await lanes("ana", "ask", "bea", "Anything");
  const id = /Request (\w+)/.exec(asked.out)![1];
  const run = await lanes("ana", "approve", id, "--run");
  assert.equal(run.code, 1);
  assert.match(run.err, /only the receiver/);
});
