import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { init } from "../src/cli.ts";

// The test repo has no git identity of its own; never depend on the machine's.
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}

test("init writes the hook, merges settings keeping other hooks, and commits only its own files", () => {
  const { main, cleanup } = makeRepo();
  try {
    fs.mkdirSync(path.join(main, ".claude"));
    const theirs = { type: "command", command: "echo", args: ["mine"] };
    fs.writeFileSync(path.join(main, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [theirs] }] } }));
    fs.writeFileSync(path.join(main, "wip.txt"), "uncommitted work");
    init(main, { commit: true, assets: fakeAssets() });
    const settings = JSON.parse(fs.readFileSync(path.join(main, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.ok(settings.hooks.Stop.some((m: { hooks: unknown[] }) => m.hooks.some((h) => JSON.stringify(h) === JSON.stringify(theirs))));
    assert.ok(settings.hooks.PreToolUse);
    assert.equal(git(main, "log", "-1", "--format=%s"), "chore: set up Lanes");
    assert.match(git(main, "status", "--porcelain"), /\?\? wip\.txt/);
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")));
  } finally {
    cleanup();
  }
});

test("init twice changes nothing and makes no second commit", () => {
  const { main, cleanup } = makeRepo();
  try {
    const assets = fakeAssets();
    init(main, { commit: true, assets });
    const head = git(main, "rev-parse", "HEAD");
    init(main, { commit: true, assets });
    assert.equal(git(main, "rev-parse", "HEAD"), head);
  } finally {
    cleanup();
  }
});

test("init refuses to overwrite settings that are not valid JSON", () => {
  const { main, cleanup } = makeRepo();
  try {
    fs.mkdirSync(path.join(main, ".claude"));
    const file = path.join(main, ".claude", "settings.json");
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => init(main, { commit: false, assets: fakeAssets() }), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  } finally {
    cleanup();
  }
});

test("init refuses a home folder that is a repository", () => {
  const { main, cleanup } = makeRepo();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = process.env.USERPROFILE = main;
    assert.throws(() => init(main, { commit: false, assets: fakeAssets() }), /your home folder/);
    assert.ok(!fs.existsSync(path.join(main, ".claude")));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    cleanup();
  }
});
