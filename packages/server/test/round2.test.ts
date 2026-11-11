// Round-2 bug hunt regressions for the server: #101 (large publishes) and #112 (LAN host names).
import assert from "node:assert/strict";
import * as http from "node:http";
import * as os from "node:os";
import { describe, test } from "node:test";
import { startServer } from "../src/server.ts";

function request(port: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method: data ? "POST" : "GET", headers: { authorization: "Bearer t", ...(data ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("publish of many files (#101)", () => {
  test("a publish naming 300 files is recorded and releases the session's lease", async () => {
    const server = await startServer({ port: 0, token: "t" });
    try {
      const port = new URL(server.url).port;
      const who = { user: "ana", sessionId: "s1", repo: "r", label: "app" };
      const acquired = await request(port, "/v1/acquire", { ...who, tool: "Edit", paths: ["src/a.ts"], waitMs: 0 });
      assert.equal(JSON.parse(acquired.body).decision, "allow");
      const paths = ["src/a.ts", ...Array.from({ length: 300 }, (_, i) => `gen/generated-file-${i}.ts`)];
      const res = await request(port, "/v1/publish", { ...who, commit: "a".repeat(40), paths, release: ["src/a.ts"], final: true });
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(server.coordinator.snapshot().leases, []);
    } finally {
      await server.close();
    }
  });

  test("acquire still refuses an absurd path list", async () => {
    const server = await startServer({ port: 0, token: "t" });
    try {
      const paths = Array.from({ length: 51 }, (_, i) => `f${i}`);
      const res = await request(new URL(server.url).port, "/v1/acquire", { user: "u", sessionId: "s", repo: "r", label: "l", tool: "Edit", paths });
      assert.equal(res.status, 400);
    } finally {
      await server.close();
    }
  });
});

describe("LAN host names (#112)", () => {
  test("the mDNS name and a trailing-dot name are accepted by a LAN server; strangers are not", async () => {
    const server = await startServer({ port: 0, host: "0.0.0.0", token: "t" });
    try {
      const port = new URL(server.url).port;
      const name = os.hostname().toLowerCase();
      for (const host of [name, `${name}.local`, `${name}.local.`, `${name}.local:4317`]) {
        assert.equal((await request(port, "/v1/state", undefined, { host })).status, 200, host);
      }
      assert.equal((await request(port, "/v1/state", undefined, { host: `${name}.evil.example` })).status, 403);
    } finally {
      await server.close();
    }
  });
});
