// Multiplayer team context in the hook (ADR-0028): off by default, then a brief at the prompt and a heads-up before an
// edit, never a permission decision.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

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

let server: RunningServer;
let repo: ReturnType<typeof makeTeamRepo>;
const env = (user: string) => ({ LANES_SERVER: server.url, LANES_USER: user, LANES_EMAIL: `${user}@example.com` });
before(async () => {
  server = await startServer({ port: 0 });
  repo = makeTeamRepo("ana", "bea");
});
after(async () => {
  await server.close();
  repo.cleanup();
});

test("off by default: the prompt stays silent even with a teammate at work", async () => {
  await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "Add a /version route in src/routes.ts" }, env("bea"));
  const r = await runHook("prompt", { session_id: "s-ana", cwd: repo.wt.ana, prompt: "Fix the tests" }, env("ana"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("on: the prompt gets the team brief, and an edit of the teammate's file gets a heads-up but no decision", async () => {
  for (const wt of Object.values(repo.wt)) {
    fs.mkdirSync(path.join(wt, ".lanes"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".lanes", "team.json"), JSON.stringify({ context: true }));
  }
  const brief = await runHook("prompt", { session_id: "s-ana", cwd: repo.wt.ana, prompt: "Fix the tests" }, env("ana"));
  const out = JSON.parse(brief.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.match(out.additionalContext, /bea: "Add a \/version route in src\/routes\.ts" \("src\/routes\.ts"\)/);

  const pre = await runHook("pre", { session_id: "s-ana", cwd: repo.wt.ana, tool_name: "Edit", tool_input: { file_path: path.join(repo.wt.ana, "src", "routes.ts") } }, env("ana"));
  const preOut = JSON.parse(pre.stdout).hookSpecificOutput;
  assert.equal(preOut.hookEventName, "PreToolUse");
  assert.match(preOut.additionalContext, /bea's agent, working on "Add a \/version route/);
  assert.equal(preOut.permissionDecision, undefined);
});

test("on: reading a file a teammate is expected to change gets a heads-up, no decision, and is recorded (M.2)", async () => {
  const file = path.join(repo.wt.ana, "src", "routes.ts");
  const r = await runHook("read", { session_id: "s-ana-read", cwd: repo.wt.ana, tool_name: "Read", tool_input: { file_path: file } }, env("ana"));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.match(out.additionalContext, /bea's agent, working on "Add a \/version route[^]*write it to match that change/);
  assert.doesNotMatch(out.additionalContext, /needs no action/);
  assert.equal(out.permissionDecision, undefined);
  const state = fs.readdirSync(path.join(process.env.LANES_HOME!, "sessions")).find((f) => f.includes("s-ana-read"));
  assert.ok(state && fs.readFileSync(path.join(process.env.LANES_HOME!, "sessions", state), "utf8").includes("src/routes.ts"), "the read is in session state");

  const down = await runHook("read", { session_id: "s-ana-read", cwd: repo.wt.ana, tool_name: "Read", tool_input: { file_path: file } }, { ...env("ana"), LANES_SERVER: "http://127.0.0.1:1" });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "", "server down: silent");

  const team = path.join(repo.wt.ana, ".lanes", "team.json");
  fs.renameSync(team, team + ".off");
  try {
    const off = await runHook("read", { session_id: "s-ana-off", cwd: repo.wt.ana, tool_name: "Read", tool_input: { file_path: file } }, env("ana"));
    assert.equal(off.code, 0);
    assert.equal(off.stdout, "", "team context off: silent");
  } finally {
    fs.renameSync(team + ".off", team);
  }
});

test("review #10: an approved request counts as delivered only after the hook printed it and acked", async () => {
  const repoId = server.coordinator.snapshot().tasks.find((t) => t.user === "bea")!.repo;
  const post = async (route: string, body: object) =>
    (await fetch(server.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: repoId, label: "app", ...body }) })).json();
  const asked = await post("/v1/team/ask", { user: "ana", sessionId: "s-ana", to: "bea", text: "Explain the cache", scope: "read" });
  await post("/v1/team/decide", { user: "bea", sessionId: "s-bea", id: asked.id, decision: "approve" });
  const r = await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "Next" }, env("bea"));
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /"Explain the cache"/);
  const { requests } = await post("/v1/team/requests", { user: "ana", sessionId: "s-ana" });
  assert.equal(requests.find((q: { id: string }) => q.id === asked.id).status, "delivered");
});

test("on, server down: the prompt goes ahead silently (fail open)", async () => {
  const down = { ...env("ana"), LANES_SERVER: "http://127.0.0.1:1" };
  const r = await runHook("prompt", { session_id: "s-ana2", cwd: repo.wt.ana, prompt: "x" }, down);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("LANES_OFF=1 (a headless run of an approved request): the hook does nothing, so nothing is leased or published", async () => {
  const before = server.coordinator.snapshot().leases.length;
  const r = await runHook("pre", { session_id: "s-off", cwd: repo.wt.ana, tool_name: "Edit", tool_input: { file_path: path.join(repo.wt.ana, "src", "a.ts") } }, { ...env("ana"), LANES_OFF: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(server.coordinator.snapshot().leases.length, before);
  assert.ok(!server.coordinator.snapshot().agents.some((a) => a.sessionId === "s-off"));
});

test("on: a teammate's change that a pre-edit sync brings in still blocks the turn end once (timing sweep, 12 Nov)", async () => {
  const call = (session: string, cwd: string, rel: string, tool = "Edit") => ({ session_id: session, cwd, tool_name: tool, tool_input: { file_path: path.join(cwd, ...rel.split("/")) } });
  for (const wt of Object.values(repo.wt)) {
    fs.mkdirSync(path.join(wt, ".lanes"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".lanes", "team.json"), JSON.stringify({ context: true }));
  }
  // bea's turn starts and she reads a file ana is about to change.
  assert.equal((await runHook("prompt", { session_id: "s-bea-sync", cwd: repo.wt.bea, prompt: "Add src/caller.ts" }, env("bea"))).code, 0);
  assert.equal((await runHook("read", call("s-bea-sync", repo.wt.bea, "src/routes.ts", "Read"), env("bea"))).code, 0);
  // ana changes it and publishes.
  assert.equal((await runHook("pre", call("s-ana-sync", repo.wt.ana, "src/routes.ts"), env("ana"))).code, 0);
  fs.writeFileSync(path.join(repo.wt.ana, "src", "routes.ts"), "export const paths = [\n  \"/\",\n];\n");
  assert.equal((await runHook("post", call("s-ana-sync", repo.wt.ana, "src/routes.ts"), env("ana"))).code, 0);
  assert.equal((await runHook("stop", { session_id: "s-ana-sync", cwd: repo.wt.ana }, env("ana"))).code, 0);
  // bea's first write syncs ana's change into her checkout before the write: no publish of hers pulls it later.
  assert.equal((await runHook("pre", call("s-bea-sync", repo.wt.bea, "src/caller.ts", "Write"), env("bea"))).code, 0);
  assert.match(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), /paths/, "the pre-edit sync brought ana's change in");
  fs.writeFileSync(path.join(repo.wt.bea, "src", "caller.ts"), "import { routes } from \"./routes.ts\";\nexport const n = routes.length;\n");
  assert.equal((await runHook("post", call("s-bea-sync", repo.wt.bea, "src/caller.ts", "Write"), env("bea"))).code, 0);
  const stop = await runHook("stop", { session_id: "s-bea-sync", cwd: repo.wt.bea }, env("bea"));
  assert.equal(stop.code, 0, stop.stderr);
  const out = JSON.parse(stop.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /src\/routes\.ts, which your code uses/);
});
