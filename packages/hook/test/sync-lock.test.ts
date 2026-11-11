// #143: a hook's sync shares the per-checkout lock with publishing, so the two never fight over index.lock or ref locks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withLock } from "@lanes/core/local.ts";
import { checkoutLock } from "../src/hook.ts";
import { checkpointAndPublish } from "../src/gitops.ts";
import { git, makeRemoteTeam } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

test("SessionStart's sync waits for a publish in progress in the same checkout", async () => {
  const team = makeRemoteTeam("ana", "bea");
  try {
    const { ana, bea } = team.clone;
    fs.writeFileSync(path.join(bea, "src", "b.ts"), "export const b = 1;\n");
    const who = { name: "bea", email: "bea@example.com" };
    assert.equal((await checkpointAndPublish(bea, who, { session: "s", task: "t" }, ["src/b.ts"])).status, "published");
    const arrived = () => fs.existsSync(path.join(ana, "src", "b.ts"));

    let startedAt = 0;
    let doneAt = 0;
    await withLock(checkoutLock(ana), async () => {
      const child = spawn(process.execPath, ["--no-warnings", HOOK, "start"], {
        env: { ...process.env, LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana", LANES_EMAIL: "ana@example.com" },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ session_id: "s-lock", cwd: ana }));
      startedAt = Date.now();
      child.on("close", () => (doneAt = Date.now()));
      await new Promise((r) => setTimeout(r, 1_000));
      assert.equal(arrived(), false, "the sync must wait while another git writer holds the checkout");
    });
    for (let i = 0; i < 100 && !doneAt; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(doneAt > startedAt);
    assert.equal(arrived(), true, "and run as soon as the lock is free");
    assert.equal(git(ana, "status", "--porcelain"), "");
  } finally {
    team.cleanup();
  }
});
