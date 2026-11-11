// #123 (token for a non-loopback server), #129 (status uses the hook's config resolution).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isLocalServer, tokenFor, writeUserConfig } from "@lanes/core/local.ts";
import { startServer } from "@lanes/server/server.ts";
import { makeRepo } from "./helpers.ts";

const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/src/cli.ts", import.meta.url));
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lanes-cfg-"));
const cleanEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" };
  for (const k of ["LANES_SERVER", "LANES_TOKEN", "LANES_USER", "LANES_EMAIL", "LANES_REMOTE"]) delete env[k];
  return env;
};
// The server of these tests lives in this process: a synchronous spawn would starve it.
const runAsync = (script: string, args: string[], env: NodeJS.ProcessEnv, input?: object) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
const run = (script: string, args: string[], env: NodeJS.ProcessEnv, input?: object) =>
  spawnSync(process.execPath, ["--no-warnings", script, ...args], { env, encoding: "utf8", input: input ? JSON.stringify(input) : undefined });

describe("a non-loopback server (#123)", () => {
  test("`lanes connect` stores server and token privately and requires both", () => {
    const home = tmp();
    try {
      const out = run(CLI, ["connect", "--server", "http://192.168.1.119:4400/", "--token", "tok-1", "--user", "Bea"], cleanEnv(home));
      assert.equal(out.status, 0, out.stderr);
      const file = path.join(home, "config.json");
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { serverUrl: "http://192.168.1.119:4400", token: "tok-1", user: "Bea" });
      if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0, "config.json is private");
      assert.notEqual(run(CLI, ["connect", "--server", "http://x:1"], cleanEnv(home)).status, 0, "token required");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a server on this machine reached by its LAN address uses ~/.lanes/token", { skip: !lanIp }, () => {
    const home = tmp();
    const saved = process.env.LANES_HOME;
    process.env.LANES_HOME = home;
    try {
      assert.ok(isLocalServer(`http://${lanIp}:4400`));
      assert.ok(!isLocalServer("http://203.0.113.9:4400"));
      const t = tokenFor({ serverUrl: `http://${lanIp}:4400` });
      assert.equal(t, fs.readFileSync(path.join(home, "token"), "utf8").trim());
      assert.equal(tokenFor({ serverUrl: "http://203.0.113.9:4400" }), undefined, "no token invented for someone else's server");
      writeUserConfig({ token: "x" });
      assert.equal(tokenFor({ serverUrl: "http://203.0.113.9:4400", token: "x" }), "x");
    } finally {
      process.env.LANES_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("hook to a LAN server end to end, and `lanes status` agrees with the hook", { skip: !lanIp }, async () => {
    const home = tmp();
    const { main, cleanup } = makeRepo();
    const server = await startServer({ port: 0, host: "0.0.0.0", token: "lan-token" });
    try {
      const url = `http://${lanIp}:${new URL(server.url).port}`;
      writeUserConfigIn(home, { serverUrl: url, token: "lan-token", user: "Bea" });
      const env = cleanEnv(home);
      const input = { session_id: "s-lan", cwd: main, tool_name: "Edit", tool_input: { file_path: path.join(main, "src", "a.ts") } };
      assert.equal((await runAsync(HOOK, ["pre"], env, input)).status, 0);
      const state = (await (await fetch(server.url + "/v1/state", { headers: { authorization: "Bearer lan-token" } })).json()) as { leases: { user: string }[] };
      assert.equal(state.leases.length, 1, "the lease was taken: the hook authenticated");
      const status = await runAsync(CLI, ["status"], env);
      assert.match(status.stdout, /1 agents/, status.stderr);
    } finally {
      await server.close();
      cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("status with a refused token for a remote server says how to connect", async () => {
    const home = tmp();
    const server = await startServer({ port: 0, host: "0.0.0.0", token: "lan-token" });
    try {
      const url = `http://127.0.0.1:${new URL(server.url).port}`;
      writeUserConfigIn(home, { serverUrl: url, token: "wrong" });
      const res = await runAsync(CLI, ["status"], cleanEnv(home));
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /refused the token/);
    } finally {
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function writeUserConfigIn(home: string, fields: Record<string, string>): void {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(fields));
}
