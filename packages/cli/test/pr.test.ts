// `lanes pr` (b.8): squash one task from lanes/main into a new branch, one Co-authored-by per contributor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { pr } from "../src/pr.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@example.com", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@example.com" });

/** A checkpoint as the hook writes it, authored by `who`. */
function checkpoint(cwd: string, who: [string, string], session: string, task: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", "-A");
  const msg = `${task}\n\nLanes-Agent: claude-code (session ${session})\nLanes-Task: ${task}\nLanes-Files: ${"0".repeat(40)}\nCo-authored-by: Claude <noreply@anthropic.com>`;
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: who[0], GIT_AUTHOR_EMAIL: who[1] } });
}

/** main pushed to a bare origin; lanes/main carries two tasks from three people, one of them with a non-ASCII path with spaces. */
function setup(withOrigin: boolean) {
  const { main, cleanup } = makeRepo();
  const origin = path.join(path.dirname(main), "origin.git");
  git(main, "config", "user.name", "Ana");
  git(main, "config", "user.email", "ana@example.com");
  git(main, "checkout", "-q", "-b", "lanes/main");
  const bob: [string, string] = ["Bob", "Bob@Example.com"];
  checkpoint(main, ["Ana", "ana@example.com"], "aaaaaaaa", "Add login", "src/login.ts", "1\n");
  checkpoint(main, bob, "bbbbbbbb", "Fix billing", "src/billing.ts", "b\n");
  checkpoint(main, bob, "aaaaaaaa", "Add login", "src/my file ü.ts", "2\n");
  checkpoint(main, ["Cleo", "cleo@example.com"], "aaaaaaaa", "Add login", "src/login.ts", "1\n3\n");
  checkpoint(main, ["bob", "bob@example.com"], "aaaaaaaa", "Add login", "src/login.ts", "1\n3\n4\n"); // same e-mail, other case
  git(main, "checkout", "-q", "main");
  if (withOrigin) {
    git(path.dirname(main), "init", "-q", "--bare", "-b", "main", origin);
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "origin", "main", "lanes/main");
  }
  return { main, origin, cleanup };
}

test("squashes one task, dedups contributors, keeps the checkpoints and the checkout", () => {
  const { main, origin, cleanup } = setup(true);
  try {
    const lanesTip = git(main, "rev-parse", "lanes/main");
    assert.throws(() => pr(main, { gh: false }), /More than one task matches[^]*aaaaaaaa[^]*bbbbbbbb/);
    const r = pr(main, { filter: { text: "login" }, gh: false });
    assert.equal(r.branch, "lanes/pr/add-login");
    assert.equal(r.commits, 4);
    assert.deepEqual(r.commands[0], "git push -u origin lanes/pr/add-login");
    const msg = git(main, "log", "-1", "--format=%B", r.branch);
    assert.match(msg, /^Add login\n/);
    const co = msg.split("\n").filter((l) => l.startsWith("Co-authored-by:")).sort();
    assert.deepEqual(co, ["Co-authored-by: Bob <Bob@Example.com>", "Co-authored-by: Claude <noreply@anthropic.com>", "Co-authored-by: Cleo <cleo@example.com>"]);
    assert.equal(git(main, "rev-list", "--count", `main..${r.branch}`), "1");
    assert.equal(git(main, "show", `${r.branch}:src/login.ts`), "1\n3\n4".trim());
    assert.equal(git(main, "show", `${r.branch}:src/my file ü.ts`), "2");
    assert.throws(() => git(main, "show", `${r.branch}:src/billing.ts`), "the other task is not in it");
    assert.equal(git(main, "rev-parse", "lanes/main"), lanesTip, "checkpoint history untouched");
    assert.equal(git(main, "status", "--porcelain"), "", "checkout untouched");
    assert.doesNotMatch(git(main, "worktree", "list"), /lanes-pr/, "scratch worktree removed");
    assert.equal(git(origin, "branch", "--list", "lanes/pr/*"), "", "nothing pushed without gh");
    assert.throws(() => pr(main, { filter: { text: "login" }, gh: false }), /already exists/);
    assert.equal(pr(main, { filter: { session: "bbbbbbbb" }, gh: false, branch: "pr/billing" }).branch, "pr/billing");
  } finally {
    cleanup();
  }
});

test("without a remote the branch is created locally and no command is needed", () => {
  const { main, cleanup } = setup(false);
  try {
    const r = pr(main, { filter: { text: "billing" }, gh: true });
    assert.deepEqual(r.commands, []);
    assert.match(r.message, /no origin/i);
    assert.equal(git(main, "rev-list", "--count", `main..${r.branch}`), "1");
  } finally {
    cleanup();
  }
});

test("errors are plain messages", () => {
  const { main, cleanup } = setup(false);
  try {
    assert.throws(() => pr(main, { filter: { text: "nope" }, gh: false }), /No task matches/);
    git(main, "branch", "-D", "lanes/main");
    assert.throws(() => pr(main, { gh: false }), /no lanes\/main/i);
  } finally {
    cleanup();
  }
});

/** Installs a pre-commit hook in the repository (worktrees share it) and returns what a `lanes pr` rejection says. */
function rejectedBy(main: string, script: string): { message: string; tmp: string; file: string } {
  const hook = path.join(main, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  let message = "";
  try {
    pr(main, { filter: { text: "billing" }, gh: false });
  } catch (err) {
    message = (err as Error).message;
  }
  const [, tmp, file] = /git -C "(.+?)" commit -F "(.+?)"/.exec(message) ?? [];
  assert.ok(tmp && file, `no continue command in:\n${message}`);
  return { message, tmp, file };
}

test("a failing pre-commit hook is reported with its output and the scratch worktree is left to continue in (#211)", () => {
  const { main, cleanup } = setup(true);
  let tmp = "";
  try {
    const r = rejectedBy(main, 'echo "SECRET-SCANNER: found a key in src/billing.ts" >&2\nexit 1');
    tmp = r.tmp;
    assert.match(r.message, /rejected the commit/);
    assert.match(r.message, /SECRET-SCANNER: found a key in src\/billing\.ts/, "the hook's own output is shown");
    assert.doesNotMatch(r.message, /node_modules|dependencies/);
    assert.match(r.message, /--no-verify/);
    assert.equal(git(tmp, "branch", "--show-current"), "lanes/pr/fix-billing", "the scratch worktree is on the branch");
    assert.equal(git(tmp, "diff", "--cached", "--name-only"), "src/billing.ts", "the task's changes are staged there");
    assert.equal(git(main, "status", "--porcelain"), "", "the user's checkout is untouched");
    // the printed command works once the hook is satisfied
    fs.rmSync(path.join(main, ".git", "hooks", "pre-commit"));
    git(tmp, "commit", "--quiet", "-F", r.file);
    assert.equal(git(main, "rev-list", "--count", "main..lanes/pr/fix-billing"), "1");
    assert.match(git(main, "log", "-1", "--format=%B", "lanes/pr/fix-billing"), /^Fix billing\n/);
  } finally {
    if (tmp) execFileSync("git", ["worktree", "remove", "--force", tmp], { cwd: main, stdio: "ignore" });
    cleanup();
  }
});

test("a hook that fails only for lack of node_modules says so (#211)", () => {
  const { main, cleanup } = setup(false);
  let tmp = "";
  try {
    const r = rejectedBy(main, "echo \"Error: Cannot find module 'lint-staged'\" >&2\nexit 1");
    tmp = r.tmp;
    assert.match(r.message, /needs the project's dependencies[^]*npm ci/);
    assert.match(r.message, /Cannot find module 'lint-staged'/);
  } finally {
    if (tmp) execFileSync("git", ["worktree", "remove", "--force", tmp], { cwd: main, stdio: "ignore" });
    cleanup();
  }
});

test("a passing hook runs on the squash commit (no --no-verify)", () => {
  const { main, cleanup } = setup(false);
  try {
    fs.writeFileSync(path.join(main, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${path.join(main, "hook-ran.txt").replace(/\\/g, "/")}"\n`, { mode: 0o755 });
    pr(main, { filter: { text: "billing" }, gh: false });
    assert.ok(fs.existsSync(path.join(main, "hook-ran.txt")));
  } finally {
    cleanup();
  }
});
