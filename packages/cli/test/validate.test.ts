// #183: a server URL or port that cannot work is refused before anything is written or started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRepo } from "../../core/test/helpers.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

test("bad --server and --port values exit 2 with the expected form and write nothing", () => {
  const { main, cleanup } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-validate-"));
  const lanes = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: main, env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" } });
  try {
    for (const [args, msg] of [
      [["connect", "--server", "notaurl", "--token", "t"], /'notaurl' is not a server URL\. Use the form http:\/\/host:4317/],
      [["connect", "--server", "ftp://h", "--token", "t"], /not a server URL/],
      [["status", "--server", "notaurl"], /not a server URL/],
      [["init", "--server", "garbage", "--no-commit"], /not a server URL/],
      [["server", "--port", "abc"], /'abc' is not a port number\. Use a number from 1 to 65535/],
      [["server", "--port", "70000"], /not a port number/],
      [["connect", "--server", "http://h:1"], /needs --token <token>\. Run `lanes connect --help`/],
      [["connect"], /needs --server <url> and --token <token>/],
    ] as const) {
      const r = lanes(...args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, msg);
      assert.doesNotMatch(r.stdout, /Token|Set up|now use/, "nothing started or announced");
    }
    assert.deepEqual(fs.readdirSync(home), [], "no config or token written");
    assert.equal(fs.existsSync(path.join(main, ".lanes")), false, "init wrote nothing");
    const good = lanes("connect", "--server", "http://localhost:4317/", "--token", "t");
    assert.equal(good.status, 0);
  } finally {
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
