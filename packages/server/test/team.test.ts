// Multiplayer routes (ADR-0028) over HTTP, against the in-process server.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../src/server.ts";

let server: RunningServer;
let logFile: string;
before(async () => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-team-log-")), "server.jsonl");
  server = await startServer({ port: 0, logFile });
});
after(() => server.close());

const post = async (route: string, body: unknown) => {
  const res = await fetch(server.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ana = { user: "ana", sessionId: "s-ana", repo: "r", label: "app" };
const bea = { user: "bea", sessionId: "s-bea", repo: "r", label: "app" };

test("a teammate's task shows up in the brief and as a heads-up before an edit", async () => {
  await post("/v1/task", { ...bea, title: "Add OAuth login", predicted: ["src/auth.ts"] });
  assert.match((await post("/v1/team/context", ana)).body.text, /bea: "Add OAuth login"/);
  assert.match((await post("/v1/team/context", { ...ana, path: "src/auth.ts" })).body.text, /bea's agent/);
  assert.equal((await post("/v1/team/context", { ...ana, path: "src/x.ts" })).body.text, "");
});

test("published line ranges narrow the heads-up; bad shapes get 400", async () => {
  const cara = { user: "cara", sessionId: "s-cara", repo: "r2", label: "app" };
  const dan = { user: "dan", sessionId: "s-dan", repo: "r2", label: "app" };
  await post("/v1/task", { ...cara, title: "Tidy utils", predicted: [] });
  await post("/v1/acquire", { ...cara, tool: "Edit", paths: ["src/u.ts"], waitMs: 0 });
  const commit = "a".repeat(40);
  assert.equal((await post("/v1/publish", { ...cara, commit, paths: ["src/u.ts"], ranges: { "src/u.ts": [[10, 12]] } })).status, 200);
  assert.equal((await post("/v1/publish", { ...cara, commit, paths: ["src/u.ts"], ranges: { "src/u.ts": [[200, 200]] } })).status, 200);
  assert.match((await post("/v1/team/context", { ...dan, path: "src/u.ts", range: [14, 20] })).body.text, /changed lines 10-12 of it/);
  assert.match((await post("/v1/team/context", { ...dan, path: "src/u.ts", range: [198, 198] })).body.text, /changed line 200 of it/, "earlier publishes are kept");
  assert.equal((await post("/v1/team/context", { ...dan, path: "src/u.ts", range: [100, 120] })).body.text, "");
  for (const ranges of [[1, 2], { "src/u.ts": [[3, 1]] }, { "src/u.ts": [["1", 2]] }, { "src/u.ts": [[0, 2]] }, { "src/u.ts": Array.from({ length: 51 }, (_, i) => [i + 1, i + 1]) }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, []]))]) {
    assert.equal((await post("/v1/publish", { ...cara, commit, paths: ["src/u.ts"], ranges })).status, 400, JSON.stringify(ranges).slice(0, 60));
  }
  assert.equal((await post("/v1/team/context", { ...dan, path: "src/u.ts", range: [5] })).status, 400);
  await post("/v1/publish", { ...cara, paths: [], final: true });
  assert.match((await post("/v1/team/context", { ...dan, path: "src/u.ts", range: [100, 120] })).body.text, /changed it/, "a finished task's heads-up is file-level");
});

test("say, ask, decide: only the receiver decides, and the snapshot carries chat and requests", async () => {
  assert.equal((await post("/v1/team/say", { ...ana, text: "@bea secret-plan" })).status, 200);
  const asked = await post("/v1/team/ask", { ...ana, to: "bea", text: "Review src/auth.ts", scope: "read" });
  assert.equal(asked.body.status, "pending");
  const wrong = await post("/v1/team/decide", { ...ana, id: asked.body.id, decision: "approve" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /only the receiver/);
  assert.equal((await post("/v1/team/decide", { ...bea, id: asked.body.id, decision: "approve" })).body.status, "approved");
  const state = await (await fetch(server.url + "/v1/state")).json();
  assert.equal(state.team.chat.at(-1).text, "@bea secret-plan");
  assert.equal(state.team.requests[0].status, "approved");
  const brief = (await post("/v1/team/context", bea)).body;
  assert.match(brief.text, /approved this request from ana \(read only.*: "Review src\/auth\.ts"/);
  assert.deepEqual(brief.deliver, [asked.body.id]);
  assert.equal((await post("/v1/team/requests", ana)).body.requests[0].status, "approved", "delivered only once the hook acks");
  assert.equal((await post("/v1/team/ack", { ...ana, ids: brief.deliver })).body.acked, 0, "only the receiver acks");
  assert.equal((await post("/v1/team/ack", { ...bea, ids: [...brief.deliver, "unknown", 7] })).body.acked, 1);
  assert.equal((await post("/v1/team/requests", ana)).body.requests[0].status, "delivered");
});

test("bad input is a 400, and chat and request text never reach the log", async () => {
  assert.equal((await post("/v1/team/say", { ...ana, text: "   " })).status, 400);
  assert.equal((await post("/v1/team/ask", { ...ana, to: "", text: "x" })).status, 400);
  assert.equal((await post("/v1/team/say", { sessionId: "s", repo: "r", text: "hi" })).status, 400);
  assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /secret-plan|Review src/);
});
