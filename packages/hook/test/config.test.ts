import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/hook.ts";

test("the hook's config comes from LANES_HOME, not the real home folder (#93)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-cfg-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ serverUrl: "http://10.1.2.3:9999/", user: "zed" }));
  const saved = { ...process.env };
  process.env.LANES_HOME = home;
  for (const k of ["LANES_SERVER", "LANES_USER", "LANES_EMAIL", "LANES_TOKEN"]) delete process.env[k];
  try {
    const config = loadConfig();
    assert.equal(config.serverUrl, "http://10.1.2.3:9999");
    assert.equal(config.user, "zed");
  } finally {
    process.env = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
