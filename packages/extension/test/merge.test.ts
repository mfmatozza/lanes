// "Review and merge" reads git and changes nothing. Runs against a temporary repository only.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { git, makeRepo } from "../../core/test/helpers.ts";
import { sharedContent, sharedRef, unsharedFiles } from "../src/merge.ts";

test("finds the shared branch, the files not shared yet and the shared content, without touching the checkout", () => {
  const { main, cleanup } = makeRepo();
  try {
    assert.equal(sharedRef(main), null, "no shared branch yet");
    git(main, "branch", "lanes/main");
    assert.equal(sharedRef(main), "refs/heads/lanes/main");

    // The agent's branch: one file changed, one added; none shared.
    fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(main, "src", "new file.ts"), "x\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "agent edit");
    const before = git(main, "rev-parse", "HEAD");

    assert.deepEqual(unsharedFiles(main, "refs/heads/lanes/main").sort(), ["src/a.ts", "src/new file.ts"]);
    assert.equal(sharedContent(main, "refs/heads/lanes/main", "src/a.ts").toString(), "export const a = 1;\n");
    assert.equal(sharedContent(main, "refs/heads/lanes/main", "src/new file.ts").length, 0, "a file the shared branch lacks is empty, not an error");
    assert.equal(sharedContent(main, "refs/heads/lanes/main", "../../etc/passwd").length, 0);

    // Read-only: the working tree, the index and the branch are exactly as they were.
    assert.equal(git(main, "rev-parse", "HEAD"), before);
    assert.equal(git(main, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(main, "src", "a.ts"), "utf8"), "export const a = 2;\n");

    // Once the shared branch has everything there is nothing left to merge.
    git(main, "branch", "-f", "lanes/main", "HEAD");
    assert.deepEqual(unsharedFiles(main, "refs/heads/lanes/main"), []);
  } finally {
    cleanup();
  }
});
