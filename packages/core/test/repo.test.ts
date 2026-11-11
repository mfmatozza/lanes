import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { findRepo, gitDirOf, locate, normalizeRemote, relativePath } from "../src/repo.ts";
import { git, makeRepo } from "./helpers.ts";

// The repository cache lives in ~/.lanes; keep the tests out of the real one.
process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));

describe("repository identity", () => {
  let repo: ReturnType<typeof makeRepo>;
  before(() => (repo = makeRepo()));
  after(() => repo.cleanup());

  test("same file via main checkout and via worktree maps to the same lease key (H4)", () => {
    const fromMain = locate(path.join(repo.main, "src", "a.ts"));
    const fromWorktree = locate(path.join(repo.worktree, "src", "a.ts"));
    assert.ok(fromMain && fromWorktree);
    assert.equal(fromMain.repo.id, fromWorktree.repo.id);
    assert.equal(fromMain.path, "src/a.ts");
    assert.equal(fromWorktree.path, "src/a.ts");
    assert.notEqual(fromMain.repo.root, fromWorktree.repo.root);
  });

  test("file names that merely start with '..' are inside the repository; real parents are not (#92)", () => {
    assert.equal(locate(path.join(repo.main, "..weird.ts"))?.path, "..weird.ts");
    assert.equal(locate(path.join(repo.main, "..cache", "x.ts"))?.path, "..cache/x.ts");
    const info = findRepo(repo.main)!;
    assert.equal(relativePath(info, path.join(repo.main, "..", "elsewhere.ts")), null);
    assert.equal(relativePath(info, path.dirname(repo.main)), null);
  });

  test("a file that doesn't exist yet, in new directories, still resolves", () => {
    const loc = locate(path.join(repo.worktree, "src", "features", "flags", "index.ts"));
    assert.equal(loc?.path, "src/features/flags/index.ts");
  });

  test("paths outside any repository resolve to null", () => {
    assert.equal(findRepo(path.parse(os.tmpdir()).root), null);
  });

  test("the origin remote becomes the repository ID, for main checkout and worktree alike", () => {
    const withRemote = makeRepo();
    try {
      git(withRemote.main, "remote", "add", "origin", "https://user:token@GitHub.com/Acme/App.git");
      assert.equal(findRepo(path.join(withRemote.main, "src", "a.ts"))?.id, "github.com/acme/app");
      assert.equal(findRepo(path.join(withRemote.worktree, "src", "a.ts"))?.id, "github.com/acme/app");
    } finally {
      withRemote.cleanup();
    }
  });

  // macOS reaches temp folders through /var → /private/var; any symlinked path must map to the same lease.
  test("a path through a symlinked directory maps to the same lease key", { skip: process.platform === "win32" && "symlinks need admin on Windows" }, () => {
    const link = path.join(path.dirname(repo.main), "app-link");
    fs.symlinkSync(repo.main, link, "dir");
    const viaLink = locate(path.join(link, "src", "a.ts"));
    const direct = locate(path.join(repo.main, "src", "a.ts"));
    assert.deepEqual([viaLink?.repo.id, viaLink?.path], [direct?.repo.id, "src/a.ts"]);
    assert.equal(locate(path.join(link, "src", "new", "b.ts"))?.path, "src/new/b.ts", "files that don't exist yet too");
  });

  // Default macOS and Windows disks ignore case: src/A.TS is src/a.ts, so it must be the same lease.
  test("on a case-insensitive disk, a differently-cased path maps to the same lease key", (t) => {
    const upper = path.join(repo.main, "SRC", "A.TS");
    if (!fs.existsSync(upper)) return t.skip("case-sensitive file system");
    assert.equal(locate(upper)?.path, "src/a.ts");
    assert.equal(locate(path.join(repo.main, "SRC", "new.ts"))?.path, "src/new.ts", "existing directories take their on-disk case");
  });

  test("Windows: drive-letter case and backslashes don't matter", { skip: process.platform !== "win32" }, () => {
    const file = path.join(repo.main, "src", "a.ts");
    const lowerDrive = file[0].toLowerCase() + file.slice(1);
    assert.equal(locate(lowerDrive)?.path, "src/a.ts");
    assert.equal(locate(file.replaceAll("\\", "/"))?.path, "src/a.ts");
  });
});

describe("normalizeRemote", () => {
  const cases: [string, string][] = [
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["https://github.com/acme/app.git", "github.com/acme/app"],
    ["https://user:tok@github.com/acme/app/", "github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "github.com/acme/app"],
    ["ssh://git@gitlab.example.com/group/sub/app", "gitlab.example.com/group/sub/app"],
  ];
  for (const [input, expected] of cases) {
    test(input, () => assert.equal(normalizeRemote(input), expected));
  }
});

describe("repository identity disk cache (spike v3 latency)", () => {
  const REPO_TS = new URL("../src/repo.ts", import.meta.url).href;
  // A fresh process per call, like each hook invocation, so only the disk cache can carry state.
  const idIn = (dir: string) =>
    execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `import { findRepo } from ${JSON.stringify(REPO_TS)}; console.log(findRepo(${JSON.stringify(dir)})?.id)`], { encoding: "utf8" }).trim();

  test("a changed origin URL is picked up, not served stale from the cache", () => {
    const repo = makeRepo();
    try {
      git(repo.main, "remote", "add", "origin", "git@github.com:acme/old.git");
      assert.equal(idIn(repo.main), "github.com/acme/old");
      assert.equal(idIn(repo.main), "github.com/acme/old", "served from cache");
      git(repo.main, "remote", "set-url", "origin", "https://github.com/acme/new.git");
      assert.equal(idIn(repo.main), "github.com/acme/new");
    } finally {
      repo.cleanup();
    }
  });
});

describe("identity without launching git (#132)", () => {
  test("agrees with git for a clone, a linked worktree and an SSH-style URL, and notices a changed origin", () => {
    const r = makeRepo();
    try {
      git(r.main, "remote", "add", "origin", "git@GitHub.com:Acme/App.git");
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
      const saved = process.env.PATH;
      process.env.PATH = bin; // any git launch would now fail: the answer must come from the files
      try {
        for (const dir of [r.main, r.worktree]) {
          const info = findRepo(path.join(dir, "src", "a.ts"));
          assert.equal(info?.id, "github.com/acme/app");
          assert.equal(info?.root, fs.realpathSync.native(dir));
        }
      } finally {
        process.env.PATH = saved;
      }
      assert.equal(gitDirOf(r.main), path.join(r.main, ".git"));
      assert.match(gitDirOf(r.worktree) ?? "", /worktrees/);
    } finally {
      r.cleanup();
    }
  });

  test("a config git must interpret (an include, quoting) is left to git", () => {
    const r = makeRepo();
    try {
      git(r.main, "remote", "add", "origin", "https://example.com/a/b.git");
      fs.appendFileSync(path.join(r.main, ".git", "config"), "[include]\n\tpath = extra\n");
      fs.writeFileSync(path.join(r.main, ".git", "extra"), '[remote "origin"]\n\turl = https://example.com/c/d.git\n');
      assert.equal(findRepo(r.main)?.id, "example.com/c/d");
    } finally {
      r.cleanup();
    }
  });
});

const CONFIG = '[remote "origin"]\n\turl = C:\\\\repos\\\\App.git\n';
test("an origin that is a Windows path (stored with doubled backslashes) is read without git too (#132)", () => {
  const r = makeRepo();
  try {
    fs.appendFileSync(path.join(r.main, ".git", "config"), CONFIG); // as git writes it: backslashes doubled
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.equal(findRepo(r.main)?.id, normalizeRemote("C:\\repos\\App.git"));
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    r.cleanup();
  }
});
