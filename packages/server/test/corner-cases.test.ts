// Server corner cases (multiplayer/research/use-cases-and-corner-cases.md, Q.1): a damaged members file, a member removed
// mid-session, spoofed names, and hostile shapes on the team routes. In-process server, temp folders only.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "../src/server.ts";

const ADMIN = "admin-token";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-corner-server-"));
let server: RunningServer;
before(async () => {
  server = await startServer({ port: 0, token: ADMIN, membersFile: path.join(tmp, "members.json") });
});
after(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (route: string, body: unknown, token = ADMIN, url = server.url) => {
  const res = await fetch(url + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ref = (user: string) => ({ user, sessionId: `s-${user}`, repo: "r", label: "app" });

test("a members file that parses but is not a member list stops the server with a clear message, never a server that fails every edit", async () => {
  for (const content of ["{}", '{"members":null}', '{"members":{}}', '{"members":[{"hash":"x"}]}', '{"members":[null]}', "null", "[]"]) {
    const file = path.join(tmp, `bad-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, content);
    await assert.rejects(startServer({ port: 0, token: ADMIN, membersFile: file }), /not a valid members file/, content);
    assert.equal(fs.readFileSync(file, "utf8"), content, "the damaged file is left for the admin to fix");
  }
  const ok = path.join(tmp, "ok.json");
  fs.writeFileSync(ok, '{"members":[]}');
  const s = await startServer({ port: 0, token: ADMIN, membersFile: ok });
  assert.equal((await post("/v1/acquire", { ...ref("ana"), tool: "Edit", paths: ["a.ts"] }, ADMIN, s.url)).body.decision, "allow");
  await s.close();
});

test("a member removed mid-session: their token stops at once, and their open requests can no longer be approved or delivered", async () => {
  const ana = (await post("/v1/members/invite", { name: "ana" })).body.token;
  const bea = (await post("/v1/members/invite", { name: "bea" })).body.token;
  const fromAna = (await post("/v1/team/ask", { ...ref("ana"), to: "bea", text: "Explain the cache", scope: "edit" }, ana)).body;
  const toAna = (await post("/v1/team/ask", { ...ref("bea"), to: "ana", text: "Review my PR", scope: "read" }, bea)).body;
  await post("/v1/team/decide", { ...ref("ana"), id: toAna.id, decision: "approve" }, ana);
  assert.equal((await post("/v1/members/remove", { name: "ANA " })).body.removed, true);

  assert.equal((await post("/v1/team/context", ref("ana"), ana)).status, 401);
  assert.equal((await post("/v1/acquire", { ...ref("ana"), tool: "Edit", paths: ["x.ts"] }, ana)).status, 401, "the hook then fails open (ADR-0019)");
  const decided = await post("/v1/team/decide", { ...ref("bea"), id: fromAna.id, decision: "approve" }, bea);
  assert.equal(decided.status, 400);
  assert.match(decided.body.error, /expired/);
  const states = (await post("/v1/team/requests", ref("bea"), bea)).body.requests.map((r: { id: string }) => r.id);
  assert.ok(!states.includes(fromAna.id) && !states.includes(toAna.id), "neither is open any more");
});

test("a member cannot decide, ack or reply as the receiver by putting the receiver's name in the body", async () => {
  const cai = (await post("/v1/members/invite", { name: "cai" })).body.token;
  const dan = (await post("/v1/members/invite", { name: "dan" })).body.token;
  const r = (await post("/v1/team/ask", { ...ref("cai"), to: "dan", text: "Look at x", scope: "read" }, cai)).body;
  const spoof = await post("/v1/team/decide", { ...ref("dan"), id: r.id, decision: "approve" }, cai);
  assert.equal(spoof.status, 400);
  assert.match(spoof.body.error, /only the receiver/);
  await post("/v1/team/decide", { ...ref("dan"), id: r.id, decision: "approve" }, dan);
  assert.equal((await post("/v1/team/ack", { ...ref("dan"), ids: [r.id] }, cai)).body.acked, 0);
  assert.equal((await post("/v1/team/reply", { ...ref("dan"), id: r.id, text: "forged" }, cai)).status, 400);
});

test("hostile shapes on the team routes are 400s, never a 500 or a crash", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["/v1/team/context", { ...ref("eve"), path: 42 }],
    ["/v1/team/context", { ...ref("eve"), path: "x".repeat(600) }],
    ["/v1/team/context", { ...ref("eve"), path: "a.ts", range: [1.5, 3] }],
    ["/v1/team/context", { ...ref("eve"), path: "a.ts", range: [5, 2] }],
    ["/v1/team/say", { ...ref("eve"), text: { toString: "x" } }],
    ["/v1/team/ask", { ...ref("eve"), to: ["bea"], text: "x" }],
    ["/v1/team/decide", { ...ref("eve"), id: 7, decision: "approve" }],
    ["/v1/team/decide", { ...ref("eve"), id: "ffffffff", decision: "approve" }],
    ["/v1/team/reply", { ...ref("eve"), id: "ffffffff", text: "x" }],
    ["/v1/team/requests", { user: "eve", sessionId: "s", repo: "" }],
    ["/v1/team/say", { user: "x".repeat(513), sessionId: "s", repo: "r", text: "hi" }],
  ];
  for (const [route, body] of cases) {
    const res = await post(route, body);
    assert.equal(res.status, 400, `${route} ${JSON.stringify(body).slice(0, 80)}`);
  }
  assert.equal((await post("/v1/team/ack", { ...ref("eve"), ids: "not-a-list" })).body.acked, 0);
  assert.equal((await fetch(server.url + "/health")).status, 200, "still up");
});

test("a request id from another repository is not found, even for its receiver", async () => {
  const r = (await post("/v1/team/ask", { ...ref("fay"), to: "gus", text: "x", scope: "read" })).body;
  const other = await post("/v1/team/decide", { ...ref("gus"), repo: "other", id: r.id, decision: "approve" });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /no such request/);
});

test("a server restart keeps pending and approved requests", { skip: "shortcut: team state is in memory like leases (architecture.md); persist it next to members.json when restarts lose requests in use" }, async () => {
  const file = path.join(tmp, "restart-members.json");
  const first = await startServer({ port: 0, token: ADMIN, membersFile: file });
  const r = (await post("/v1/team/ask", { ...ref("hal"), to: "ivy", text: "x", scope: "read" }, ADMIN, first.url)).body;
  await first.close();
  const second = await startServer({ port: 0, token: ADMIN, membersFile: file });
  try {
    assert.equal((await post("/v1/team/decide", { ...ref("ivy"), id: r.id, decision: "approve" }, ADMIN, second.url)).status, 200);
  } finally {
    await second.close();
  }
});
