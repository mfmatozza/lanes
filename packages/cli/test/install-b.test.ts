// `lanes init --agents` and `lanes off` for the batch B agents (multiplayer S3.6), in temp repositories, and their events
// through the real hook with the server down (LANES_AUTOSTART=0, temp LANES_HOME): exit 0, never a decision.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { AGENTS, init, mcpSetup, off } from "../src/cli.ts";
import { PLUGIN_MARKER } from "@lanes/core/agents/plugins.ts";

Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" });
const HOOK = fileURLToPath(new URL("../../hook/src/hook.ts", import.meta.url));
const NO_DECISION = /deny|block|"permission|"decision"|"continue":false/;

function fakeAssets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
  fs.writeFileSync(path.join(dir, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(dir, "server.cjs"), "// server");
  return dir;
}
const read = (root: string, file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (root: string, file: string, json: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof json === "string" ? json : JSON.stringify(json));
};
const hookEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana" };
  delete env.LANES_REMOTE;
  delete env.CURSOR_VERSION;
  return env;
};
/** The real hook, as `node hook.cjs <event> --lanes <agent>` with `payload` on stdin. */
function hook(home: string, event: string, agent: string, payload: object): string {
  const res = spawnSync(process.execPath, ["--no-warnings", HOOK, event, "--lanes", agent], { input: JSON.stringify(payload), env: hookEnv(home), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}
function withRepo(fn: (main: string, home: string) => void | Promise<void>) {
  return async () => {
    const { main, cleanup } = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
    try {
      await fn(main, home);
    } finally {
      cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

test("default init and MCP-only agents write none of the batch B files", withRepo((main) => {
  const r = init(main, { commit: true, assets: fakeAssets(), agents: ["claude", "augment", "junie", "jetbrains", "continue", "zed", "goose", "warp"] });
  assert.deepEqual(r.files, [".lanes/hook.cjs", ".lanes/server.cjs", ".claude/settings.json"]);
  for (const d of [".agents", ".factory", ".qwen", ".opencode", ".kilo", ".amp"]) assert.ok(!fs.existsSync(path.join(main, d)), d);
}));

test("init --agents antigravity,factory,qwen merges our hooks next to the user's; re-init replaces ours; off keeps theirs", withRepo((main) => {
  const ownAg = { "my-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh" }] }] } };
  const ownFactory = { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "./audit.sh", timeout: 30 }] }], PermissionRequest: [{ hooks: [{ type: "command", command: "./x.sh" }] }] };
  const ownQwen = { general: { vimMode: true }, hooks: { PreToolUse: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "echo mine" }] }] } };
  write(main, ".agents/hooks.json", ownAg);
  write(main, ".factory/hooks.json", ownFactory);
  write(main, ".qwen/settings.json", ownQwen);
  for (let i = 0; i < 2; i++) {
    const r = init(main, { commit: true, assets: fakeAssets(), agents: ["antigravity", "factory", "qwen"] });
    assert.deepEqual(r.files.slice(2), [".agents/hooks.json", ".factory/hooks.json", ".qwen/settings.json"]);
    assert.ok(r.notes.some((n) => /Antigravity.*not yet run against it/.test(n)));

    const ag = read(main, ".agents/hooks.json");
    assert.deepEqual(ag["my-linter"], ownAg["my-linter"]);
    assert.deepEqual(Object.keys(ag.lanes), ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]);
    assert.equal(ag.lanes.PreToolUse[0].matcher, "write_to_file|replace_file_content|multi_replace_file_content");
    assert.equal(ag.lanes.PreToolUse[0].hooks[0].command, `node --no-warnings "$(git rev-parse --show-toplevel)/.lanes/hook.cjs" pre --lanes antigravity; echo '{"decision":"allow"}'`);
    assert.match(ag.lanes.Stop[0].command, /stop --lanes antigravity; echo '\{"decision":"allow"\}'$/);
    assert.match(ag.lanes.SessionStart[0].command, /start --lanes antigravity; exit 0$/);
    assert.doesNotMatch(JSON.stringify(ag), /deny|auto_approve|"ask"|force_ask/);

    const factory = read(main, ".factory/hooks.json");
    assert.ok(!("hooks" in factory), "the standalone file is the event map itself");
    assert.deepEqual(Object.keys(factory).sort(), ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    assert.deepEqual(factory.PermissionRequest, ownFactory.PermissionRequest, "theirs kept, none of ours there");
    assert.equal(factory.PreToolUse.length, 2);
    assert.equal(factory.PreToolUse[1].matcher, "Edit|Create");
    assert.match(factory.PreToolUse[1].hooks[0].command, /"\$\(git rev-parse --show-toplevel\)\/\.lanes\/hook\.cjs" pre --lanes; exit 0$/);

    const qwen = read(main, ".qwen/settings.json");
    assert.deepEqual(qwen.general, ownQwen.general);
    assert.equal(qwen.hooks.PreToolUse.length, 2);
    assert.equal(qwen.hooks.PreToolUse[1].matcher, "write_file|edit");
    assert.equal(qwen.hooks.PermissionRequest[0].matcher, "write_file|edit");
    for (const text of [JSON.stringify(factory), JSON.stringify(qwen)]) assert.doesNotMatch(text, /permissionDecision|"deny"|"ask"/);
  }
  const committed = git(main, "show", "--name-only", "--format=", "HEAD");
  assert.ok([".agents/hooks.json", ".factory/hooks.json", ".qwen/settings.json"].every((f) => committed.includes(f)), committed);

  const changed = off(main, { commit: true }).changed;
  assert.ok([".agents/hooks.json", ".factory/hooks.json", ".qwen/settings.json"].every((f) => changed.includes(f)), changed.join());
  assert.deepEqual(read(main, ".agents/hooks.json"), ownAg);
  assert.deepEqual(read(main, ".factory/hooks.json"), ownFactory);
  assert.deepEqual(read(main, ".qwen/settings.json"), ownQwen);
  assert.deepEqual(off(main, { commit: true }).changed, [], "safe to repeat");
}));

test("off removes files and folders that only held our hooks", withRepo((main) => {
  init(main, { commit: true, assets: fakeAssets(), agents: ["antigravity", "factory", "qwen"] });
  off(main, { commit: true });
  for (const d of [".agents", ".factory", ".qwen"]) assert.ok(!fs.existsSync(path.join(main, d)), d);
}));

test("init --agents opencode,kilo,amp writes the plugins; re-init replaces ours, refuses a file of the user's; off keeps their plugins", withRepo((main) => {
  write(main, ".opencode/plugins/mine.js", "export const Mine = async () => ({});\n");
  write(main, ".amp/plugins/mine.ts", "export default function () {}\n");
  for (let i = 0; i < 2; i++) {
    const r = init(main, { commit: true, assets: fakeAssets(), agents: ["opencode", "kilo", "amp"] });
    assert.deepEqual(r.files.slice(2), [".opencode/plugins/lanes.js", ".kilo/plugin/lanes.js", ".amp/plugins/lanes.ts"]);
  }
  for (const f of [".opencode/plugins/lanes.js", ".kilo/plugin/lanes.js", ".amp/plugins/lanes.ts"]) {
    const text = fs.readFileSync(path.join(main, f), "utf8");
    assert.ok(text.startsWith(PLUGIN_MARKER), f);
    assert.doesNotMatch(text, /^import .* from "(?!node:)/m, "no dependency");
    assert.doesNotMatch(text, /reject-and-continue|throw /, "never refuses a tool call");
  }
  const changed = off(main, { commit: true }).changed;
  assert.ok([".opencode/plugins/lanes.js", ".kilo/plugin/lanes.js", ".amp/plugins/lanes.ts"].every((f) => changed.includes(f)), changed.join());
  assert.ok(fs.existsSync(path.join(main, ".opencode/plugins/mine.js")) && fs.existsSync(path.join(main, ".amp/plugins/mine.ts")));
  assert.ok(!fs.existsSync(path.join(main, ".kilo")), "an emptied folder is removed");

  write(main, ".opencode/plugins/lanes.js", "// the user's own lanes.js\n");
  assert.throws(() => init(main, { commit: false, assets: fakeAssets(), agents: ["opencode"] }), /is not the Lanes plugin/);
  assert.equal(fs.readFileSync(path.join(main, ".opencode/plugins/lanes.js"), "utf8"), "// the user's own lanes.js\n");
  assert.ok(!off(main, { commit: false }).changed.includes(".opencode/plugins/lanes.js"));
}));

test("mcpSetup prints a line for every batch B agent and never a user-level write", () => {
  const more = ["antigravity", "factory", "qwen", "opencode", "kilo", "amp", "augment", "junie", "jetbrains", "continue", "zed", "goose", "warp"];
  assert.ok(more.every((a) => AGENTS.includes(a)));
  const lines = mcpSetup(more, "C:\\lanes\\lanes.cjs");
  assert.equal(lines.length, more.length);
  for (const line of lines) assert.match(line, /C:\/lanes\/lanes\.cjs/);
  assert.equal(lines[5], 'amp mcp add lanes -- node "C:/lanes/lanes.cjs" mcp');
  assert.equal(lines[2], 'qwen mcp add -s user -t stdio lanes node "C:/lanes/lanes.cjs" mcp');
  assert.match(lines[3], /"mcp":\{"lanes":\{"type":"local","command":\["node","C:\/lanes\/lanes.cjs","mcp"\],"enabled":true\}\}/);
  assert.match(lines[10], /"context_servers":\{"lanes"/);
});

test("Antigravity events through the hook: start gives injectSteps, edits publish, pre/post/stop print nothing (the command echoes the reply)", withRepo((main, home) => {
  init(main, { commit: true, assets: fakeAssets(), agents: ["antigravity"] });
  const common = { conversationId: "ag1", workspacePaths: [main], transcriptPath: "/t", artifactDirectoryPath: "/a", modelName: "m" };
  const start = JSON.parse(hook(home, "start", "antigravity", common));
  assert.match(start.injectSteps[0].ephemeralMessage, /saved automatically as a commit/);
  for (const [tool, text] of [["write_to_file", "export const a = 5;\n"], ["replace_file_content", "export const a = 6;\n"]]) {
    const call = { ...common, toolCall: { name: tool, args: { TargetFile: path.join(main, "src", "a.ts") } }, stepIdx: 1 };
    assert.equal(hook(home, "pre", "antigravity", call), "");
    fs.writeFileSync(path.join(main, "src", "a.ts"), text);
    assert.equal(hook(home, "post", "antigravity", call), "");
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), text.trim());
  }
  assert.equal(hook(home, "stop", "antigravity", { ...common, executionNum: 0, terminationReason: "model_stop", fullyIdle: true }), "");
}));

test("Factory Droid and Qwen Code events through the hook: Claude's format, edits publish, never a decision", withRepo((main, home) => {
  init(main, { commit: true, assets: fakeAssets(), agents: ["factory", "qwen"] });
  const runs: [string, string, string][] = [["d1", "Create", "export const a = 7;\n"], ["d1", "Edit", "export const a = 8;\n"], ["q1", "write_file", "export const a = 9;\n"], ["q1", "edit", "export const a = 10;\n"]];
  for (const [session, tool, text] of runs) {
    const call = { session_id: session, cwd: main, transcript_path: "/t", permission_mode: "default", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: path.join(main, "src", "a.ts") } };
    assert.equal(hook(home, "pre", "", call), "", "server down: no output, never a decision");
    fs.writeFileSync(path.join(main, "src", "a.ts"), text);
    assert.doesNotMatch(hook(home, "post", "", { ...call, hook_event_name: "PostToolUse" }), NO_DECISION);
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), text.trim());
  }
  assert.doesNotMatch(hook(home, "stop", "", { session_id: "q1", cwd: main, hook_event_name: "Stop" }), NO_DECISION);
}));

test("the opencode plugin drives the real hook: an edit is published; the server being down changes nothing for the tool", withRepo(async (main, home) => {
  init(main, { commit: true, assets: fakeAssets(), agents: ["opencode"] });
  // .lanes/hook.cjs as installed, but running the hook from source.
  fs.writeFileSync(path.join(main, ".lanes", "hook.cjs"), `const r = require("child_process").spawnSync(process.execPath, ["--no-warnings", ${JSON.stringify(HOOK)}, ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(r.status ?? 0);\n`);
  const saved = { ...process.env };
  Object.assign(process.env, hookEnv(home));
  try {
    const { LanesPlugin } = await import(pathToFileURL(path.join(main, ".opencode", "plugins", "lanes.js")).href);
    const hooks = await LanesPlugin({ directory: main, worktree: main });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "op1" } } } });
    const file = path.join(main, "src", "a.ts");
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "op1", callID: "c1" }, { args: { filePath: file, oldString: "1", newString: "4" } });
    fs.writeFileSync(file, "export const a = 4;\n");
    const result = { title: "", output: "Edit applied.", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: "op1", callID: "c1" }, result);
    assert.equal(git(main, "show", "lanes/main:src/a.ts"), "export const a = 4;");
    assert.match(result.output, /^Edit applied\.\n\nIn this repository, each file edit you make is saved automatically/, "the session note arrives with the edit's result");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "op1" } } });
  } finally {
    process.env = saved;
  }
}));
