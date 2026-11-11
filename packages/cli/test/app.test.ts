// `lanes app --print` (ADR-0029): the link carries the token, user and repository in the fragment, never in the path or query.
// Only run inside a temp repository: outside one, the lookup would walk up into the developer's home, which may be a git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRepo } from "../../core/test/helpers.ts";
import { browserCommand } from "../src/cli.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

test("server URL, /app, then token, user and repository in the fragment", () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-app-"));
  try {
    const env = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:4999/", LANES_USER: "Ana B", LANES_TOKEN: "tok&1" };
    const r = spawnSync(process.execPath, [cli, "app", "--print", "--dir", repo.main], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^http:\/\/127\.0\.0\.1:4999\/app#token=tok%261&user=Ana\+B&repo=[^&#\s]+$/);
    assert.ok(new URLSearchParams(new URL(r.stdout.trim()).hash.slice(1)).get("repo")!.endsWith("/app"), "the repository id");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("the browser opener never hands the URL to a shell: on Windows it travels in an environment variable", () => {
  const url = "http://127.0.0.1:4317/app#token=a%25PATH%25b&user=x";
  const win = browserCommand(url, "win32");
  assert.equal(win.cmd, "powershell.exe");
  assert.ok(!win.args.some((a) => a.includes(url)), "not on the command line, where it could be parsed");
  assert.equal(win.env?.LANES_OPEN_URL, url, "the whole URL, fragment included");
  assert.deepEqual(browserCommand(url, "darwin"), { cmd: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), { cmd: "xdg-open", args: [url] });
});
