// lanes init/off for Copilot and Kiro, and their sample events through the real hook (multiplayer S3.5).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { init, mcpSetup, off } from "../src/cli.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });
const HOOK = fileURLToPath(new URL("../../hook/src/hook.ts", import.meta.url));
const NO_DECISION = /deny|block|"permission|"decision"|"continue":false/;

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}

// The hook as the agent starts it, with no server: exit 0 and whatever it printed.
function hook(cwd: string, home: string, event: string, agent: string | undefined, payload: object, extraEnv: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana", ...extraEnv };
  for (const k of ["LANES_REMOTE", "CURSOR_VERSION", "GITHUB_COPILOT_API_TOKEN", "COPILOT_AGENT_PROMPT", "USER_PROMPT"]) if (!(k in extraEnv)) delete env[k];
  const res = spawnSync(process.execPath, ["--no-warnings", HOOK, event, ...(agent ? ["--lanes", agent] : [])], { cwd, input: JSON.stringify(payload), env, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("init --agents copilot,kiro writes .github/hooks/lanes.json and .kiro/hooks/lanes.json; re-init replaces ours; off keeps the user's own (S3.5)", () => {
  const { main, cleanup } = makeRepo();
  try {
    init(main, { commit: true, assets: fakeAssets() });
    assert.ok(!fs.existsSync(path.join(main, ".github")) && !fs.existsSync(path.join(main, ".kiro")), "default unchanged: Claude only");

    // The user's own hooks: another file in each folder, and one of their entries inside our file.
    const ownCopilot = { version: 1, hooks: { postToolUse: [{ type: "command", bash: "./fmt.sh" }] } };
    const ownKiro = { version: "v1", hooks: [{ name: "lint", trigger: "PostToolUse", matcher: "write", action: { type: "command", command: "npm run lint" } }] };
    fs.mkdirSync(path.join(main, ".github", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(main, ".kiro", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(main, ".github", "hooks", "mine.json"), JSON.stringify(ownCopilot));
    fs.writeFileSync(path.join(main, ".github", "hooks", "lanes.json"), JSON.stringify(ownCopilot));
    fs.writeFileSync(path.join(main, ".kiro", "hooks", "lanes.json"), JSON.stringify(ownKiro));

    const r = init(main, { commit: true, assets: fakeAssets(), agents: ["copilot", "kiro"] });
    assert.deepEqual(r.files.filter((f) => !f.startsWith(".lanes/")), [".github/hooks/lanes.json", ".kiro/hooks/lanes.json"]);

    const copilotText = fs.readFileSync(path.join(main, ".github", "hooks", "lanes.json"), "utf8");
    const copilot = JSON.parse(copilotText);
    assert.equal(copilot.version, 1);
    assert.deepEqual(Object.keys(copilot.hooks).sort(), ["agentStop", "postToolUse", "sessionEnd", "sessionStart", "userPromptSubmitted"]);
    assert.equal(copilot.hooks.postToolUse.length, 2, "the user's own entry is kept");
    assert.deepEqual(copilot.hooks.postToolUse[1], { type: "command", command: "node --no-warnings .lanes/hook.cjs post --lanes copilot ; exit 0", cwd: ".", timeoutSec: 40, matcher: "^(edit|create)$" });
    assert.doesNotMatch(copilotText, /preToolUse|permissionRequest|\$\(|\|\||2>/, "no pre-edit hook; no shell syntax beyond ;");

    const kiroText = fs.readFileSync(path.join(main, ".kiro", "hooks", "lanes.json"), "utf8");
    const kiro = JSON.parse(kiroText);
    assert.equal(kiro.version, "v1");
    assert.deepEqual(kiro.hooks.map((h: { trigger: string }) => h.trigger), ["PostToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
    assert.deepEqual(kiro.hooks[3].action, { type: "command", command: "node --no-warnings .lanes/hook.cjs post --lanes kiro ; exit 0" });
    assert.doesNotMatch(kiroText, /PreToolUse|\$\(/);
    const committed = git(main, "show", "--name-only", "--format=", "HEAD");
    assert.ok(committed.includes(".github/hooks/lanes.json") && committed.includes(".kiro/hooks/lanes.json"), committed);

    init(main, { commit: true, assets: fakeAssets(), agents: ["copilot", "kiro"] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(main, ".github", "hooks", "lanes.json"), "utf8")).hooks.postToolUse.length, 2, "re-init replaces our entries");
    assert.equal(JSON.parse(fs.readFileSync(path.join(main, ".kiro", "hooks", "lanes.json"), "utf8")).hooks.length, 5);

    const changed = off(main, { commit: true }).changed;
    assert.ok(changed.includes(".github/hooks/lanes.json") && changed.includes(".kiro/hooks/lanes.json"), changed.join());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".github", "hooks", "lanes.json"), "utf8")), ownCopilot);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".github", "hooks", "mine.json"), "utf8")), ownCopilot);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".kiro", "hooks", "lanes.json"), "utf8")), ownKiro);
    assert.deepEqual(off(main, { commit: true }).changed, [], "safe to repeat");
  } finally {
    cleanup();
  }
});

test("off deletes our files and the folders they emptied, nothing else (S3.5)", () => {
  const { main, cleanup } = makeRepo();
  try {
    fs.mkdirSync(path.join(main, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(main, ".github", "workflows", "ci.yml"), "on: push\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "ci");
    init(main, { commit: true, assets: fakeAssets(), agents: ["copilot", "kiro"] });
    off(main, { commit: true });
    assert.ok(!fs.existsSync(path.join(main, ".github", "hooks")) && !fs.existsSync(path.join(main, ".kiro")));
    assert.ok(fs.existsSync(path.join(main, ".github", "workflows", "ci.yml")));
    assert.equal(git(main, "status", "--porcelain"), "", "the removal is committed");
  } finally {
    cleanup();
  }
});

test("mcpSetup prints the Copilot add command and the Kiro mcp.json entry (S3.5)", () => {
  assert.deepEqual(mcpSetup(["copilot", "kiro"], "C:\\lanes\\lanes.cjs"), [
    'copilot mcp add lanes -- node "C:/lanes/lanes.cjs" mcp',
    'Kiro: add to ~/.kiro/settings/mcp.json: {"mcpServers":{"lanes":{"command":"node","args":["C:/lanes/lanes.cjs","mcp"]}}}',
  ]);
});

test("Copilot events through the hook: postToolUse publishes, the .claude hooks stay inert under Copilot, nothing in the cloud agent (S3.5)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    init(main, { commit: true, assets: fakeAssets(), agents: ["claude", "copilot"] });
    const common = { sessionId: "p1", timestamp: 1730000000000, cwd: main };
    const start = JSON.parse(hook(main, home, "start", "copilot", { ...common, source: "new", initialPrompt: "x" }));
    assert.match(start.additionalContext, /saved automatically as a commit/);
    assert.equal(hook(main, home, "prompt", "copilot", { ...common, prompt: "change a.ts" }), "", "output of userPromptSubmitted is ignored: print nothing");

    // Copilot also runs .claude/settings.json in the VS Code-compatible format: those hooks do nothing.
    const before = git(main, "rev-parse", "lanes/main");
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 9;\n");
    const claudeFormat = { session_id: "p1", timestamp: "2026-11-02T10:00:00Z", cwd: main, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(main, "src", "a.ts") } };
    assert.equal(hook(main, home, "pre", undefined, { ...claudeFormat, hook_event_name: "PreToolUse" }), "");
    hook(main, home, "post", undefined, claudeFormat);
    assert.equal(git(main, "rev-parse", "lanes/main"), before, "the Claude-format hook published nothing under Copilot");

    const post = hook(main, home, "post", "copilot", { ...common, toolName: "edit", toolArgs: JSON.stringify({ path: path.join(main, "src", "a.ts"), old_str: "1", new_str: "9" }), toolResult: { resultType: "success", textResultForLlm: "ok" } });
    assert.doesNotMatch(post, NO_DECISION);
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 9;");
    assert.doesNotMatch(hook(main, home, "stop", "copilot", { ...common, transcriptPath: "/t", stopReason: "end_turn" }), NO_DECISION);

    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 10;\n");
    const atCloud = git(main, "rev-parse", "lanes/main");
    assert.equal(hook(main, home, "post", "copilot", { ...common, toolName: "edit", toolArgs: { path: "src/a.ts" } }, { GITHUB_COPILOT_API_TOKEN: "t" }), "");
    assert.equal(git(main, "rev-parse", "lanes/main"), atCloud, "cloud agent: nothing published");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Kiro events through the hook: plain-text context, PostToolUse and Stop publish, never a decision (S3.5)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    init(main, { commit: true, assets: fakeAssets(), agents: ["kiro"] });
    const common = { session_id: "k1", cwd: main };
    const start = hook(main, home, "start", "kiro", { ...common, hook_event_name: "SessionStart" });
    assert.match(start, /^In this repository, each file edit you make is saved automatically/, "plain text, not JSON");
    assert.equal(hook(main, home, "prompt", "kiro", { ...common, hook_event_name: "UserPromptSubmit" }, { USER_PROMPT: "change a.ts" }), "");

    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 4;\n");
    assert.equal(hook(main, home, "post", "kiro", { ...common, hook_event_name: "PostToolUse", tool_name: "fs_write", tool_input: { command: "str_replace", path: path.join(main, "src", "a.ts") } }), "");
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 4;");

    // A write whose path the hook can't find is published at Stop, with the rest of the turn.
    fs.writeFileSync(path.join(main, "src", "c.ts"), "export const c = 1;\n");
    assert.equal(hook(main, home, "post", "kiro", { ...common, hook_event_name: "PostToolUse", tool_name: "fs_write", tool_input: { unknown: 1 } }), "");
    assert.equal(hook(main, home, "stop", "kiro", { ...common, hook_event_name: "Stop" }), "");
    assert.equal(git(main, "show", "lanes/main:src/c.ts"), "export const c = 1;");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
