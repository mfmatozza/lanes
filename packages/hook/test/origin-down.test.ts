// #131: an unreachable origin must not eat the hook's timeout, on every edit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { syncFromIntegration } from "../src/gitops.ts";
import { git, makeRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; ms: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    child.on("close", (code) => resolve({ code, ms: performance.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

// Accepts connections and never answers: what a firewall that drops packets looks like to git.
let tarpit: net.Server;
let origin: string;
const sockets = new Set<net.Socket>();
before(async () => {
  tarpit = net.createServer((s) => void sockets.add(s));
  await new Promise<void>((resolve) => tarpit.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(tarpit.address() as net.AddressInfo).port}/x.git`;
});
after(() => {
  for (const s of sockets) s.destroy();
  tarpit.close();
});

describe("unreachable origin (#131)", () => {
  test("the first sync gives up quickly, later ones do not even try", () => {
    const repo = makeRepo();
    process.env.LANES_NET_TIMEOUT_MS = "600";
    try {
      git(repo.main, "remote", "add", "origin", origin);
      const who = { name: "Ana", email: "ana@example.com" };
      let t = performance.now();
      assert.equal(syncFromIntegration(repo.main, who).ok, false);
      const first = performance.now() - t;
      assert.ok(first < 2_500, `first sync took ${first} ms`);
      t = performance.now();
      assert.equal(syncFromIntegration(repo.main, who).ok, false);
      const second = performance.now() - t;
      assert.ok(second < 150, `second sync took ${second} ms: the fetch was not skipped`);
    } finally {
      delete process.env.LANES_NET_TIMEOUT_MS;
      for (const s of sockets) s.destroy();
      try {
        repo.cleanup();
      } catch {
        // a killed git may still hold the folder for a moment on Windows
      }
    }
  });

  test("SessionStart registers the session and ends well inside its 5 s timeout", async () => {
    const repo = makeRepo();
    const server: RunningServer = await startServer({ port: 0 });
    try {
      git(repo.main, "remote", "add", "origin", origin);
      const env = { LANES_SERVER: server.url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com", LANES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home2-")) };
      const res = await runHook("start", { session_id: "s-down", cwd: repo.main }, env);
      assert.equal(res.code, 0);
      assert.ok(res.ms <= 4_000, `start took ${res.ms} ms`);
      const state = (await (await fetch(server.url + "/v1/state", { headers: { authorization: `Bearer ${fs.readFileSync(path.join(env.LANES_HOME, "token"), "utf8")}` } })).json()) as { agents: unknown[] };
      assert.equal(state.agents.length, 1, "the session is known to the server");
      const again = await runHook("start", { session_id: "s-down2", cwd: repo.main }, env);
      assert.ok(again.ms < res.ms, "a second start skips the known-down origin");
    } finally {
      await server.close();
      for (const s of sockets) s.destroy();
      try {
        repo.cleanup();
      } catch {
        // a killed git may still hold the folder for a moment on Windows
      }
    }
  });
});

describe("hook observations reach the server (#130)", () => {
  test("a sync that fails shows up in the snapshot's events, without contents", async () => {
    const repo = makeRepo();
    const server: RunningServer = await startServer({ port: 0 });
    try {
      git(repo.main, "remote", "add", "origin", path.join(repo.main, "..", "missing.git"));
      const env = { LANES_SERVER: server.url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com", LANES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home3-")) };
      assert.equal((await runHook("start", { session_id: "s-obs", cwd: repo.main }, env)).code, 0);
      const events = server.coordinator.snapshot().events;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.kind, "sync-failed");
      assert.equal(events[0]!.user, "ana");
    } finally {
      await server.close();
      repo.cleanup();
    }
  });
});
