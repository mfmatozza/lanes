// S6.1: line-range overlap. The -U0 hunk parser, the old_string → line span helper, and the hook end to end: a teammate's
// published lines narrow the heads-up before an edit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { mergeRanges } from "@lanes/core/ranges.ts";
import { parseHunks } from "../src/gitops.ts";
import { editSpan } from "../src/hook.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

test("parseHunks: additions, a deletion marks where it was, several files and hunks, quoted and deleted files skipped", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@ x",
    "-old",
    "+new",
    "@@ -10,0 +11,4 @@",
    "+1",
    "@@ -20,3 +23,0 @@",
    "@@ -40,2 +40,2 @@",
    "diff --git a/my file.ts b/my file.ts",
    "--- a/my file.ts",
    "+++ b/my file.ts\t",
    "@@ -0,0 +1,2 @@",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    'diff --git "a/q\\"t.ts" "b/q\\"t.ts"',
    '+++ "b/q\\"t.ts"',
    "@@ -1 +1 @@",
  ].join("\n");
  const ranges = parseHunks(diff);
  assert.deepEqual({ ...ranges }, { "src/a.ts": [[3, 3], [11, 14], [23, 23], [40, 41]], "my file.ts": [[1, 2]] });
  assert.deepEqual(parseHunks("+++ b/x\n@@ -0,0 +0,0 @@\n")["x"], [[1, 1]], "a deletion at the top marks line 1");
  assert.deepEqual(parseHunks("+++ b/__proto__\n@@ -1 +1 @@\n")["__proto__"], [[1, 1]], "a path is just a key");
});

test("parseHunks caps the ranges per file without dropping any line", () => {
  const diff = ["+++ b/f", ...Array.from({ length: 60 }, (_, i) => `@@ -${i * 10 + 1} +${i * 10 + 1} @@`)].join("\n");
  const ranges = parseHunks(diff, 50).f;
  assert.equal(ranges.length, 50);
  assert.deepEqual(ranges[49], [491, 591]);
  assert.deepEqual(mergeRanges([[5, 6], [1, 2], [3, 4], [10, 12], [11, 20], [22, 22]]), [[1, 6], [10, 20], [22, 22]], "touching and overlapping ranges merge");
});

test("editSpan: an old_string's lines, a MultiEdit's union, unknown when missing, repeated, empty or a whole-file write", () => {
  const text = "a\r\nb\r\nc\r\nd\r\ne\r\nb2\r\n";
  assert.deepEqual(editSpan(text, { old_string: "c\nd\n" }), [3, 4], "CRLF file, LF old_string, trailing newline");
  assert.deepEqual(editSpan(text, { old_string: "e" }), [5, 5]);
  assert.deepEqual(editSpan(text, { edits: [{ old_string: "a" }, { old_string: "e\nb2" }] }), [1, 6]);
  assert.equal(editSpan(text, { old_string: "b" }), undefined, "ambiguous");
  assert.equal(editSpan(text, { old_string: "zzz" }), undefined, "not found");
  assert.equal(editSpan(text, { old_string: "" }), undefined, "creates a file");
  assert.equal(editSpan(text, { edits: [{ old_string: "a" }, { old_string: "zzz" }] }), undefined);
  assert.equal(editSpan(text, { file_path: "x" }), undefined, "Write: whole file");
});

function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

let server: RunningServer;
let repo: ReturnType<typeof makeTeamRepo>;
const env = (user: string) => ({ LANES_SERVER: server.url, LANES_USER: user, LANES_EMAIL: `${user}@example.com` });
const lines = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
before(async () => {
  server = await startServer({ port: 0 });
  repo = makeTeamRepo("ana", "bea");
  fs.writeFileSync(path.join(repo.main, "src", "big.ts"), lines.join("\n") + "\n");
  git(repo.main, "add", "src/big.ts");
  git(repo.main, "commit", "-q", "-m", "big");
  git(repo.main, "branch", "-f", "lanes/main");
  for (const wt of Object.values(repo.wt)) {
    git(wt, "merge", "-q", "--ff-only", "lanes/main");
    fs.mkdirSync(path.join(wt, ".lanes"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".lanes", "team.json"), JSON.stringify({ context: true }));
  }
});
after(async () => {
  await server.close();
  repo.cleanup();
});

test("hook: a published edit sends its lines; a teammate's edit far from them gets no heads-up, a near one names them", async () => {
  const beaFile = path.join(repo.wt.bea, "src", "big.ts");
  await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "Bump v30" }, env("bea"));
  const edit = (sessionId: string, file: string, old: string) => ({ session_id: sessionId, cwd: path.dirname(path.dirname(file)), tool_name: "Edit", tool_input: { file_path: file, old_string: old, new_string: "x" } });
  assert.equal((await runHook("pre", edit("s-bea", beaFile, lines[29]), env("bea"))).code, 0);
  fs.writeFileSync(beaFile, lines.map((l, i) => (i === 29 ? "export const v30 = 300;" : l)).join("\n") + "\n");
  const post = await runHook("post", edit("s-bea", beaFile, lines[29]), env("bea"));
  assert.equal(post.code, 0, post.stderr);
  const task = server.coordinator.snapshot().tasks.find((t) => t.user === "bea")!;
  assert.deepEqual(task.ranges?.["src/big.ts"], [[30, 30]]);

  const anaFile = path.join(repo.wt.ana, "src", "big.ts");
  const far = await runHook("pre", edit("s-ana", anaFile, lines[4]), env("ana"));
  assert.equal(far.code, 0, far.stderr);
  assert.doesNotMatch(far.stdout, /bea's agent/);
  const near = await runHook("pre", edit("s-ana", anaFile, lines[27]), env("ana"));
  assert.match(JSON.parse(near.stdout).hookSpecificOutput.additionalContext, /bea's agent, working on "Bump v30", changed line 30 of it/);
});
