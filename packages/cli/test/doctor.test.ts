// `lanes doctor`: one line per check, exit 1 when something fails, exit 0 and "All good" once set up with a server.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-doctor-"));
const repo = path.join(home, "repo");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
const lanes = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, LANES_HOME: path.join(home, "h"), LANES_AUTOSTART: "0", NO_COLOR: "1" } });

test("doctor in a repository without Lanes and without a server fails on those two checks and says what to do", () => {
  const r = lanes("doctor", "--server", "http://127.0.0.1:1");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ Node \d+/);
  assert.match(r.stdout, /✓ git version/);
  assert.match(r.stdout, /✗ Lanes is not set up in this repository\n {2}Run `lanes init`/);
  assert.match(r.stdout, /– Team context is off/);
  assert.match(r.stdout, /✗ No Lanes server answers at http:\/\/127\.0\.0\.1:1\n {2}Normal before the first Claude Code session/);
  assert.match(r.stdout, /Something to fix above/);
  assert.doesNotMatch(r.stderr, /DEP0190|DeprecationWarning/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("doctor outside a repository names that, and --help exits 0", () => {
  const r = spawnSync(process.execPath, [cli, "doctor", "--dir", os.tmpdir()], { encoding: "utf8", env: { ...process.env, LANES_HOME: path.join(home, "h"), LANES_AUTOSTART: "0", NO_COLOR: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ .* is not inside a git repository/);
  assert.equal(lanes("doctor", "--help").status, 0);
});
