// #110: a lock left by a killed publisher is taken over at once, not after its 90 s age.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withLock } from "../src/local.ts";

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-lock-")));
  const saved = process.env.LANES_HOME;
  process.env.LANES_HOME = home;
  return fn(home).finally(() => {
    if (saved === undefined) delete process.env.LANES_HOME;
    else process.env.LANES_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test("a lock whose owner process is dead is taken over immediately", () =>
  withHome(async (home) => {
    const dead = { stdout: "2147483000" }; // a pid no process has: a real dead one can be reused by another test process, which keeps the lock "alive"
    const lock = path.join(home, "locks", "publish-x");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), dead.stdout);
    const started = Date.now();
    const ran = await withLock("publish-x", () => "ran", 10_000);
    assert.equal(ran, "ran");
    assert.ok(Date.now() - started < 2_000, `waited ${Date.now() - started} ms`);
    assert.ok(!fs.existsSync(lock), "released afterwards");
  }));

test("a lock held by a live process is still respected until the wait runs out", () =>
  withHome(async () => {
    let inner = false;
    await withLock("busy", async () => {
      const started = Date.now();
      await withLock("busy", () => void (inner = true), 300);
      assert.ok(Date.now() - started >= 250, "waited for the live owner");
    });
    assert.ok(inner, "then ran anyway (fail open)");
  }));

test("processes taking over a dead owner's lock never overlap in the critical section (#141)", () =>
  withHome(async (home) => {
    const dead = { stdout: "2147483000" }; // a pid no process has: a real dead one can be reused by another test process, which keeps the lock "alive"
    const lock = path.join(home, "locks", "churn");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), dead.stdout);
    const inside = path.join(home, "inside");
    const local = new URL("../src/local.ts", import.meta.url).href;
    const script = `
      import * as fs from "node:fs";
      import { withLock } from ${JSON.stringify(local)};
      for (let i = 0; i < 15; i++) {
        await withLock("churn", async () => {
          fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid), { flag: "wx" }); // throws when another process is inside
          await new Promise((r) => setTimeout(r, 15));
          fs.rmSync(${JSON.stringify(inside)});
        }, 60_000);
      }`;
    const run = () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { ...process.env, LANES_HOME: home } });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stderr }));
      });
    const results = await Promise.all(Array.from({ length: 6 }, run));
    for (const r of results) assert.equal(r.code, 0, r.stderr.slice(0, 400));
  }));
