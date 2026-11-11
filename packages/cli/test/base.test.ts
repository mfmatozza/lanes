// #125: lanes/main starts from the remote's default branch, never from the human's unpushed commits.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { init } from "../src/cli.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}

test("init does not push the unpushed commits of the checked-out branch", () => {
  const { main, cleanup } = makeRepo();
  try {
    const origin = path.join(path.dirname(main), "origin.git");
    git(path.dirname(main), "init", "-q", "--bare", "-b", "main", origin);
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "origin", "main");
    git(main, "checkout", "-q", "-b", "feature/payments");
    fs.writeFileSync(path.join(main, "private-notes.txt"), "wip: private unreviewed payments work\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "wip: private");
    const mainTip = git(origin, "rev-parse", "main");

    const { integration } = init(main, { commit: true, assets: fakeAssets() });
    assert.equal(integration.mode, "remote");
    const files = git(origin, "ls-tree", "-r", "--name-only", "lanes/main");
    assert.doesNotMatch(files, /private-notes/);
    assert.match(files, /\.claude\/settings\.json/);
    assert.match(files, /\.lanes\/hook\.cjs/);
    assert.doesNotMatch(git(origin, "log", "--format=%s", "lanes/main"), /private/);
    assert.equal(git(origin, "rev-parse", "lanes/main~1"), mainTip, "one setup commit on the default branch");
    assert.equal(git(origin, "rev-parse", "main"), mainTip, "the default branch is not touched");
    assert.match(git(main, "status", "--porcelain"), /^$/, "the checkout and index are untouched");
  } finally {
    cleanup();
  }
});

test("init against an empty origin creates lanes/main from the setup files alone", () => {
  const { main, cleanup } = makeRepo();
  try {
    const origin = path.join(path.dirname(main), "origin.git");
    git(path.dirname(main), "init", "-q", "--bare", origin);
    git(main, "remote", "add", "origin", origin);
    const { integration } = init(main, { commit: true, assets: fakeAssets() });
    assert.equal(integration.mode, "remote");
    assert.deepEqual(git(origin, "ls-tree", "-r", "--name-only", "lanes/main").split("\n").sort(), [".claude/settings.json", ".lanes/hook.cjs", ".lanes/server.cjs"]);
  } finally {
    cleanup();
  }
});

test("without private commits lanes/main reuses the setup commit, so pushing it later changes nothing", () => {
  const { main, cleanup } = makeRepo();
  try {
    const origin = path.join(path.dirname(main), "origin.git");
    git(path.dirname(main), "init", "-q", "--bare", "-b", "main", origin);
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "origin", "main");
    init(main, { commit: true, assets: fakeAssets() });
    assert.equal(git(origin, "rev-parse", "lanes/main"), git(main, "rev-parse", "HEAD"));
  } finally {
    cleanup();
  }
});
