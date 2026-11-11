// Copilot and Kiro hook payloads and outputs (multiplayer S3.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsPath, copilotContext, fromCopilot, isCopilotClaudeFormat, isCopilotCloud } from "../src/agents/copilot.ts";
import { fromKiro, kiroContext } from "../src/agents/kiro.ts";
import { contextOutput, defaultOutput, editedFiles, fromAgent } from "../src/hook.ts";

test("Copilot: sessionId is the session; edit and create give their path, as an object or a JSON string", () => {
  const common = { sessionId: "p1", timestamp: 1730000000000, cwd: "/r" };
  assert.deepEqual(fromCopilot({ ...common, toolName: "edit", toolArgs: { path: "/r/a.ts", old_str: "a", new_str: "b" } }), { session_id: "p1", cwd: "/r", prompt: undefined, tool_name: "edit", tool_input: { file_path: "/r/a.ts" } });
  assert.deepEqual(editedFiles(fromAgent("copilot", { ...common, toolName: "create", toolArgs: JSON.stringify({ file_path: "src/b.ts", file_text: "x" }) })), ["src/b.ts"]);
  assert.deepEqual(editedFiles(fromCopilot({ ...common, toolName: "view", toolArgs: { path: "/r/a.ts" } })), [], "a read is not an edit");
  assert.deepEqual(editedFiles(fromCopilot({ ...common, toolName: "edit", toolArgs: "not json" })), []);
  assert.deepEqual(fromCopilot({ ...common, prompt: "fix a.ts" }), { session_id: "p1", cwd: "/r", prompt: "fix a.ts" });
  assert.equal(argsPath({ filePath: "x.ts" }), "x.ts");
  assert.equal(argsPath(null), undefined);
});

test("Copilot: context only as top-level additionalContext on sessionStart and postToolUse; nothing otherwise", () => {
  assert.deepEqual(copilotContext("SessionStart", "x"), { additionalContext: "x" });
  assert.deepEqual(contextOutput("copilot", "PostToolUse", "x"), { additionalContext: "x" });
  assert.equal(contextOutput("copilot", "UserPromptSubmit", "x"), undefined, "userPromptSubmitted output is ignored");
  assert.equal(contextOutput("copilot", "PreToolUse", "x"), undefined);
  assert.equal(defaultOutput("copilot", "post"), undefined);
});

test("Copilot running .claude hooks is told apart from Claude Code; the cloud agent is detected", () => {
  assert.ok(isCopilotClaudeFormat({ session_id: "s", timestamp: "2026-11-02T10:00:00Z", cwd: "/r", hook_event_name: "PreToolUse", tool_name: "Edit" }));
  assert.ok(!isCopilotClaudeFormat({ session_id: "s", transcript_path: "/t.jsonl", cwd: "/r", hook_event_name: "PreToolUse" }), "Claude Code");
  assert.ok(!isCopilotClaudeFormat({ session_id: "s", transcript_path: "/t", timestamp: "x", hook_event_name: "Stop" }), "Copilot's Stop slips through (harmless)");
  assert.ok(isCopilotCloud({ GITHUB_COPILOT_API_TOKEN: "t" }));
  assert.ok(!isCopilotCloud({}));
});

test("Kiro: Claude-shaped payload, prompt from USER_PROMPT, write path from path, file_path or operations", () => {
  const common = { hook_event_name: "PostToolUse", session_id: "k1", cwd: "/r" };
  assert.deepEqual(fromKiro({ ...common, tool_name: "fs_write", tool_input: { command: "create", path: "/r/a.ts" } }, {}), { session_id: "k1", cwd: "/r", prompt: undefined, tool_name: "fs_write", tool_input: { file_path: "/r/a.ts" } });
  assert.deepEqual(editedFiles(fromKiro({ ...common, tool_name: "write", tool_input: { operations: [{ path: "src/b.ts" }] } }, {})), ["src/b.ts"]);
  assert.deepEqual(editedFiles(fromKiro({ ...common, tool_name: "write", tool_input: {} }, {})), []);
  assert.equal(fromKiro({ hook_event_name: "UserPromptSubmit", session_id: "k1" }, { USER_PROMPT: "fix a.ts" }).prompt, "fix a.ts");
});

test("Kiro: context is plain text on the registered events, nothing otherwise", () => {
  assert.equal(kiroContext("SessionStart", "x"), "x");
  assert.equal(contextOutput("kiro", "UserPromptSubmit", "x"), "x");
  assert.equal(contextOutput("kiro", "PreToolUse", "x"), undefined);
  assert.equal(defaultOutput("kiro", "stop"), undefined, "any stdout would reach the agent");
});
