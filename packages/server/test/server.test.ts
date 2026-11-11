import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServer, type RunningServer } from "../src/server.ts";

describe("HTTP server", () => {
  let server: RunningServer;
  let logFile: string;
  before(async () => {
    logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-log-")), "server.jsonl");
    server = await startServer({ port: 0, logFile });
  });
  after(() => server.close());

  const post = async (route: string, body: unknown) => {
    const res = await fetch(server.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const check = (user: string, sessionId: string) =>
    post("/v1/acquire", { user, sessionId, repo: "r", label: "app", tool: "Edit", paths: ["src/x.ts"], waitMs: 50 });

  test("acquire allows, then gives a second holder a timeout (never a refusal)", async () => {
    assert.equal((await check("Ana", "s1")).body.decision, "allow");
    const second = await check("Bea", "s2");
    assert.equal(second.body.decision, "timeout");
  });

  test("state reflects agents and leases", async () => {
    const res = await fetch(server.url + "/v1/state");
    const state = await res.json();
    assert.equal(state.leases.length, 1);
    assert.deepEqual(state.agents.map((a: { user: string }) => a.user).sort(), ["Ana", "Bea"]);
  });

  test("session end releases leases", async () => {
    await post("/v1/session", { user: "Ana", sessionId: "s1", repo: "r", label: "app", event: "end" });
    assert.equal((await check("Bea", "s2")).body.decision, "allow");
  });

  test("malformed requests get 400", async () => {
    assert.equal((await post("/v1/acquire", { user: "Ana" })).status, 400);
    const res = await fetch(server.url + "/v1/acquire", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    assert.equal(res.status, 400);
  });

  test("every request is logged with latency", () => {
    const entries = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const checks = entries.filter((e) => e.type === "acquire");
    assert.ok(checks.length >= 3);
    assert.ok(checks.every((e) => typeof e.ms === "number"));
  });
});

describe("long-poll acquire", () => {
  test("a waiter whose client disconnects leaves the queue (no lease handed to a dead hook)", async () => {
    const server = await startServer({ port: 0 });
    try {
      const body = (user: string) => JSON.stringify({ user, sessionId: user, repo: "r", label: "app", tool: "Edit", paths: ["src/x.ts"], waitMs: 60_000 });
      await fetch(server.url + "/v1/acquire", { method: "POST", body: body("ana") });
      await fetch(server.url + "/v1/acquire", { method: "POST", body: body("bea"), signal: AbortSignal.timeout(300) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      server.coordinator.publish({ user: "ana", sessionId: "ana", repo: "r", label: "app", paths: [] });
      assert.equal(server.coordinator.snapshot().leases.length, 0, "bea's abandoned wait must not receive the lease");
    } finally {
      await server.close();
    }
  });
});

describe("HTTP server security (spike v3c review)", () => {
  let server: RunningServer;
  const TOKEN = "t0k3n-for-tests";
  before(async () => (server = await startServer({ port: 0, token: TOKEN })));
  after(() => server.close());

  const call = (route: string, init: { body?: unknown; headers?: Record<string, string>; method?: string } = {}) =>
    fetch(server.url + route, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const ref = { user: "ana", sessionId: "s1", repo: "r", label: "app" };

  test("requests without the token are refused, including reading the state", async () => {
    assert.equal((await call("/v1/state", { method: "GET", headers: { authorization: "" } })).status, 401);
    assert.equal((await call("/v1/release", { body: { repo: "r", path: "x" }, headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await call("/v1/state", { method: "GET" })).status, 200);
  });

  test("web pages can't post simple requests (CSRF): JSON content type is required", async () => {
    assert.equal((await call("/v1/release", { body: { repo: "r", path: "x" }, headers: { "content-type": "text/plain" } })).status, 415);
  });

  test("an unexpected Host header is refused (DNS rebinding)", async () => {
    const res = await new Promise<number>((resolve) => {
      const req = http.request(server.url + "/v1/state", { headers: { host: "evil.example:80", authorization: `Bearer ${TOKEN}` } }, (r) => resolve(r.statusCode ?? 0));
      req.end();
    });
    assert.equal(res, 403);
  });

  test("a __proto__ repo can't pollute Object.prototype", async () => {
    await call("/v1/publish", { body: { ...ref, repo: "__proto__", paths: ["polluted"], final: false } });
    await call("/v1/state", { method: "GET" });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("oversized or malformed input is rejected", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
    assert.equal((await call("/v1/acquire", { body: { ...ref, tool: "Edit", paths: many, waitMs: 0 } })).status, 400);
    assert.equal((await call("/v1/publish", { body: { ...ref, commit: "--upload-pack=x", paths: [] } })).status, 400);
    assert.equal((await call("/v1/task", { body: { ...ref, title: "x".repeat(600) } })).status, 400);
  });
});
