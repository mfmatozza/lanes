// Gemini CLI and Cursor hook payloads and outputs (multiplayer S3.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextOutput, defaultOutput, editedFiles, fromAgent } from "../src/hook.ts";

test("Gemini payloads are Claude-shaped: write_file and replace give their file_path", () => {
  const raw = { session_id: "g1", cwd: "/r", hook_event_name: "BeforeTool", tool_name: "replace", tool_input: { file_path: "/r/src/a.ts", old_string: "a", new_string: "b" } };
  assert.deepEqual(fromAgent("gemini", raw), raw);
  assert.deepEqual(editedFiles(fromAgent("gemini", raw)), ["/r/src/a.ts"]);
  assert.deepEqual(editedFiles(fromAgent("gemini", { ...raw, tool_name: "run_shell_command", tool_input: { command: "rm x" } })), []);
});

test("Cursor: conversation_id is the session, afterFileEdit's file_path the edited file, the first workspace root the cwd", () => {
  const common = { conversation_id: "c1", generation_id: "g", hook_event_name: "afterFileEdit", workspace_roots: ["/r"] };
  const edit = fromAgent("cursor", { ...common, file_path: "/r/src/a.ts", edits: [{ old_string: "a", new_string: "b" }] });
  assert.deepEqual(edit, { session_id: "c1", cwd: "/r", prompt: undefined, tool_name: "afterFileEdit", tool_input: { file_path: "/r/src/a.ts" } });
  assert.deepEqual(editedFiles(edit), ["/r/src/a.ts"]);
  const prompt = fromAgent("cursor", { ...common, hook_event_name: "beforeSubmitPrompt", prompt: "fix a.ts", attachments: [{ type: "file", file_path: "/r/b.ts" }] });
  assert.deepEqual(prompt, { session_id: "c1", cwd: "/r", prompt: "fix a.ts" });
  assert.deepEqual(editedFiles(prompt), [], "attachments are not edits");
});

test("context goes in each agent's own field, or nowhere", () => {
  assert.deepEqual(contextOutput("claude", "PreToolUse", "x"), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "x" } });
  assert.deepEqual(contextOutput("gemini", "UserPromptSubmit", "x"), { hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "x" } });
  assert.deepEqual(contextOutput("gemini", "PostToolUse", "x"), { hookSpecificOutput: { hookEventName: "AfterTool", additionalContext: "x" } });
  assert.equal(contextOutput("gemini", "PreToolUse", "x"), undefined, "BeforeTool takes no additionalContext");
  assert.deepEqual(contextOutput("cursor", "SessionStart", "x"), { additional_context: "x" });
  assert.equal(contextOutput("cursor", "UserPromptSubmit", "x"), undefined, "beforeSubmitPrompt cannot inject");
  assert.equal(contextOutput("cursor", "PostToolUse", "x"), undefined, "afterFileEdit has no output");
});

test("with nothing to say: nothing for Claude, {} for Gemini and Cursor, continue on Cursor's prompt; never a decision", () => {
  assert.equal(defaultOutput("claude", "pre"), undefined);
  assert.deepEqual(defaultOutput("gemini", "pre"), {});
  assert.deepEqual(defaultOutput("cursor", "post"), {});
  assert.deepEqual(defaultOutput("cursor", "prompt"), { continue: true });
});
