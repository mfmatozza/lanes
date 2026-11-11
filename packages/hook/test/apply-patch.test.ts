// Codex apply_patch (multiplayer slice 3): which files one tool call touches. Review #6.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editedFiles } from "../src/hook.ts";

test("Claude's file_path and notebook_path are one file each", () => {
  assert.deepEqual(editedFiles({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }), ["src/a.ts"]);
  assert.deepEqual(editedFiles({ tool_name: "NotebookEdit", tool_input: { notebook_path: "n.ipynb" } }), ["n.ipynb"]);
});

test("apply_patch: add, update, delete and move targets, sorted and unique, CRLF too", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/z.ts", "@@", "-a", "+b", "*** Add File: src/a.ts", "+x", "*** Delete File: old.ts", "*** Update File: src/m.ts", "*** Move to: src/n.ts", "*** Update File: src/z.ts", "*** End Patch"].join("\r\n");
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", tool_input: { command: patch } }), ["old.ts", "src/a.ts", "src/m.ts", "src/n.ts", "src/z.ts"]);
});

test("anything else touches no file: other tools, no patch text, a header inside a line", () => {
  assert.deepEqual(editedFiles({ tool_name: "Bash", tool_input: { command: "*** Add File: x" } }), []);
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", tool_input: {} }), []);
  assert.deepEqual(editedFiles({ tool_name: "apply_patch", tool_input: { command: "+ *** Add File: not-a-header.ts" } }), []);
});
