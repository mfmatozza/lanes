import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { init, mcpSetup, off } from "../src/cli.ts";
import { editedFiles } from "../../hook/src/hook.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });
const HOOK = fileURLToPath(new URL("../../hook/src/hook.ts", import.meta.url));

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}

// A hook process the way Claude Code starts it: no LANES_REMOTE, no server (publish happens before the server call).
// `agent` is the word after --lanes in that agent's hook command; `payload` replaces the Claude-format input entirely.
function hookPost(cwd: string, file: string, home: string, event = "post", tool: object = { tool_name: "Edit", tool_input: { file_path: path.join(cwd, file) } }, agent?: string, payload?: object, extraEnv: NodeJS.ProcessEnv = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana" };
  delete env.LANES_REMOTE;
  delete env.CURSOR_VERSION;
  Object.assign(env, extraEnv);
  const input = JSON.stringify(payload ?? { session_id: "s1", cwd, ...tool });
  const res = spawnSync(process.execPath, ["--no-warnings", HOOK, event, ...(agent ? ["--lanes", agent] : [])], { input, env, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test("init with an origin creates lanes/main there, and a hook publish reaches it with no env var (#102)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    const origin = path.join(path.dirname(main), "origin.git");
    git(path.dirname(main), "init", "-q", "--bare", origin);
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "origin", "main");

    const { integration } = init(main, { commit: true, assets: fakeAssets() });
    assert.equal(integration.mode, "remote");
    assert.match(git(origin, "ls-tree", "-r", "--name-only", "lanes/main"), /\.claude\/settings\.json/);

    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 2;\n");
    hookPost(main, "src/a.ts", home);
    assert.equal(git(origin, "show", "lanes/main:src/a.ts"), "export const a = 2;");
    assert.match(git(origin, "log", "-1", "--format=%B", "lanes/main"), /Lanes-Agent: /);
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("off removes what init wrote, keeps the user's own hooks and settings, commits only that, and is safe to repeat (#252)", () => {
  const { main, cleanup } = makeRepo();
  try {
    const own = { permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } };
    fs.mkdirSync(path.join(main, ".claude"));
    fs.writeFileSync(path.join(main, ".claude", "settings.json"), JSON.stringify(own));
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "own settings");
    init(main, { commit: true, assets: fakeAssets() });
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")));
    const installed = JSON.parse(fs.readFileSync(path.join(main, ".claude", "settings.json"), "utf8"));
    assert.ok(installed.hooks.PreToolUse.some((m: { matcher?: string; hooks: { command: string }[] }) => m.matcher === "Read" && / read --lanes/.test(m.hooks[0].command)), "the Read heads-up hook (M.2)");
    fs.writeFileSync(path.join(main, "src", "wip.ts"), "// uncommitted work\n");

    const r = off(main, { commit: true });
    assert.deepEqual(r.changed.sort(), [".claude/settings.json", ".lanes/hook.cjs", ".lanes/server.cjs"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".claude", "settings.json"), "utf8")), own);
    assert.ok(!fs.existsSync(path.join(main, ".lanes")));
    assert.equal(git(main, "log", "-1", "--format=%s"), "chore: remove Lanes");
    assert.equal(git(main, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(), ".claude/settings.json,.lanes/hook.cjs,.lanes/server.cjs");
    assert.match(git(main, "status", "--porcelain"), /wip\.ts/, "other work is untouched and uncommitted");

    assert.deepEqual(off(main, { commit: true }).changed, [], "nothing left to remove");
    init(main, { commit: true, assets: fakeAssets() }); // and back on
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")));
  } finally {
    cleanup();
  }
});

test("off deletes settings.json when Lanes was all it held", () => {
  const { main, cleanup } = makeRepo();
  try {
    init(main, { commit: true, assets: fakeAssets() });
    off(main, { commit: false });
    assert.ok(!fs.existsSync(path.join(main, ".claude")), "no empty folders left behind");
    assert.match(git(main, "status", "--porcelain"), /D .claude\/settings\.json/, "--no-commit leaves the removal uncommitted");
  } finally {
    cleanup();
  }
});

test("init without an origin says so and publishes to a local lanes/main", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    const { integration } = init(main, { commit: true, assets: fakeAssets() });
    assert.equal(integration.mode, "local");
    assert.match(integration.message, /No origin remote: Lanes works on this machine only/);
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 3;\n");
    hookPost(main, "src/a.ts", home);
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 3;");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("init reuses an existing origin lanes/main and never rewrites it", () => {
  const { main, cleanup } = makeRepo();
  try {
    const origin = path.join(path.dirname(main), "origin.git");
    git(path.dirname(main), "init", "-q", "--bare", origin);
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "origin", "main:lanes/main");
    const before = git(origin, "rev-parse", "lanes/main");
    init(main, { commit: true, assets: fakeAssets() });
    assert.equal(git(origin, "rev-parse", "lanes/main"), before);
  } finally {
    cleanup();
  }
});

test("init --agents claude,codex writes .codex/hooks.json; off removes only the Lanes entries (S3.1)", () => {
  const { main, cleanup } = makeRepo();
  try {
    init(main, { commit: true, assets: fakeAssets() });
    assert.ok(!fs.existsSync(path.join(main, ".codex")), "default: Claude only, as before");

    const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    fs.mkdirSync(path.join(main, ".codex"));
    fs.writeFileSync(path.join(main, ".codex", "hooks.json"), JSON.stringify(own));
    const r = init(main, { commit: true, assets: fakeAssets(), agents: ["claude", "codex"] });
    assert.ok(r.files.includes(".codex/hooks.json") && r.files.includes(".claude/settings.json"));
    const text = fs.readFileSync(path.join(main, ".codex", "hooks.json"), "utf8");
    const codex = JSON.parse(text);
    assert.equal(codex.hooks.PreToolUse[0].matcher, "apply_patch");
    assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.lanes\/hook\.cjs" pre --lanes; exit 0$/);
    assert.equal(codex.hooks.Stop.length, 2, "the user's own Stop hook is kept");
    assert.doesNotMatch(text, /permissionDecision|"ask"/);
    assert.match(git(main, "show", "--name-only", "--format=", "HEAD"), /\.codex\/hooks\.json/);

    assert.ok(off(main, { commit: true }).changed.includes(".codex/hooks.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".codex", "hooks.json"), "utf8")), own);
  } finally {
    cleanup();
  }
});

test("mcpSetup prints one add command per agent (S3.2)", () => {
  assert.deepEqual(mcpSetup(["claude", "codex"], "/opt/lanes/lanes.cjs"), [
    'claude mcp add lanes -- node "/opt/lanes/lanes.cjs" mcp',
    'codex mcp add lanes -- node "/opt/lanes/lanes.cjs" mcp',
  ]);
});

test("editedFiles reads every file of a Codex apply_patch, and Claude's file_path as before", () => {
  const patch = "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** Add File: src/a.ts\r\n+new\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n*** Delete File: src/gone.ts\n*** End Patch\n";
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", tool_input: { command: patch } }), ["src/a.ts", "src/b.ts", "src/gone.ts", "src/new.ts", "src/old.ts"]);
  assert.deepEqual(editedFiles({ tool_name: "Edit", tool_input: { file_path: "/r/x.ts" } }), ["/r/x.ts"]);
  assert.deepEqual(editedFiles({ tool_name: "Bash", tool_input: { command: "*** Add File: x" } }), []);
});

test("a Codex apply_patch touching two files publishes both; pre fails open with no output (S3.1)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    init(main, { commit: true, assets: fakeAssets(), agents: ["codex"] });
    assert.ok(!fs.existsSync(path.join(main, ".claude")), "codex only: no Claude settings");
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const a = 1;\n+export const a = 3;\n*** Add File: src/b.ts\n+export const b = 1;\n*** End Patch\n";
    const tool = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } };
    assert.equal(hookPost(main, "", home, "pre", tool), "", "server down: no output, never a decision");
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 3;\n");
    fs.writeFileSync(path.join(main, "src", "b.ts"), "export const b = 1;\n");
    hookPost(main, "", home, "post", { ...tool, hook_event_name: "PostToolUse" });
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 3;");
    assert.equal(git(main, "show", "lanes/main:src/b.ts"), "export const b = 1;");
    off(main, { commit: true });
    assert.ok(!fs.existsSync(path.join(main, ".codex")), "an emptied .codex/ is removed");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("init --agents gemini,cursor writes .gemini/settings.json and .cursor/hooks.json; off removes only the Lanes entries (S3.4)", () => {
  const { main, cleanup } = makeRepo();
  try {
    const ownGemini = { ui: { theme: "Dracula" }, hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "echo mine" }] }] } };
    const ownCursor = { version: 1, hooks: { afterFileEdit: [{ command: "./fmt.sh" }] } };
    for (const [dir, file, json] of [[".gemini", "settings.json", ownGemini], [".cursor", "hooks.json", ownCursor]] as const) {
      fs.mkdirSync(path.join(main, dir));
      fs.writeFileSync(path.join(main, dir, file), JSON.stringify(json));
    }
    const r = init(main, { commit: true, assets: fakeAssets(), agents: ["gemini", "cursor"] });
    assert.deepEqual(r.files.filter((f) => !f.startsWith(".lanes/")), [".gemini/settings.json", ".cursor/hooks.json"]);
    assert.ok(!fs.existsSync(path.join(main, ".claude")), "no Claude settings without claude in --agents");

    const geminiText = fs.readFileSync(path.join(main, ".gemini", "settings.json"), "utf8");
    const gemini = JSON.parse(geminiText);
    assert.deepEqual(gemini.ui, ownGemini.ui, "the user's own project settings stay");
    assert.deepEqual(Object.keys(gemini.hooks).sort(), ["AfterAgent", "AfterTool", "BeforeAgent", "BeforeTool", "SessionEnd", "SessionStart"]);
    assert.equal(gemini.hooks.BeforeTool.length, 2, "the user's own BeforeTool hook is kept");
    assert.equal(gemini.hooks.BeforeTool[1].matcher, "write_file|replace");
    assert.match(gemini.hooks.BeforeTool[1].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.lanes\/hook\.cjs" pre --lanes gemini; exit 0$/);
    assert.equal(gemini.hooks.BeforeTool[1].hooks[0].timeout, 300_000, "Gemini timeouts are milliseconds");

    const cursorText = fs.readFileSync(path.join(main, ".cursor", "hooks.json"), "utf8");
    const cursor = JSON.parse(cursorText);
    assert.equal(cursor.version, 1);
    assert.deepEqual(Object.keys(cursor.hooks).sort(), ["afterFileEdit", "beforeSubmitPrompt", "sessionEnd", "sessionStart", "stop"]);
    assert.equal(cursor.hooks.afterFileEdit.length, 2, "the user's own afterFileEdit hook is kept");
    assert.match(cursor.hooks.afterFileEdit[1].command, /hook\.cjs" post --lanes cursor$/);
    assert.doesNotMatch(cursorText, /preToolUse|2>\/dev\/null|\|\|/, "no permission hook; no POSIX-only syntax for PowerShell");
    for (const text of [geminiText, cursorText]) assert.doesNotMatch(text, /deny|permission|"ask"/);
    const committed = git(main, "show", "--name-only", "--format=", "HEAD");
    assert.ok(committed.includes(".gemini/settings.json") && committed.includes(".cursor/hooks.json"), committed);

    init(main, { commit: true, assets: fakeAssets(), agents: ["gemini", "cursor"] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(main, ".cursor", "hooks.json"), "utf8")).hooks.afterFileEdit.length, 2, "safe to repeat");

    const changed = off(main, { commit: true }).changed;
    assert.ok(changed.includes(".gemini/settings.json") && changed.includes(".cursor/hooks.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".gemini", "settings.json"), "utf8")), ownGemini);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(main, ".cursor", "hooks.json"), "utf8")), ownCursor);
  } finally {
    cleanup();
  }
});

test("mcpSetup prints the Gemini add command (user scope) and the Cursor mcp.json entry (S3.4)", () => {
  const [gemini, cursor] = mcpSetup(["gemini", "cursor"], "C:\\lanes\\lanes.cjs");
  assert.equal(gemini, 'gemini mcp add --scope user lanes node "C:/lanes/lanes.cjs" mcp');
  assert.equal(cursor, 'Cursor: add to ~/.cursor/mcp.json: {"mcpServers":{"lanes":{"type":"stdio","command":"node","args":["C:/lanes/lanes.cjs","mcp"]}}}');
});

const NO_DECISION = /deny|block|"permission|"decision"|"continue":false/;

test("Gemini CLI events through the hook: write_file and replace publish, BeforeTool prints {} and never a decision (S3.4)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    init(main, { commit: true, assets: fakeAssets(), agents: ["gemini"] });
    const event = (hook_event_name: string, tool_name: string, file: string) => ({ session_id: "g1", transcript_path: "/tmp/t.json", cwd: main, hook_event_name, timestamp: "2026-11-01T10:00:00Z", tool_name, tool_input: { file_path: path.join(main, file) } });
    const start = JSON.parse(hookPost(main, "", home, "start", {}, "gemini", { session_id: "g1", cwd: main, hook_event_name: "SessionStart", source: "startup" }));
    assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(start.hookSpecificOutput.additionalContext, /saved automatically as a commit/);
    for (const [tool, file, text] of [["write_file", "src/a.ts", "export const a = 7;\n"], ["replace", "src/c.ts", "export const c = 1;\n"]]) {
      assert.equal(hookPost(main, "", home, "pre", {}, "gemini", event("BeforeTool", tool, file)), "{}", "server down: no decision, just valid JSON");
      fs.writeFileSync(path.join(main, file), text);
      assert.doesNotMatch(hookPost(main, "", home, "post", {}, "gemini", event("AfterTool", tool, file)), NO_DECISION);
      assert.equal(git(main, "show", `lanes/main:${file}`), text.trim());
    }
    assert.doesNotMatch(hookPost(main, "", home, "stop", {}, "gemini", { session_id: "g1", cwd: main, hook_event_name: "AfterAgent", prompt: "x", prompt_response: "y", stop_hook_active: false }), NO_DECISION);
    off(main, { commit: true });
    assert.ok(!fs.existsSync(path.join(main, ".gemini")), "an emptied .gemini/ is removed");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cursor events through the hook: afterFileEdit publishes, the Claude hooks stay inert inside Cursor (S3.4)", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
  try {
    init(main, { commit: true, assets: fakeAssets(), agents: ["claude", "cursor"] });
    const common = { conversation_id: "c1", generation_id: "g1", model: "m", cursor_version: "2.6.0", workspace_roots: [main], user_email: null, transcript_path: null };
    const start = JSON.parse(hookPost(main, "", home, "start", {}, "cursor", { ...common, hook_event_name: "sessionStart", session_id: "c1", is_background_agent: false }));
    assert.match(start.additional_context, /saved automatically as a commit/);
    assert.deepEqual(JSON.parse(hookPost(main, "", home, "prompt", {}, "cursor", { ...common, hook_event_name: "beforeSubmitPrompt", prompt: "change a.ts", attachments: [] })), { continue: true });

    // Cursor also runs the .claude/settings.json hooks (an Edit arrives as Write): they do nothing there.
    const before = git(main, "rev-parse", "lanes/main");
    const claudeWrite = { tool_name: "Write", tool_input: { file_path: path.join(main, "src", "a.ts") } };
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 8;\n");
    const underCursor = { session_id: "c1", cwd: main, ...claudeWrite, cursor_version: "2.6.0" };
    assert.equal(hookPost(main, "src/a.ts", home, "pre", claudeWrite, undefined, underCursor), "");
    hookPost(main, "src/a.ts", home, "post", claudeWrite, undefined, underCursor);
    assert.equal(git(main, "rev-parse", "lanes/main"), before, "the Claude-format hook published nothing under Cursor");

    const edit = hookPost(main, "", home, "post", {}, "cursor", { ...common, hook_event_name: "afterFileEdit", file_path: path.join(main, "src", "a.ts"), edits: [{ old_string: "1", new_string: "8" }] });
    assert.equal(edit, "{}");
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 8;");
    assert.doesNotMatch(hookPost(main, "", home, "stop", {}, "cursor", { ...common, hook_event_name: "stop", status: "completed", loop_count: 0 }), NO_DECISION);
    off(main, { commit: true });
    assert.ok(!fs.existsSync(path.join(main, ".cursor")), "an emptied .cursor/ is removed");
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
