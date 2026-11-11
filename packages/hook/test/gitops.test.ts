// Regression tests for the hook-git bug hunt (#76 #77 #78 #79 #82 #84 #88), ported from lanes-bughunt/stress*.ts.
// Every test builds its own repo (makeTeamRepo): the machine's own home folder may itself be a git repository.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { changedPaths, checkpointAndPublish, syncFromIntegration, type PublishResult } from "../src/gitops.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
const who = (name: string) => ({ name, email: `${name}@example.com` });
const trailers = { session: "session-1", task: "Test task" };
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const shared = (main: string) => git(main, "ls-tree", "-r", "--name-only", "-z", "lanes/main").split("\0").filter(Boolean);
const publish = (dir: string, user: string, ...paths: string[]) => checkpointAndPublish(dir, who(user), trailers, paths);
const ROUTES = (v: string) => `export const routes = ["${v}"];\n`;

let repo: ReturnType<typeof makeTeamRepo>;
beforeEach(() => (repo = makeTeamRepo("ana", "bea")));
afterEach(() => repo.cleanup());

describe("byte-exact paths (#76)", () => {
  test("a non-ASCII file is published, listed and pulled under its real name", async () => {
    write(repo.wt.ana, "src/café.ts", "export const c = 1;\n");
    const res = (await publish(repo.wt.ana, "ana", "src/café.ts"));
    assert.equal(res.status, "published");
    assert.deepEqual((res as { paths: string[] }).paths, ["src/café.ts"]);
    assert.ok(shared(repo.main).includes("src/café.ts"));

    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    const bea = (await publish(repo.wt.bea, "bea", "src/b.ts")) as Extract<PublishResult, { status: "published" }>;
    assert.deepEqual(bea.pulled, ["src/café.ts"]);
  });
});

describe("conflict recovery (#77)", () => {
  test("a non-ASCII file carried over a conflict is restored, not lost", async () => {
    write(repo.wt.ana, "src/routes.ts", ROUTES("/ana"));
    assert.equal((await publish(repo.wt.ana, "ana", "src/routes.ts")).status, "published");
    write(repo.wt.bea, "src/routes.ts", ROUTES("/bea"));
    write(repo.wt.bea, "src/café.ts", "export const c = 1;\n");
    const res = (await publish(repo.wt.bea, "bea", "src/routes.ts", "src/café.ts")) as Extract<PublishResult, { status: "published" }>;
    assert.equal(res.status, "published");
    assert.deepEqual(res.reapply?.paths, ["src/routes.ts"]);
    assert.ok(shared(repo.main).includes("src/café.ts"));
    assert.equal(fs.readFileSync(path.join(repo.wt.bea, "src", "café.ts"), "utf8").trim(), "export const c = 1;");
    assert.match(git(repo.wt.bea, "show", `${res.reapply!.backup}:src/routes.ts`), /\/bea/, "the overlapping version is kept");
  });
});

describe("only Lanes' commits are published (#78)", () => {
  test("the human's own unpushed commits stay private", async () => {
    write(repo.wt.ana, "src/private-feature.ts", "export const wip = 1;\n");
    git(repo.wt.ana, "add", "-A");
    git(repo.wt.ana, "commit", "-qm", "WIP my own feature, not for sharing");
    write(repo.wt.ana, "src/a.ts", "export const a = 2;\n");
    const res = (await publish(repo.wt.ana, "ana", "src/a.ts"));
    assert.equal(res.status, "published");
    assert.ok(!shared(repo.main).includes("src/private-feature.ts"), "private commit leaked");
    assert.doesNotMatch(git(repo.main, "log", "--format=%s", "lanes/main"), /WIP my own feature/);
    assert.equal(git(repo.main, "show", "lanes/main:src/a.ts"), "export const a = 2;");
    assert.match(git(repo.wt.ana, "log", "--format=%s"), /WIP my own feature/, "and the human keeps their commit");

    write(repo.wt.ana, "src/a.ts", "export const a = 3;\n");
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts")).status, "published", "later publishes still work");
    assert.ok(!shared(repo.main).includes("src/private-feature.ts"));
    assert.equal(git(repo.main, "show", "lanes/main:src/a.ts"), "export const a = 3;");
  });

  test("the human's commits are not rewritten by a teammate's publish either", async () => {
    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    await publish(repo.wt.bea, "bea", "src/b.ts");
    write(repo.wt.ana, "src/private-feature.ts", "export const wip = 1;\n");
    git(repo.wt.ana, "add", "-A");
    git(repo.wt.ana, "commit", "-qm", "WIP");
    write(repo.wt.ana, "src/a.ts", "export const a = 2;\n");
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts")).status, "published");
    assert.deepEqual(shared(repo.main).filter((f) => /b\.ts|a\.ts|private/.test(f)).sort(), ["src/a.ts", "src/b.ts"]);
  });

  test("an edit that builds on the human's unpublished commit stays local and is reported", async () => {
    write(repo.wt.ana, "src/private-feature.ts", "export const wip = 1;\n");
    git(repo.wt.ana, "add", "-A");
    git(repo.wt.ana, "commit", "-qm", "WIP");
    write(repo.wt.ana, "src/private-feature.ts", "export const wip = 2;\n");
    const res = (await publish(repo.wt.ana, "ana", "src/private-feature.ts"));
    assert.equal(res.status, "conflict");
    assert.ok(!shared(repo.main).includes("src/private-feature.ts"));
    assert.match(git(repo.wt.ana, "log", "-1", "--format=%B"), /Lanes-Agent/, "the edit is committed locally, not lost");
  });
});

describe("dirty files are never merged into (#79)", () => {
  test("sync skips a file the human has uncommitted edits to: no markers, no stash left behind", async () => {
    write(repo.wt.ana, "src/routes.ts", ROUTES("/ana"));
    await publish(repo.wt.ana, "ana", "src/routes.ts");
    write(repo.wt.bea, "src/routes.ts", ROUTES("/human"));
    const res = syncFromIntegration(repo.wt.bea, who("bea"));
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), ROUTES("/human"));
    assert.equal(git(repo.wt.bea, "stash", "list"), "");
    assert.doesNotMatch(git(repo.wt.bea, "status", "--porcelain"), /^UU/m);
  });

  test("sync still works when the dirty files are unrelated", async () => {
    write(repo.wt.ana, "src/routes.ts", ROUTES("/ana"));
    await publish(repo.wt.ana, "ana", "src/routes.ts");
    write(repo.wt.bea, "src/notes.ts", "export const n = 1;\n");
    assert.deepEqual(syncFromIntegration(repo.wt.bea, who("bea")), { ok: true });
    assert.match(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), /\/ana/);
    assert.ok(fs.existsSync(path.join(repo.wt.bea, "src", "notes.ts")));
  });

  test("a publish never leaves markers in the human's uncommitted file either", async () => {
    write(repo.wt.ana, "src/routes.ts", ROUTES("/ana"));
    await publish(repo.wt.ana, "ana", "src/routes.ts");
    write(repo.wt.bea, "src/routes.ts", ROUTES("/human"));
    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    const res = (await publish(repo.wt.bea, "bea", "src/b.ts")); // #128: only the sync is skipped, the independent file publishes
    assert.equal(res.status, "published");
    assert.equal(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), ROUTES("/human"));
    assert.equal(git(repo.wt.bea, "stash", "list"), "");
    assert.match(git(repo.wt.bea, "log", "-1", "--format=%B"), /Lanes-Agent/, "the edit is committed locally, not lost");
  });
});

describe("one bad path cannot block the rest (#82)", () => {
  test("ignored, vanished and unchanged paths are dropped per path", async () => {
    write(repo.wt.ana, ".gitignore", ".env.local\ndist/\n");
    git(repo.wt.ana, "add", ".gitignore");
    git(repo.wt.ana, "commit", "-qm", "ignore");
    write(repo.wt.ana, ".env.local", "TOKEN=1\n");
    write(repo.wt.ana, "dist/x.js", "x\n");
    write(repo.wt.ana, "src/generated.ts", "export const g = 1;\n");
    const res = (await publish(repo.wt.ana, "ana", ".env.local", "dist/x.js", "src/ghost.ts", "src/a.ts", "src/generated.ts"));
    assert.equal(res.status, "published");
    assert.deepEqual((res as { paths: string[] }).paths, ["src/generated.ts"]);
  });
});

describe("signing (#88)", () => {
  test("a commit signer that fails does not stop the publish", async () => {
    git(repo.wt.ana, "config", "commit.gpgsign", "true");
    git(repo.wt.ana, "config", "gpg.program", "definitely-not-a-signer");
    write(repo.wt.ana, "src/a.ts", "export const a = 5;\n");
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts")).status, "published");
  });
});

describe("large status output (#84)", () => {
  test("more than 1 MB of untracked paths is read in full, not treated as empty", async () => {
    const dir = path.join(repo.wt.ana, "gen");
    fs.mkdirSync(dir);
    const stem = "f".repeat(110);
    for (let i = 0; i < 9500; i++) fs.writeFileSync(path.join(dir, `${stem}${i}`), "");
    write(repo.wt.ana, "src/new.ts", "export const n = 1;\n");
    const changed = changedPaths(repo.wt.ana);
    assert.equal(changed.length, 9501);
    assert.ok(changed.includes("src/new.ts"));
  });
});
