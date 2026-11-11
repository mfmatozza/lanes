// #86 (LAN clients), #90 (partial release) and #89 (server epoch). Ported from lanes-bughunt/lan.ts and stress3.ts.
import assert from "node:assert/strict";
import * as http from "node:http";
import * as os from "node:os";
import { describe, test } from "node:test";
import { Coordinator } from "../src/coordinator.ts";
import { startServer } from "../src/server.ts";

const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

function get(host: string, port: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/v1/state", headers: { authorization: "Bearer t", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
  });
}

describe("LAN bind (#86)", () => {
  test("a teammate reaching a 0.0.0.0 server by its LAN address gets in; strangers' Host names do not", { skip: !lanIp }, async () => {
    const server = await startServer({ port: 0, host: "0.0.0.0", token: "t" });
    try {
      const port = new URL(server.url).port;
      assert.equal(await get("127.0.0.1", port), 200);
      assert.equal(await get(lanIp!, port), 200, "same token, via the LAN address");
      assert.equal(await get(lanIp!, port, { host: "evil.example" }), 403);
      assert.equal(await get(lanIp!, port, { authorization: "Bearer wrong" }), 401);
    } finally {
      await server.close();
    }
  });

  test("an explicit allow-list names extra hosts; loopback-only servers still refuse everything else", async () => {
    const lan = await startServer({ port: 0, host: "0.0.0.0", token: "t", allowedHosts: ["lanes.team.example"] });
    const local = await startServer({ port: 0, token: "t" });
    try {
      assert.equal(await get("127.0.0.1", new URL(lan.url).port, { host: "lanes.team.example:4317" }), 200);
      assert.equal(await get("127.0.0.1", new URL(local.url).port, { host: "lanes.team.example" }), 403, "DNS rebinding protection stays on");
      if (lanIp) assert.equal(await get("127.0.0.1", new URL(local.url).port, { host: lanIp }), 403);
    } finally {
      await lan.close();
      await local.close();
    }
  });

  test("a server open to the network must have a token", async () => {
    await assert.rejects(startServer({ port: 0, host: "0.0.0.0" }), /requires a token/);
  });
});

describe("partial release (#90)", () => {
  const who = { user: "ana", sessionId: "s1", repo: "r", label: "app" };
  const acquire = (c: Coordinator, sessionId: string, path: string) =>
    c.acquire({ ...who, sessionId, user: sessionId, tool: "Edit", paths: [path], waitMs: 0 });

  test("publishing one file keeps the session's lease on the other; the end of the turn frees all", async () => {
    const c = new Coordinator();
    await acquire(c, "s1", "A");
    await acquire(c, "s1", "B");
    c.publish({ ...who, commit: "a".repeat(40), paths: ["A"] });
    assert.deepEqual(c.snapshot().leases.map((l) => l.path), ["B"]);
    const s2 = await acquire(c, "s2", "B");
    assert.equal(s2.decision, "timeout", "B is still being edited: s2 must wait");
    c.publish({ ...who, paths: [], final: true });
    assert.equal(c.snapshot().leases.length, 0);
  });

  test("a failed publish still frees the edited file when the client names it; one naming nothing frees all (older clients)", async () => {
    const c = new Coordinator();
    await acquire(c, "s1", "A");
    await acquire(c, "s1", "B");
    c.publish({ ...who, paths: [], release: ["A"] });
    assert.deepEqual(c.snapshot().leases.map((l) => l.path), ["B"]);
    c.publish({ ...who, paths: [] });
    assert.equal(c.snapshot().leases.length, 0);
  });
});

describe("server epoch (#89)", () => {
  test("every acquire answer carries the server run's epoch, which differs after a restart", async () => {
    const ask = async (c: Coordinator) => {
      const res = await c.acquire({ user: "u", sessionId: "s", repo: "r", label: "l", tool: "Edit", paths: ["x"], waitMs: 0 });
      return res.decision === "allow" ? res.epoch : undefined;
    };
    const first = new Coordinator();
    const epoch = await ask(first);
    assert.ok(epoch);
    assert.equal(await ask(first), epoch);
    assert.notEqual(await ask(new Coordinator()), epoch);
  });
});
