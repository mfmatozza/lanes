// Regression tests for #87 (token race) and #91 (loose ~/.lanes mode), ported from lanes-bughunt/tok.ts and stress5.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadOrCreateToken, privateDir } from "../src/local.ts";

const LOCAL = fileURLToPath(new URL("../src/local.ts", import.meta.url));
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-local-")));
const posix = process.platform !== "win32";

function withHome<T>(home: string, fn: () => T): T {
  const saved = { home: process.env.LANES_HOME, token: process.env.LANES_TOKEN };
  process.env.LANES_HOME = home;
  delete process.env.LANES_TOKEN;
  try {
    return fn();
  } finally {
    if (saved.home === undefined) delete process.env.LANES_HOME;
    else process.env.LANES_HOME = saved.home;
    if (saved.token !== undefined) process.env.LANES_TOKEN = saved.token;
  }
}

test("an empty token file left behind is replaced, never returned as an empty token (#87)", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "token"), "");
  const token = withHome(home, loadOrCreateToken);
  assert.ok(token.length >= 32);
  assert.equal(fs.readFileSync(path.join(home, "token"), "utf8"), token);
});

test("many processes starting at once on a fresh machine all get the same non-empty token (#87)", async () => {
  for (let round = 0; round < 4; round++) {
    const home = tmp();
    const out = await Promise.all(
      Array.from({ length: 12 }, () =>
        new Promise<string>((resolve) => {
          const code = `import(${JSON.stringify("file:///" + LOCAL.replace(/\\/g, "/"))}).then(m => process.stdout.write(JSON.stringify(m.loadOrCreateToken())))`;
          const child = spawn(process.execPath, ["--no-warnings", "-e", code], { env: { ...process.env, LANES_HOME: home, LANES_TOKEN: "" } });
          let text = "";
          child.stdout.on("data", (d) => (text += d));
          child.on("close", () => resolve(text));
        }),
      ),
    );
    assert.ok(!out.includes('""'), `an empty token was returned: ${out}`);
    assert.equal(new Set(out).size, 1, `different tokens: ${out}`);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a pre-existing group/world-writable home, subfolder and token file are tightened (#91)", { skip: !posix }, () => {
  const home = tmp();
  fs.chmodSync(home, 0o777);
  fs.mkdirSync(path.join(home, "cache"), { mode: 0o775 });
  fs.chmodSync(path.join(home, "cache"), 0o775);
  fs.writeFileSync(path.join(home, "token"), "abc", { mode: 0o666 });
  fs.chmodSync(path.join(home, "token"), 0o666);
  withHome(home, () => {
    privateDir();
    privateDir("cache");
    assert.equal(loadOrCreateToken(), "abc");
  });
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, "cache")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, "token")).mode & 0o777, 0o600);
});
