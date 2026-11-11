// #185: without git on PATH, init and pr say so instead of "not inside a git repository".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRepo } from "../../core/test/helpers.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

test("init and pr name the missing git, exit 1, and print no stack trace", () => {
  const { main, cleanup } = makeRepo();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-nopath-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-nogit-"));
  try {
    for (const cmd of ["init", "pr"]) {
      const r = spawnSync(process.execPath, [cli, cmd, "--dir", main], { encoding: "utf8", env: { ...process.env, PATH: empty, Path: empty, LANES_HOME: home, LANES_AUTOSTART: "0" } });
      assert.equal(r.status, 1, cmd);
      assert.match(r.stderr, /git was not found on your PATH/);
      assert.doesNotMatch(r.stderr, /not inside|\n\s+at /);
    }
    assert.equal(fs.existsSync(path.join(main, ".lanes")), false, "nothing written");
  } finally {
    cleanup();
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
