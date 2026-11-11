// #127: Claude Code reads .claude/settings.json only from the folder it starts in, with CLAUDE_PROJECT_DIR set to it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo, SH } from "../../core/test/helpers.ts";
import type { ClaudeSettings } from "../../core/src/settings.ts";
import { init } from "../src/cli.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });

// A hook that only records that it ran and with which event.
function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), 'require("fs").appendFileSync(process.env.HOOK_OUT, process.argv[2] + "\\n");');
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}
const settingsIn = (dir: string): ClaudeSettings => JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
const preCommand = (s: ClaudeSettings) => String(s.hooks!.PreToolUse[0].hooks[0].command);

test("init run from a monorepo subfolder configures the root and that subfolder, and the hook runs from there", () => {
  const { main, cleanup } = makeRepo();
  try {
    const sub = path.join(main, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    const { files, notes } = init(sub, { commit: true, assets: fakeAssets(), searchPath: path.dirname(process.execPath) });
    assert.ok(files.includes(".claude/settings.json") && files.includes("packages/app/.claude/settings.json"), files.join());
    assert.match(notes.join("\n"), /packages\/app/);
    assert.ok(preCommand(settingsIn(main)).includes('"${CLAUDE_PROJECT_DIR}/.lanes/hook.cjs"'));
    assert.ok(preCommand(settingsIn(sub)).includes('"${CLAUDE_PROJECT_DIR}/../../.lanes/hook.cjs"'));
    assert.match(git(main, "ls-files"), /packages\/app\/\.claude\/settings\.json/, "committed with the setup");

    // The way Claude Code started in `sub` runs it: CLAUDE_PROJECT_DIR is `sub`.
    const out = path.join(os.tmpdir(), `hook-out-${process.pid}`);
    fs.rmSync(out, { force: true });
    const res = spawnSync(SH, ["-c", preCommand(settingsIn(sub))], { env: { ...process.env, CLAUDE_PROJECT_DIR: sub.replace(/\\/g, "/"), HOOK_OUT: out }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(out, "utf8").trim(), "pre");
    fs.rmSync(out, { force: true });

    const head = git(main, "rev-parse", "HEAD");
    init(sub, { commit: true, assets: fakeAssets(), searchPath: path.dirname(process.execPath) });
    assert.equal(git(main, "rev-parse", "HEAD"), head, "idempotent");
  } finally {
    cleanup();
  }
});

test("init at the root writes the root settings only", () => {
  const { main, cleanup } = makeRepo();
  try {
    fs.mkdirSync(path.join(main, "packages", "app"), { recursive: true });
    const { files } = init(main, { commit: false, assets: fakeAssets(), searchPath: path.dirname(process.execPath) });
    assert.deepEqual(files, [".lanes/hook.cjs", ".lanes/server.cjs", ".claude/settings.json"]);
    assert.ok(!fs.existsSync(path.join(main, "packages", "app", ".claude")));
  } finally {
    cleanup();
  }
});
