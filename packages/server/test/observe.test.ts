// #130: hook observations are kept in a bounded ring and exposed in the snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Coordinator } from "../src/coordinator.ts";
import { startServer } from "../src/server.ts";

test("flagged observations reach the snapshot with whitelisted fields only", () => {
  const c = new Coordinator({ now: () => 5_000 });
  c.observe({ kind: "publish-blocked", user: "ana", repo: "r", sessionId: "s", paths: ["a.bin", 7, "b.psd"], error: "x".repeat(1_000), content: "SECRET FILE CONTENT", prompt: "my prompt" });
  c.observe({ kind: "synced", user: "ana", repo: "r" }); // informational: not kept
  c.observe({ kind: "observe", command: "rm -rf /" }); // a shell command: never kept
  c.observe({ user: "ana" }); // no kind
  const events = c.snapshot().events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { at: 5_000, kind: "publish-blocked", user: "ana", sessionId: "s", repo: "r", path: undefined, paths: ["a.bin", "b.psd"], error: "x".repeat(300), waitedMs: undefined });
  assert.ok(!JSON.stringify(events).includes("SECRET"));
});

test("the ring keeps the last 200 per repository and 100 repositories", () => {
  let t = 0;
  const c = new Coordinator({ now: () => ++t });
  for (let i = 0; i < 250; i++) c.observe({ kind: "sync-failed", repo: "busy", error: `e${i}` });
  const busy = c.snapshot().events.filter((e) => e.repo === "busy");
  assert.equal(busy.length, 200);
  assert.equal(busy[0]!.error, "e50");
  assert.equal(busy.at(-1)!.error, "e249");
  for (let i = 0; i < 150; i++) c.observe({ kind: "sync-failed", repo: `r${i}` });
  const repos = new Set(c.snapshot().events.map((e) => e.repo));
  assert.ok(repos.size <= 100);
  assert.ok(!repos.has("busy"), "the repository with the oldest activity was evicted");
  assert.ok(c.snapshot().events.length <= 500);
});

test("POST /v1/observe feeds GET /v1/state", async () => {
  const server = await startServer({ port: 0, token: "t" });
  try {
    const headers = { "content-type": "application/json", authorization: "Bearer t" };
    const res = await fetch(server.url + "/v1/observe", { method: "POST", headers, body: JSON.stringify({ sessionId: "s", user: "ana", repo: "r", kind: "publish-add-failed", paths: ["too/long"] }) });
    assert.equal(res.status, 200);
    const state = (await (await fetch(server.url + "/v1/state", { headers })).json()) as { events: { kind: string; paths: string[] }[] };
    assert.equal(state.events[0]!.kind, "publish-add-failed");
    assert.deepEqual(state.events[0]!.paths, ["too/long"]);
  } finally {
    await server.close();
  }
});

test("uncoordinated-edit reports add up per repository for a week, counts only (#223)", () => {
  let t = 1_000_000_000;
  const c = new Coordinator({ now: () => t });
  assert.deepEqual({ ...c.snapshot().uncoordinated }, {});
  c.observe({ kind: "uncoordinated", repo: "r", count: 2, path: "secret/file.ts", user: "ana" });
  c.observe({ kind: "uncoordinated", repo: "r", count: 3 });
  c.observe({ kind: "uncoordinated", repo: "r", count: -4 }); // invalid
  c.observe({ kind: "uncoordinated", repo: "r", count: "9" }); // invalid
  c.observe({ kind: "uncoordinated", count: 5 }); // no repository
  assert.deepEqual({ ...c.snapshot().uncoordinated }, { r: 5 });
  assert.equal(c.snapshot().events.length, 0, "not a flagged problem for the views");
  assert.ok(!JSON.stringify(c.snapshot()).includes("secret"));
  t += 8 * 24 * 3_600_000;
  assert.deepEqual({ ...c.snapshot().uncoordinated }, {}, "older than a week is dropped");
});
