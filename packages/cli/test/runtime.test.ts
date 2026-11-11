// #113 and #126: the committed hooks are portable (a bare node), and a machine without node on PATH gets its own
// git-ignored settings.local.json; nothing prints a visible error when node is missing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo, SH } from "../../core/test/helpers.ts";
import { withLanesHooks, type ClaudeSettings } from "../../core/src/settings.ts";
import { init } from "../src/cli.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}
const read = (main: string, name: string): ClaudeSettings => JSON.parse(fs.readFileSync(path.join(main, ".claude", name), "utf8"));
const commands = (s: ClaudeSettings) => Object.values(s.hooks ?? {}).flatMap((ms) => ms.flatMap((m) => m.hooks.map((h) => String(h.command))));
const SCRIPT = "${CLAUDE_PROJECT_DIR}/.lanes/hook.cjs";
const ON_PATH = path.dirname(process.execPath);

test("the committed settings name a bare node and no machine-specific path, however often and wherever init runs", () => {
  const { main, cleanup } = makeRepo();
  try {
    const assets = fakeAssets();
    // A repository initialised by an older Lanes on another machine: an absolute, exec-form runtime.
    fs.mkdirSync(path.join(main, ".claude"));
    fs.writeFileSync(path.join(main, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "C:\\Program Files\\nodejs\\node.exe", args: ["--no-warnings", SCRIPT, "stop", "--lanes"] }] }] } }));
    init(main, { commit: true, assets, searchPath: ON_PATH });
    const cmds = commands(read(main, "settings.json"));
    assert.equal(cmds.length, 8);
    for (const c of cmds) {
      assert.match(c, /^node --no-warnings "\$\{CLAUDE_PROJECT_DIR\}\/\.lanes\/hook\.cjs" \w+ --lanes; exit 0$/);
    }
    const head = git(main, "rev-parse", "HEAD");
    init(main, { commit: true, assets, searchPath: ON_PATH });
    assert.equal(git(main, "rev-parse", "HEAD"), head, "a second init (on another machine) changes nothing");
    assert.ok(!fs.existsSync(path.join(main, ".claude", "settings.local.json")));
  } finally {
    cleanup();
  }
});

// Claude Code shows a hook's stderr only when it exits non-zero; Copilot denies an edit on any non-zero pre-edit exit.
test("a hook whose node is missing or stale ends with exit 0 and no output", () => {
  const run = (settings: ClaudeSettings) => {
    const cmd = commands(settings).find((c) => c.includes(" pre "))!;
    return spawnSync(SH, ["-c", cmd], { env: { ...process.env, CLAUDE_PROJECT_DIR: os.tmpdir(), PATH: process.env.PATH }, encoding: "utf8", input: "{}" });
  };
  const stale = run(withLanesHooks({}, "/usr/local/no-such-dir/node", SCRIPT));
  assert.equal(stale.status, 0);
  assert.equal(stale.stdout, "");
  const missing = spawnSync(SH, ["-c", commands(withLanesHooks({}, "node", SCRIPT)).find((c) => c.includes(" pre "))!.replace(/^node /, "no-such-node-xyz ")], { env: { ...process.env, CLAUDE_PROJECT_DIR: os.tmpdir() }, encoding: "utf8", input: "{}" });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "");
});

test("Round 2: the committed command parses in Windows PowerShell and exits 0 there, so Copilot never refuses an edit", { skip: process.platform !== "win32" }, () => {
  const cmd = commands(withLanesHooks({}, "node", SCRIPT)).find((c) => c.includes(" pre "))!;
  for (const line of [cmd, cmd.replace(/^node /, "no-such-node-xyz ")]) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line], { cwd: os.tmpdir(), encoding: "utf8", input: "{}" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ParserError|Unexpected token/);
  }
});

test("Round 2: init replaces an older Lanes command (`2>/dev/null || exit 0`) instead of adding a second hook", () => {
  const old = { type: "command", command: `node --no-warnings "${SCRIPT}" stop --lanes 2>/dev/null || exit 0` };
  const merged = withLanesHooks({ hooks: { Stop: [{ hooks: [old] }] } }, "node", SCRIPT);
  assert.deepEqual(merged.hooks!.Stop.flatMap((m) => m.hooks.map((h) => h.command)), [`node --no-warnings "${SCRIPT}" stop --lanes; exit 0`]);
});

test("without node on PATH the absolute path goes into the git-ignored settings.local.json only", () => {
  const { main, cleanup } = makeRepo();
  try {
    const assets = fakeAssets();
    const { notes } = init(main, { commit: true, assets, searchPath: path.join(main, "empty") });
    assert.match(notes.join("\n"), /not on your PATH/);
    assert.ok(commands(read(main, "settings.json")).every((c) => c.startsWith("node ")), "the shared file stays portable");
    const local = commands(read(main, "settings.local.json"));
    assert.equal(local.length, 8);
    assert.ok(local.every((c) => c.includes(process.execPath.replace(/\\/g, "/"))));
    assert.equal(git(main, "ls-files", ".claude"), ".claude/settings.json", "settings.local.json is not committed");
    assert.doesNotMatch(git(main, "status", "--porcelain"), /settings\.local/, "and is ignored");
    const first = fs.readFileSync(path.join(main, ".claude", "settings.local.json"), "utf8");
    init(main, { commit: true, assets, searchPath: path.join(main, "empty") });
    assert.equal(fs.readFileSync(path.join(main, ".claude", "settings.local.json"), "utf8"), first, "idempotent");

    // Node is on PATH again: the local entries go, so no hook runs twice.
    init(main, { commit: true, assets, searchPath: ON_PATH });
    assert.ok(!fs.existsSync(path.join(main, ".claude", "settings.local.json")));
  } finally {
    cleanup();
  }
});

test("settings.local.json keeps the user's own settings when the Lanes entries are added and removed", () => {
  const { main, cleanup } = makeRepo();
  try {
    const assets = fakeAssets();
    fs.mkdirSync(path.join(main, ".claude"));
    fs.writeFileSync(path.join(main, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    init(main, { commit: false, assets, searchPath: path.join(main, "empty") });
    assert.deepEqual(read(main, "settings.local.json").permissions, { allow: ["Bash(ls)"] });
    init(main, { commit: false, assets, searchPath: ON_PATH });
    assert.deepEqual(read(main, "settings.local.json"), { permissions: { allow: ["Bash(ls)"] } });
  } finally {
    cleanup();
  }
});

test("merging hooks twice, or over another runtime, never duplicates a hook", () => {
  const theirs = { type: "command", command: "echo", args: ["mine"] };
  const once = withLanesHooks({ hooks: { Stop: [{ hooks: [theirs] }] } }, "/opt/node/bin/node", SCRIPT);
  assert.deepEqual(withLanesHooks(once, "/opt/node/bin/node", SCRIPT), once);
  const swapped = withLanesHooks(once, "C:\\node\\node.exe", SCRIPT);
  assert.equal(swapped.hooks!.Stop.flatMap((m) => m.hooks).length, 2, "theirs plus one Lanes hook");
  assert.ok(commands(swapped).some((c) => c.startsWith('"C:/node/node.exe" ')));
});
