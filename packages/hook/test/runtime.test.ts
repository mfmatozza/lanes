// Hook runtime bugs: #81 slow commit hooks, #83 parallel hooks of one session, #85 predictFiles cost.
// Ported from lanes-bughunt/stress1.ts (parallelpost), stress2.ts (slowprecommit) and redos.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadState, predictFiles, updateState } from "../src/hook.ts";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("one session, several hooks at once (#83)", () => {
  test("concurrent state updates lose nothing", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => updateState("s-race", (s) => void s.touched.push(`f${i}.ts`))));
    assert.equal(new Set(loadState("s-race").touched).size, 25);
  });

  test("a state update survives a parallel hook reading the file all the time (#255)", async () => {
    const file = path.join(process.env.LANES_HOME!, "sessions", "s-read.json");
    await updateState("s-read", () => {});
    // A worker thread stands in for the other hooks' unlocked loadState; Windows answers EPERM to a rename over a file being read.
    const reader = new Worker(`const fs = require("node:fs"); for (;;) { try { fs.readFileSync(${JSON.stringify(file)}, "utf8"); } catch {} }`, { eval: true });
    try {
      for (let i = 0; i < 300; i++) await updateState("s-read", (s) => void s.touched.push(`f${i}.ts`));
    } finally {
      await reader.terminate();
    }
    assert.equal(loadState("s-read").touched.length, 300);
  });

  test("a corrupt state file is set aside, not silently treated as a recorded empty state", () => {
    const dir = path.join(process.env.LANES_HOME!, "sessions");
    fs.writeFileSync(path.join(dir, "s-corrupt.json"), '{"touched": ["a.ts"');
    assert.deepEqual(loadState("s-corrupt"), { touched: [] });
    assert.ok(fs.existsSync(path.join(dir, "s-corrupt.json.corrupt")), "kept for inspection");
  });

  describe("six post hooks fired together for six new files in one checkout", () => {
    let server: RunningServer;
    let repo: ReturnType<typeof makeTeamRepo>;
    before(async () => {
      server = await startServer({ port: 0 });
      repo = makeTeamRepo("ana");
    });
    after(async () => {
      await server.close();
      repo.cleanup();
    });

    test("every file is committed and published, and none is left staged", async () => {
      // A lock wait that runs out is a deliberate fail-open (ADR-0019): never let machine load decide this test.
      const env = { LANES_SERVER: server.url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com", LANES_LOCK_WAIT_MS: "300000" };
      const wt = repo.wt.ana;
      const names = Array.from({ length: 6 }, (_, i) => `src/p${i}.ts`);
      for (const n of names) fs.writeFileSync(path.join(wt, n), `export const v = "${n}";\n`);
      const results = await Promise.all(
        names.map((n) => runHook("post", { session_id: "s-par", cwd: wt, tool_name: "Write", tool_input: { file_path: path.join(wt, n) } }, env)),
      );
      for (const r of results) assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(loadState("s-par").touched.sort(), names, "no touched entry lost");
      const shared = git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main").split("\n");
      for (const n of names) assert.ok(shared.includes(n), `${n} was not published; ${JSON.stringify(results.map((r) => [r.ms | 0, r.stdout, r.stderr]))}
log=${git(wt, 'log', '--oneline', '--name-only', '-8')}
status=${git(wt, 'status', '--porcelain')}
events=${JSON.stringify(server.coordinator.snapshot())}`);
      assert.equal(git(wt, "status", "--porcelain"), "", "nothing staged or left behind");
      await runHook("stop", { session_id: "s-par", cwd: wt }, env);
      assert.deepEqual(loadState("s-par").touched, []);
    });
  });
});

describe("a repository commit hook slower than the publish is willing to wait (#81)", () => {
  let server: RunningServer;
  let repo: ReturnType<typeof makeTeamRepo>;
  before(async () => {
    server = await startServer({ port: 0 });
    repo = makeTeamRepo("ana", "bea");
  });
  after(async () => {
    await server.close();
    repo.cleanup();
  });

  test("the lease is released in time, and the commit that lands later is published by the next publish", async () => {
    const hook = path.join(repo.main, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });
    const env = { LANES_SERVER: server.url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com", LANES_COMMIT_DEADLINE_MS: "400" };
    const wt = repo.wt.ana;
    const input = { session_id: "s-slow", cwd: wt, tool_name: "Write", tool_input: { file_path: path.join(wt, "src", "slow.ts") } };
    await runHook("pre", input, env);
    assert.equal(server.coordinator.snapshot().leases.length, 1);
    fs.writeFileSync(path.join(wt, "src", "slow.ts"), "export const slow = 1;\n");

    const post = await runHook("post", input, env);
    assert.equal(post.code, 0, post.stderr);
    // The commit hook takes 8 s; the publish gives up after 400 ms. Spawning the hook can take seconds on a busy CI runner.
    assert.ok(post.ms < 6_000, `the hook waited for the slow commit hook (${Math.round(post.ms)} ms)`);
    assert.equal(server.coordinator.snapshot().leases.length, 0, "lease released although nothing could be published yet");

    // the orphaned commit finishes on its own
    for (let i = 0; i < 80 && !/slow\.ts/.test(git(wt, "log", "-1", "--name-only", "--format=")); i++) await new Promise((r) => setTimeout(r, 250));
    assert.match(git(wt, "log", "-1", "--name-only", "--format="), /slow\.ts/, "the commit was not killed");
    assert.doesNotMatch(git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main"), /slow\.ts/);

    fs.rmSync(hook);
    const later = await runHook("stop", { session_id: "s-slow", cwd: wt }, env);
    assert.equal(later.code, 0, later.stderr);
    assert.match(git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main"), /slow\.ts/, "published by the next publish");
  });
});

describe("predictFiles stays cheap (#85)", () => {
  let repo: ReturnType<typeof makeTeamRepo>;
  before(() => (repo = makeTeamRepo()));
  after(() => repo.cleanup());

  test("a 200 KB prompt without spaces is handled in well under a second", () => {
    for (const prompt of ["a".repeat(200_000), "a.".repeat(100_000), "/".repeat(200_000), "x".repeat(199_990) + " src/a.ts"]) {
      const started = performance.now();
      predictFiles(repo.main, prompt);
      assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
    }
  });

  test("paths and module names are still found, with punctuation around them", () => {
    assert.deepEqual(predictFiles(repo.main, "please look at ./src/a.ts.").sort(), ["src/a.ts"]);
    assert.deepEqual(predictFiles(repo.main, "(see src/routes.ts), then ROUTES").sort(), ["src/routes.ts"]);
  });
});
