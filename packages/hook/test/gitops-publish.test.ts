// Round-2 bug hunt regressions for publishing: #106 (dependent commit blocks the rest), #107 (amended checkpoint),
// #109 (failing git add forgotten). Every test builds its own repo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "@lanes/server/server.ts";
import { checkpointAndPublish, mergeStaleWrite } from "../src/gitops.ts";
import { loadState } from "../src/hook.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
const who = (name: string) => ({ name, email: `${name}@example.com` });
const trailers = { session: "session-1", task: "Test task" };
const write = (dir: string, file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const publish = (dir: string, user: string, ...paths: string[]) => checkpointAndPublish(dir, who(user), trailers, paths);
const shared = (main: string) => git(main, "ls-tree", "-r", "--name-only", "lanes/main").split("\n");

let repo: ReturnType<typeof makeTeamRepo>;
beforeEach(() => (repo = makeTeamRepo("ana")));
afterEach(() => repo.cleanup());

describe("a Lanes commit that depends on the human's unshared commit (#106)", () => {
  test("only the dependent commit stays local; later independent ones are published", async () => {
    const ana = repo.wt.ana;
    write(ana, "src/human.ts", "export const h = 1;\n");
    git(ana, "add", "-A");
    git(ana, "commit", "-qm", "human wip");
    write(ana, "src/human.ts", "export const h = 1;\nexport const h2 = 2;\n");
    const first = await publish(ana, "ana", "src/human.ts");
    assert.equal(first.status, "conflict");

    write(ana, "src/other.ts", "export const o = 1;\n");
    const second = await publish(ana, "ana", "src/other.ts");
    assert.equal(second.status, "published");
    assert.deepEqual((second as { paths: string[] }).paths, ["src/other.ts"]);
    assert.deepEqual((second as { blocked?: string[] }).blocked, ["src/human.ts"], "the stuck file is reported");
    assert.ok(!shared(repo.main).includes("src/human.ts"), "the human's work never travels");
  });
});

describe("a checkpoint the human amended is no longer Lanes' (#107)", () => {
  test("content folded into a checkpoint does not reach lanes/main", async () => {
    const ana = repo.wt.ana;
    write(ana, "src/a.ts", "export const a = 2;\n");
    assert.equal((await publish(ana, "ana", "src/a.ts")).status, "published");
    write(ana, "src/secret-plan.ts", "export const plan = 'private';\n");
    git(ana, "add", "src/secret-plan.ts");
    git(ana, "commit", "-q", "--amend", "--no-edit");

    write(ana, "src/a.ts", "export const a = 3;\n");
    const res = await publish(ana, "ana", "src/a.ts");
    assert.equal(res.status, "published");
    assert.ok(!shared(repo.main).includes("src/secret-plan.ts"), shared(repo.main).join(","));
    assert.equal(git(repo.main, "show", "lanes/main:src/a.ts"), "export const a = 3;");
  });

  test("the agent's own published file is not reported as newer content from others", async () => {
    const ana = repo.wt.ana;
    write(ana, "src/a.ts", "export const a = 2;\n");
    assert.equal((await publish(ana, "ana", "src/a.ts")).status, "published");
    git(ana, "commit", "-q", "--amend", "--allow-empty", "-m", "reworded by the human");
    write(ana, "src/b.ts", "export const b = 2;\n");
    const res = await publish(ana, "ana", "src/b.ts");
    assert.equal(res.status, "published");
    assert.deepEqual(res.pulled ?? [], [], "nothing came from anyone else");
  });

  test("an untouched checkpoint still publishes (the fingerprint matches)", async () => {
    write(repo.wt.ana, "src/a.ts", "export const a = 2;\n");
    write(repo.wt.ana, "src/b.ts", "export const b = 2;\n");
    const res = await publish(repo.wt.ana, "ana", "src/a.ts", "src/b.ts");
    assert.equal(res.status, "published");
    assert.match(git(repo.main, "log", "-1", "--format=%B", "lanes/main"), /^Lanes-Files: [0-9a-f]{40}$/m);
  });
});

describe("a checkpoint never leaves the agent's file staged in the shared index (#204)", () => {
  // post-index-change runs every time the index is written: it records what is staged at that moment, which is what a
  // human's `git commit` made in that instant would take along.
  const watchIndex = (dir: string): (() => string) => {
    const log = path.join(dir, "..", "staged.log");
    const hooks = git(dir, "rev-parse", "--git-common-dir");
    const hook = path.join(path.resolve(dir, hooks), "hooks", "post-index-change");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\nunset GIT_INDEX_FILE\ngit diff --cached --name-only >> "${log.replace(/\\/g, "/")}"\n`, { mode: 0o755 });
    return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  };

  test("a modified file, a new file and a deleted file are committed without ever being staged", async () => {
    const ana = repo.wt.ana;
    const staged = watchIndex(ana);
    write(ana, "src/a.ts", "export const a = 2;\n");
    write(ana, "src/new.ts", "export const n = 1;\n");
    fs.rmSync(path.join(ana, "src", "routes.ts"));
    const res = await publish(ana, "ana", "src/a.ts", "src/new.ts", "src/routes.ts");
    assert.equal(res.status, "published");
    assert.deepEqual(new Set((res as { paths: string[] }).paths), new Set(["src/a.ts", "src/new.ts", "src/routes.ts"]));
    assert.ok(!shared(repo.main).includes("src/routes.ts"));
    // (git's own `commit -- <deleted path>` records a deletion in the index while it holds the index lock; that is not ours to avoid.)
    assert.equal(staged().split("\n").filter((l) => /^src\/(a|new)\.ts$/.test(l)).join(","), "", "an edit was staged in the shared index");
  });
});

describe("two checkouts that both appended at the same spot keep both sides' lines (#240)", () => {
  test("a conflict of two insertions is merged, not moved to a backup for the agent to redo", async () => {
    const repo2 = makeTeamRepo("ana", "bea");
    try {
      const { ana, bea } = repo2.wt;
      const routes = (...extra: string[]) => `export const routes = [\n  "/",\n${extra.map((r) => `  "${r}",\n`).join("")}];\n`;
      write(ana, "src/routes.ts", routes("/ana"));
      assert.equal((await publish(ana, "ana", "src/routes.ts")).status, "published");
      // bea never saw that: several lines of hers land at the same spot in one checkpoint
      write(bea, "src/routes.ts", routes("/b1", "/b2", "/b3"));
      const res = await publish(bea, "bea", "src/routes.ts");
      assert.equal(res.status, "published");
      assert.equal((res as { reapply?: { paths: string[] } }).reapply?.paths.length ?? 0, 0, "nothing for the agent to redo");
      const shared = git(repo2.main, "show", "lanes/main:src/routes.ts");
      for (const r of ["/ana", "/b1", "/b2", "/b3"]) assert.ok(shared.includes(r), `${r} missing:\n${shared}`);
    } finally {
      repo2.cleanup();
    }
  });
});

describe("a whole-file Write from a stale copy keeps the lines teammates added meanwhile (#218)", () => {
  const ROUTES = 'export const routes = [\n  "/",\n];\n';
  const setup = () => {
    const ana = repo.wt.ana;
    const turnStart = git(ana, "rev-parse", "HEAD");
    // a teammate's line arrives (what the pre-hook's sync brings in) ...
    write(ana, "src/routes.ts", 'export const routes = [\n  "/",\n  "/health",\n];\n');
    git(ana, "commit", "-qam", "teammate");
    return { ana, turnStart };
  };

  test("both sides' lines survive a clean merge", () => {
    const { ana, turnStart } = setup();
    // ... and the agent writes the whole file from the copy it read before
    write(ana, "src/routes.ts", `${ROUTES.replace('  "/",\n', '  "/",\n')}`.replace("];\n", '  "/inventory",\n];\n'));
    assert.equal(mergeStaleWrite(ana, "src/routes.ts", turnStart), "merged");
    const text = fs.readFileSync(path.join(ana, "src/routes.ts"), "utf8");
    assert.ok(text.includes('"/health"') && text.includes('"/inventory"'), text);
  });

  test("lines added at the same spot (a conflict for a plain merge) are both kept", () => {
    const { ana, turnStart } = setup();
    write(ana, "src/routes.ts", 'export const routes = [\n  "/",\n  "/other",\n];\n');
    assert.equal(mergeStaleWrite(ana, "src/routes.ts", turnStart), "merged");
    const text = fs.readFileSync(path.join(ana, "src/routes.ts"), "utf8");
    assert.ok(text.includes('"/health"') && text.includes('"/other"') && !/<<<<|>>>>/.test(text), text);
  });

  test("nothing changed since the turn started: nothing to do", () => {
    const ana = repo.wt.ana;
    write(ana, "src/routes.ts", 'export const routes = [\n  "/",\n  "/mine",\n];\n');
    assert.equal(mergeStaleWrite(ana, "src/routes.ts", git(ana, "rev-parse", "HEAD")), "same");
  });
});

describe("a failing git add is reported and retried, never forgotten (#109)", () => {
  // core.safecrlf makes `git add` refuse a file with CRLF line endings: the portable stand-in for a too-long path or a locked file.
  const MIXED = Buffer.from("a\r\nb\nc\r\n");
  const breakAdd = () => {
    git(repo.main, "config", "core.autocrlf", "input");
    git(repo.main, "config", "core.safecrlf", "true");
  };

  test("the failing path is named, its siblings still publish, and it publishes once fixed", async () => {
    breakAdd();
    const ana = repo.wt.ana;
    write(ana, "src/mixed.txt", MIXED);
    write(ana, "src/ok.ts", "export const ok = 1;\n");
    const res = await publish(ana, "ana", "src/mixed.txt", "src/ok.ts");
    assert.equal(res.status, "published");
    assert.deepEqual(res.failed, ["src/mixed.txt"]);
    assert.ok(shared(repo.main).includes("src/ok.ts"));

    write(ana, "src/mixed.txt", "a\nb\nc\n");
    const again = await publish(ana, "ana", "src/mixed.txt");
    assert.equal(again.status, "published");
    assert.ok(shared(repo.main).includes("src/mixed.txt"));
  });

  test("the hook reports it and keeps the file in the session's list at the end of the turn", async () => {
    breakAdd();
    const logFile = path.join(os.tmpdir(), `lanes-log-${process.pid}.jsonl`);
    const server = await startServer({ port: 0, logFile });
    try {
      const ana = repo.wt.ana;
      write(ana, "src/mixed.txt", MIXED);
      const run = (event: string) =>
        new Promise<void>((resolve) => {
          const env = { ...process.env, LANES_SERVER: server.url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com" };
          const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env });
          child.on("close", () => resolve());
          child.stdin.end(JSON.stringify({ session_id: "s-add", cwd: ana, tool_name: "Write", tool_input: { file_path: path.join(ana, "src", "mixed.txt") } }));
        });
      await run("post");
      await run("stop");
      assert.deepEqual(loadState("s-add").touched, ["src/mixed.txt"]);
      assert.match(fs.readFileSync(logFile, "utf8"), /publish-add-failed/);
    } finally {
      await server.close();
      fs.rmSync(logFile, { force: true });
    }
  });
});
