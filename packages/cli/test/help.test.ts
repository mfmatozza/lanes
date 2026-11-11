// #182: help exits 0 on stdout, a wrong command line exits 2 with a pointer to --help. Spawns the CLI with a temp home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
function lanes(...args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-help-"));
  try {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("--help, -h, help and no arguments print the usage and exit 0", () => {
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const r = lanes(...args);
    assert.equal(r.code, 0, args.join(" "));
    assert.match(r.out, /lanes init[^]*lanes connect[^]*lanes server[^]*lanes status[^]*lanes report[^]*lanes hosted[^]*lanes pr/);
  }
});

test("every command has its own --help, and `help <command>` shows the same", () => {
  for (const cmd of ["init", "connect", "server", "status", "pr", "report", "hosted", "off"]) {
    const r = lanes(cmd, "--help");
    assert.equal(r.code, 0, cmd);
    assert.match(r.out, new RegExp(`^lanes ${cmd}( |\\n)`));
    assert.doesNotMatch(r.out, /lanes connect[^]*lanes server/, "only that command");
    assert.equal(lanes("help", cmd).out, r.out);
  }
});

test("an unknown command, option or argument exits 2 with a pointer, no stack trace", () => {
  for (const [args, msg] of [
    [["bogus"], /Unknown command 'bogus'.*lanes --help/],
    [["init", "--bogus"], /Unknown option '--bogus'\. Run `lanes init --help`/],
    [["status", "extra"], /Unexpected argument 'extra'\. Run `lanes status --help`/],
    [["init", "--dir"], /--dir.*Run `lanes init --help`/],
  ] as const) {
    const r = lanes(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, msg);
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
});
