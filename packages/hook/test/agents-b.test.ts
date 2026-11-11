// Batch B agents (multiplayer S3.6): Antigravity payloads and output, and the opencode, Kilo and Amp plugins run in a fake
// plugin host against a fake .lanes/hook.cjs that records what it was given.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { contextOutput, defaultOutput, editedFiles, fromAgent } from "../src/hook.ts";
import { PLUGIN_FILES } from "@lanes/core/agents/plugins.ts";

test("Antigravity: conversationId is the session, toolCall.args.TargetFile the file, write_to_file a whole-file Write", () => {
  const common = { conversationId: "a1", workspacePaths: ["/r"], transcriptPath: "/t", artifactDirectoryPath: "/a", modelName: "m" };
  const write = fromAgent("antigravity", { ...common, toolCall: { name: "write_to_file", args: { TargetFile: "/r/src/a.ts", CodeContent: "x" } }, stepIdx: 3 });
  assert.deepEqual(write, { session_id: "a1", cwd: "/r", tool_name: "Write", tool_input: { file_path: "/r/src/a.ts" } });
  assert.deepEqual(editedFiles(write), ["/r/src/a.ts"]);
  const replace = fromAgent("antigravity", { ...common, toolCall: { name: "replace_file_content", args: { TargetFile: "/r/b.ts" } } });
  assert.equal(replace.tool_name, "replace_file_content", "a partial edit is not merged as a whole-file write");
  assert.deepEqual(fromAgent("antigravity", common), { session_id: "a1", cwd: "/r" });
  assert.deepEqual(editedFiles(fromAgent("antigravity", { ...common, toolCall: { name: "run_command", args: { CommandLine: "ls" } } })), []);
});

test("Antigravity: context only at SessionStart (injectSteps), and the hook itself prints nothing else", () => {
  assert.deepEqual(contextOutput("antigravity", "SessionStart", "x"), { injectSteps: [{ ephemeralMessage: "x" }] });
  for (const e of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) assert.equal(contextOutput("antigravity", e, "x"), undefined);
  for (const e of ["pre", "post", "stop", "start"]) assert.equal(defaultOutput("antigravity", e), undefined, "the decision is echoed by the hook command");
});

// A plugin as each host loads it: <dir>/<plugin file>, with a fake hook at <dir>/.lanes/hook.cjs.
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const FAKE_HOOK = `const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
fs.appendFileSync(process.env.LANES_FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
if (process.env.LANES_FAKE_MODE === "crash") { process.stdout.write("not json"); process.exit(1); }
const event = process.argv[2];
if (event !== "stop") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext: event + "-note" } }));
`;
async function load(agent: string, mode = ""): Promise<{ mod: any; dir: string; log: () => { argv: string[]; input: any }[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanes-plugin-${agent}-`));
  dirs.push(dir);
  const file = path.join(dir, PLUGIN_FILES[agent].file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PLUGIN_FILES[agent].source);
  fs.mkdirSync(path.join(dir, ".lanes"));
  fs.writeFileSync(path.join(dir, ".lanes", "hook.cjs"), FAKE_HOOK);
  const logFile = path.join(dir, "calls.jsonl");
  Object.assign(process.env, { LANES_FAKE_LOG: logFile, LANES_FAKE_MODE: mode });
  const mod = await import(pathToFileURL(file).href + `?${mode}`);
  return { mod, dir, log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

for (const agent of ["opencode", "kilo"]) {
  test(`${agent} plugin: edits go to the hook as Claude-format pre and post; notes land in the next edit's result; other tools are left alone`, async () => {
    const { mod, dir, log } = await load(agent);
    assert.deepEqual(Object.keys(mod), ["LanesPlugin"], "one plugin export: opencode runs every exported function");
    const hooks = await mod.LanesPlugin({ project: {}, client: {}, $: undefined, directory: dir, worktree: dir });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "o1" } } } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "o1", callID: "c0" }, { args: { command: "ls" } });
    const file = path.join(dir, "src", "a.ts");
    const args = { filePath: file, oldString: "1", newString: "2" };
    assert.equal(await hooks["tool.execute.before"]({ tool: "edit", sessionID: "o1", callID: "c1" }, { args }), undefined, "no decision, no throw");
    const result = { title: "edit", output: "Edit applied.", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: "o1", callID: "c1" }, result);
    assert.equal(result.output, "Edit applied.\n\nstart-note pre-note post-note");
    const patch = "*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch";
    await hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "o1", callID: "c2" }, { args: { patchText: patch } });
    await hooks["tool.execute.before"]({ tool: "write", sessionID: "o1", callID: "c3" }, { args: { filePath: file, content: "x" } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "o1" } } });
    await hooks.event({ event: { type: "message.updated", properties: {} } });

    const calls = log();
    assert.deepEqual(calls.map((c) => c.argv), [["start", "--lanes", agent], ["pre", "--lanes", agent], ["post", "--lanes", agent], ["pre", "--lanes", agent], ["pre", "--lanes", agent], ["stop", "--lanes", agent]]);
    assert.deepEqual(calls[1].input, { session_id: "o1", cwd: dir, tool_name: "Edit", tool_input: { file_path: file, old_string: "1" } });
    assert.deepEqual(calls[2].input, calls[1].input, "post gets what pre got");
    assert.deepEqual(calls[3].input.tool_input, { command: patch });
    assert.equal(calls[4].input.tool_name, "Write");
  });
}

test("opencode plugin fails open: a crashing or missing hook never throws and leaves the tool result as it was", async () => {
  const { mod, dir, log } = await load("opencode", "crash");
  const hooks = await mod.LanesPlugin({ directory: dir });
  const result = { title: "", output: "ok", metadata: {} };
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "o2", callID: "c1" }, { args: { filePath: "x" } });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "o2", callID: "c1" }, result);
  assert.equal(result.output, "ok");
  assert.equal(log().length, 2);
  fs.rmSync(path.join(dir, ".lanes"), { recursive: true });
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "o2", callID: "c2" }, { args: { filePath: "x" } });
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "o2", callID: "c3" }, undefined);
  await hooks.event({ event: undefined });
});

test("Amp plugin: tool.call always answers allow; the prompt's brief and waiting notes go back from agent.start, unshown", async () => {
  for (const mode of ["", "crash"]) {
    const { mod, dir, log } = await load("amp", mode);
    const on: Record<string, (event: any, ctx?: any) => any> = {};
    mod.default({ on: (name: string, fn: any) => (on[name] = fn), system: { workspaceRoot: pathToFileURL(dir).href }, helpers: { filePathFromURI: (u: string) => new URL(u).pathname.replace(/^\/(\w:)/, "$1") } });
    assert.deepEqual(Object.keys(on).sort(), ["agent.end", "agent.start", "session.start", "tool.call", "tool.result"]);
    await on["session.start"]({ thread: { id: "T-1" } });
    const file = path.join(dir, "src", "a.ts");
    assert.deepEqual(await on["tool.call"]({ tool: "Bash", input: { cmd: "ls" }, thread: { id: "T-1" } }), { action: "allow" });
    assert.deepEqual(await on["tool.call"]({ tool: "edit_file", toolUseID: "u1", input: { path: file, old_str: "1", new_str: "2" }, thread: { id: "T-1" } }), { action: "allow" });
    await on["tool.result"]({ tool: "edit_file", toolUseID: "u1", status: "done", thread: { id: "T-1" } });
    const started = await on["agent.start"]({ message: "rename getUser", thread: { id: "T-1" } });
    await on["agent.end"]({ message: "", messages: [], thread: { id: "T-1" } });
    const calls = log();
    assert.deepEqual(calls.map((c) => c.argv[0]), ["start", "pre", "post", "prompt", "stop"]);
    assert.ok(calls.every((c) => c.argv[1] === "--lanes" && c.argv[2] === "amp"));
    assert.deepEqual(calls[1].input.tool_input, { file_path: file, old_string: "1" });
    assert.equal(calls[3].input.prompt, "rename getUser");
    if (mode === "crash") assert.equal(started, undefined, "nothing to say when the hook fails");
    else assert.deepEqual(started, { message: { content: "start-note pre-note post-note prompt-note", display: false } });
  }
});
