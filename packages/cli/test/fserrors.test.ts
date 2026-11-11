// #187: file-system failures a user can fix read as sentences, and a missing --dir says so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRepo } from "../../core/test/helpers.ts";
import { describeFsError } from "../src/cli.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

test("describeFsError turns errno into advice, and leaves unknown errors alone", () => {
  const e = (code: string, extra: object) => Object.assign(new Error(code), { code }, extra);
  assert.match(describeFsError(e("EPERM", { path: "C:\\p\\hook.cjs", dest: "C:\\p\\.lanes\\hook.cjs" }))!, /^Cannot write C:\\p\\\.lanes\\hook\.cjs: permission denied\. Make it writable/);
  assert.match(describeFsError(e("EROFS", { path: "/x" }))!, /read-only/);
  assert.match(describeFsError(e("ENOSPC", { path: "/x" }))!, /disk is full/);
  assert.match(describeFsError(e("EEXIST", { path: "/x/.lanes" }))!, /a file is in the way/);
  assert.equal(describeFsError(e("ENOENT", { path: "/x" })), undefined);
  assert.equal(describeFsError(new Error("plain")), undefined);
});

test("end to end: a file where .lanes must be, an unusable LANES_HOME, and a missing --dir", () => {
  const { main, cleanup } = makeRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-fs-"));
  const assets = path.join(tmp, "dist");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "hook.cjs"), "// hook");
  fs.writeFileSync(path.join(assets, "server.cjs"), "// server");
  const homeFile = path.join(tmp, "home-is-a-file");
  fs.writeFileSync(homeFile, "");
  const lanes = (home: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_DIST: assets } });
  try {
    fs.writeFileSync(path.join(main, ".lanes"), "not a folder");
    let r = lanes(path.join(tmp, "home"), "init", "--dir", main, "--no-commit");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^lanes: Cannot use .*\.lanes: a file is in the way/);
    assert.doesNotMatch(r.stderr, /EEXIST|\n\s+at /);

    r = lanes(homeFile, "connect", "--server", "http://h:1", "--token", "t");
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /E[A-Z]{3,6}:|\n\s+at /);

    r = lanes(path.join(tmp, "home"), "init", "--dir", path.join(tmp, "nope"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nope does not exist\. Check --dir\./);
  } finally {
    cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
