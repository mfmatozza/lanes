// Regression tests for the round-2 bug hunt on git sync and publish (#100 #103 #108 #111). Every test builds its own repo.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkpointAndPublish, syncFromIntegration, type PublishResult } from "../src/gitops.ts";
import { git, makeRemoteTeam, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
const who = (name: string) => ({ name, email: `${name}@example.com` });
const trailers = { session: "session-1", task: "Test task" };
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const publish = (dir: string, user: string, ...paths: string[]) => checkpointAndPublish(dir, who(user), trailers, paths);
const lines = (first: string) => [first, ...Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`)].join("\n") + "\n";

let repo: ReturnType<typeof makeTeamRepo>;
beforeEach(() => (repo = makeTeamRepo("ana", "bea")));
afterEach(() => repo.cleanup());

describe("the human's own rebase is never aborted (#100)", () => {
  test("sync and publish leave a rebase in progress, and the resolution in the file, alone", async () => {
    const ana = repo.wt.ana;
    git(ana, "checkout", "-q", "-b", "base2");
    write(ana, "src/a.ts", "export const a = 'base2';\n");
    git(ana, "commit", "-qam", "base2");
    git(ana, "checkout", "-q", "-b", "topic", "agent/ana");
    write(ana, "src/a.ts", "export const a = 'topic';\n");
    git(ana, "commit", "-qam", "topic");
    assert.throws(() => git(ana, "rebase", "base2"));
    write(ana, "src/a.ts", "export const a = 'resolved';\n"); // half-done resolution

    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    assert.equal((await publish(repo.wt.bea, "bea", "src/b.ts")).status, "published");

    const synced = syncFromIntegration(ana, who("ana"));
    assert.equal(synced.ok, false);
    write(ana, "src/c.ts", "export const c = 1;\n");
    const res = await publish(ana, "ana", "src/c.ts");
    assert.equal(res.status, "conflict");
    assert.match(git(ana, "status"), /rebase in progress/);
    assert.equal(read(ana, "src/a.ts"), "export const a = 'resolved';\n");
    assert.match(git(ana, "status", "--porcelain"), /\?\? src\/c\.ts/, "not committed into the human's rebase");
  });
});

describe("renames (#103, #108)", () => {
  test("a teammate's rename counts as a clash with the human's uncommitted edit of the old name: no markers", async () => {
    write(repo.wt.ana, "src/a.ts", lines("export const a = 1;"));
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts")).status, "published");
    assert.ok(syncFromIntegration(repo.wt.bea, who("bea")).ok);

    fs.rmSync(path.join(repo.wt.ana, "src", "a.ts"));
    write(repo.wt.ana, "src/a2.ts", lines("export const a = 2;"));
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts", "src/a2.ts")).status, "published");

    write(repo.wt.bea, "src/a.ts", lines("export const a = 'bea';"));
    assert.equal(syncFromIntegration(repo.wt.bea, who("bea")).ok, false);
    assert.equal(read(repo.wt.bea, "src/a.ts"), lines("export const a = 'bea';"));
    assert.ok(!fs.existsSync(path.join(repo.wt.bea, "src", "a2.ts")));
    assert.equal(git(repo.wt.bea, "stash", "list"), "");
  });

  test("a rename survives conflict recovery as a rename, not a copy", async () => {
    write(repo.wt.ana, "src/routes.ts", 'export const routes = ["/ana"];\n');
    assert.equal((await publish(repo.wt.ana, "ana", "src/routes.ts")).status, "published");
    write(repo.wt.bea, "src/routes.ts", 'export const routes = ["/bea"];\n');
    fs.renameSync(path.join(repo.wt.bea, "src", "a.ts"), path.join(repo.wt.bea, "src", "renamed.ts"));
    const res = (await publish(repo.wt.bea, "bea", "src/routes.ts", "src/a.ts", "src/renamed.ts")) as Extract<PublishResult, { status: "published" }>;
    assert.equal(res.status, "published");
    assert.ok(res.reapply, "went through conflict recovery");
    const files = git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main");
    assert.match(files, /src\/renamed\.ts/);
    assert.doesNotMatch(files, /src\/a\.ts/);
    assert.ok(!fs.existsSync(path.join(repo.wt.bea, "src", "a.ts")));
  });
});

describe("commits already pushed are never rewritten (#111)", () => {
  test("a pushed feature branch is not rebased by a sync, and its own edits still publish", async () => {
    const team = makeRemoteTeam("ana", "bea");
    try {
      const ana = team.clone.ana;
      git(ana, "checkout", "-q", "-b", "feature/login");
      write(ana, "src/login.ts", "export const login = 1;\n");
      git(ana, "add", "-A");
      git(ana, "commit", "-qm", "login");
      git(ana, "push", "-q", "-u", "origin", "feature/login");
      const pushed = git(ana, "rev-parse", "HEAD");

      write(team.clone.bea, "src/b.ts", "export const b = 1;\n");
      assert.equal((await publish(team.clone.bea, "bea", "src/b.ts")).status, "published");

      const synced = syncFromIntegration(ana, who("ana"));
      assert.equal(synced.ok, true, "merged, not rebased (#124)");
      git(ana, "merge-base", "--is-ancestor", pushed, "HEAD");
      assert.match(read(ana, "src/b.ts"), /const b = 1/, "the teammate's content arrived");

      write(ana, "src/a.ts", "export const a = 2;\n");
      const res = await publish(ana, "ana", "src/a.ts");
      assert.equal(res.status, "published");
      assert.match(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /src\/a\.ts/);
      assert.doesNotMatch(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /login\.ts/, "the human's commit stays on their branch");
      git(ana, "merge-base", "--is-ancestor", pushed, "HEAD"); // throws if the pushed commit was rewritten
      assert.equal(git(ana, "rev-parse", "origin/feature/login"), pushed);
    } finally {
      team.cleanup();
    }
  });
});

describe("a human who pushes their own commits keeps receiving and publishing (#124)", () => {
  test("after a pushed human commit, a teammate's edit to the same file reaches the checkout and both publish", async () => {
    const team = makeRemoteTeam("ana", "bea");
    try {
      const { ana, bea } = team.clone;
      git(ana, "checkout", "-q", "-b", "main2");
      write(ana, "docs/h.md", "human\n");
      git(ana, "add", "-A");
      git(ana, "commit", "-qm", "docs: human commit");
      git(ana, "push", "-q", "-u", "origin", "main2");
      const pushed = git(ana, "rev-parse", "HEAD");

      write(bea, "src/a.ts", "export const a = 1;\nexport const triple = 3;\n");
      assert.equal((await publish(bea, "bea", "src/a.ts")).status, "published");

      assert.ok(syncFromIntegration(ana, who("ana")).ok);
      assert.match(read(ana, "src/a.ts"), /triple/);
      write(ana, "src/a.ts", read(ana, "src/a.ts") + "export const double = 2;\n");
      const res = await publish(ana, "ana", "src/a.ts");
      assert.equal(res.status, "published");
      const shared = git(team.origin, "show", "lanes/main:src/a.ts");
      assert.match(shared, /triple/);
      assert.match(shared, /double/);
      assert.doesNotMatch(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /h\.md/, "the human's commit is never published");
      assert.equal(git(ana, "rev-parse", "origin/main2"), pushed);
    } finally {
      team.cleanup();
    }
  });
});

describe("a human's uncommitted overlap only skips that file's sync (#128)", () => {
  test("other files still publish while the overlapping file stays untouched", async () => {
    write(repo.wt.ana, "src/a.ts", "export const a = 'ana';\n");
    assert.equal((await publish(repo.wt.ana, "ana", "src/a.ts")).status, "published");
    write(repo.wt.bea, "src/a.ts", "export const a = 'bea human';\n"); // uncommitted, never the agent's
    write(repo.wt.bea, "assets/data.txt", "data\n");
    const res = await publish(repo.wt.bea, "bea", "assets/data.txt");
    assert.equal(res.status, "published");
    assert.match(git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main"), /assets\/data\.txt/);
    assert.equal(read(repo.wt.bea, "src/a.ts"), "export const a = 'bea human';\n");
    assert.equal(git(repo.main, "show", "lanes/main:src/a.ts"), "export const a = 'ana';");
  });
});

describe("a branch with pushed commits keeps a linear, quiet history while publishing (#132)", () => {
  test("repeated edits publish one replay each and never merge the checkout's own tip back in", async () => {
    const team = makeRemoteTeam("ana");
    try {
      const ana = team.clone.ana;
      git(ana, "checkout", "-q", "-b", "feature/x");
      write(ana, "docs/h.md", "human\n");
      git(ana, "add", "-A");
      git(ana, "commit", "-qm", "human");
      git(ana, "push", "-q", "-u", "origin", "feature/x");
      for (let i = 0; i < 4; i++) {
        write(ana, "src/a.ts", `export const a = ${i};\n`);
        assert.equal((await publish(ana, "ana", "src/a.ts")).status, "published", `edit ${i}`);
        assert.ok(syncFromIntegration(ana, who("ana")).ok);
      }
      assert.equal(git(ana, "rev-list", "--merges", "--count", "HEAD"), "0", "no merge commits for our own publishes");
      assert.equal(git(team.origin, "show", "lanes/main:src/a.ts"), "export const a = 3;");
      assert.equal(git(team.origin, "rev-list", "--count", "lanes/main"), String(Number(git(team.origin, "rev-list", "--count", "lanes/main~4")) + 4), "exactly one commit per edit on the shared branch");
      const nothing = await publish(ana, "ana", "src/a.ts");
      assert.equal(nothing.status, "nothing");
    } finally {
      team.cleanup();
    }
  });
});

describe("a merge that conflicts is undone without touching the human's uncommitted work (#141)", () => {
  test("pushed commits + a conflicting teammate edit + an unrelated dirty file: no merge left behind, nothing lost", async () => {
    const team = makeRemoteTeam("ana", "bea");
    try {
      const { ana, bea } = team.clone;
      git(ana, "checkout", "-q", "-b", "main2");
      write(ana, "src/a.ts", "export const a = 'human';\n");
      git(ana, "commit", "-qam", "human edit");
      git(ana, "push", "-q", "-u", "origin", "main2");
      write(bea, "src/a.ts", "export const a = 'bea';\n");
      assert.equal((await publish(bea, "bea", "src/a.ts")).status, "published");
      write(ana, "src/b.ts", "export const b = 'dirty';\n");
      write(ana, "notes.txt", "mine\n");
      const synced = syncFromIntegration(ana, who("ana"));
      assert.equal(synced.ok, false, "a conflicting merge is skipped, never forced");
      assert.equal(git(ana, "status", "--porcelain").split("\n").sort().join("|"), "?? notes.txt|?? src/b.ts", "merge undone, only the human's files remain");
      assert.equal(read(ana, "src/a.ts").trim(), "export const a = 'human';");
      assert.equal(read(ana, "src/b.ts").trim(), "export const b = 'dirty';");
      assert.equal(read(ana, "notes.txt").trim(), "mine");
    } finally {
      team.cleanup();
    }
  });
});

describe("a repository that is not a Lanes repository is never committed to (#146)", () => {
  test("an origin without lanes/main: the edit is left uncommitted, nothing is pushed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-nolanes-"));
    try {
      const origin = path.join(dir, "origin.git");
      git(dir, "init", "-q", "--bare", "-b", "main", origin);
      const work = path.join(dir, "work");
      git(dir, "clone", "-q", origin, work);
      git(work, "config", "user.name", "ana");
      git(work, "config", "user.email", "ana@example.com");
      write(work, "lib.txt", "lib\n");
      git(work, "add", "-A");
      git(work, "commit", "-qm", "lib");
      git(work, "push", "-q", "origin", "main");
      const head = git(work, "rev-parse", "HEAD");
      write(work, "lib.txt", "changed\n");
      const res = await publish(work, "ana", "lib.txt");
      assert.equal(res.status, "no-integration-branch");
      assert.equal(git(work, "rev-parse", "HEAD"), head, "no commit was made");
      assert.equal(git(work, "status", "--porcelain"), "M lib.txt", "the edit is still there");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("overlapping edits on a branch with pushed commits are re-applied, never stuck (#144)", () => {
  test("the shared content wins in the checkout, the agent's version is kept, the rest publishes, the agent re-applies", async () => {
    const team = makeRemoteTeam("ana", "bea");
    try {
      const { ana, bea } = team.clone;
      git(ana, "checkout", "-q", "-b", "main2");
      write(ana, "docs/h.md", "human\n");
      git(ana, "add", "-A");
      git(ana, "commit", "-qm", "docs: human commit");
      git(ana, "push", "-q", "-u", "origin", "main2");
      const pushed = git(ana, "rev-parse", "HEAD");

      write(bea, "src/a.ts", "export const a = 'bea';\n");
      assert.equal((await publish(bea, "bea", "src/a.ts")).status, "published");

      write(ana, "src/a.ts", "export const a = 'ana';\n");
      write(ana, "src/new.ts", "export const n = 1;\n");
      const res = await publish(ana, "ana", "src/a.ts", "src/new.ts");
      assert.equal(res.status, "published");
      assert.ok(res.status === "published" && res.reapply?.paths.includes("src/a.ts"), "the agent is told to re-apply src/a.ts");
      const shared = git(team.origin, "show", "lanes/main:src/a.ts");
      assert.match(shared, /bea/, "the teammate's content stays");
      assert.match(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /src\/new\.ts/, "the non-overlapping part still publishes");
      assert.doesNotMatch(git(team.origin, "ls-tree", "-r", "--name-only", "lanes/main"), /h\.md/, "the human's commit never travels");
      assert.match(read(ana, "src/a.ts"), /bea/, "the checkout now has the shared content");
      assert.match(git(ana, "show", `${res.status === "published" ? res.reapply!.backup : ""}:src/a.ts`), /ana/, "the agent's version is kept");
      git(ana, "merge-base", "--is-ancestor", pushed, "HEAD"); // pushed history intact
      assert.equal(git(ana, "status", "--porcelain"), "");

      write(ana, "src/a.ts", "export const a = 'bea+ana';\n");
      assert.equal((await publish(ana, "ana", "src/a.ts")).status, "published", "re-applying on top publishes cleanly");
      assert.match(git(team.origin, "show", "lanes/main:src/a.ts"), /bea\+ana/);
    } finally {
      team.cleanup();
    }
  });
});
