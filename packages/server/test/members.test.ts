// Personal member tokens (ADR-0030): the server decides who is calling.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fromThisMachine, startServer, type RunningServer } from "../src/server.ts";

const ADMIN = "admin-token";
let server: RunningServer;
let dir: string;
const membersFile = () => path.join(dir, "members.json");
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-members-"));
  server = await startServer({ port: 0, token: ADMIN, membersFile: membersFile(), logFile: path.join(dir, "server.jsonl") });
});
after(() => server.close());

const post = async (route: string, body: unknown, token = ADMIN) => {
  const res = await fetch(server.url + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ana = { user: "ana", sessionId: "s-ana", repo: "r", label: "app" };

test("without members the shared token works on team routes as before", async () => {
  assert.equal((await post("/v1/team/say", { ...ana, text: "hi" })).status, 200);
});

test("invite, member identity, admin limits, revocation, and no plain token at rest or in the log", async () => {
  const invited = await post("/v1/members/invite", { name: "bea" });
  assert.equal(invited.status, 200);
  const bea: string = invited.body.token;
  assert.match(bea, /^lanes_m_[\w-]{43}$/);

  // The member's token works on reads and writes; the name in the body is replaced.
  assert.equal((await fetch(server.url + "/v1/state", { headers: { authorization: `Bearer ${bea}` } })).status, 200);
  const spoofed = await post("/v1/team/say", { ...ana, text: "posted by bea" }, bea);
  assert.equal(spoofed.body.user, "bea");

  // A member cannot manage members.
  assert.equal((await post("/v1/members/invite", { name: "eve" }, bea)).status, 403);
  assert.equal((await post("/v1/members/list", {}, bea)).status, 403);

  // Once a member exists, the server's own token still works on team routes from the server's machine (the owner is not
  // locked out of their own chat); from another machine it gets 403 (fromThisMachine, below). Leases always work.
  assert.equal((await post("/v1/team/say", { ...ana, text: "x" })).body.user, "ana");
  assert.equal((await post("/v1/acquire", { ...ana, tool: "Edit", paths: ["a.ts"] })).body.decision, "allow");

  // whoami names the member of a personal token; the shared token has no name.
  assert.deepEqual((await post("/v1/members/whoami", {}, bea)).body, { name: "bea" });
  assert.equal((await post("/v1/members/whoami", {})).status, 403);

  // The list shows names only; the file holds a hash, never the token.
  const list = await post("/v1/members/list", {});
  assert.deepEqual(list.body.members.map((m: { name: string }) => m.name), ["bea"]);
  assert.equal(list.body.members[0].hash, undefined);
  const stored = fs.readFileSync(membersFile(), "utf8");
  assert.doesNotMatch(stored, new RegExp(bea));
  assert.match(stored, /"hash": "[0-9a-f]{64}"/);
  if (process.platform !== "win32") assert.equal(fs.statSync(membersFile()).mode & 0o777, 0o600);

  // Re-inviting (any case) replaces the token; remove revokes at once.
  const again = await post("/v1/members/invite", { name: "BEA" });
  assert.equal((await post("/v1/team/say", { ...ana, text: "old" }, bea)).status, 401);
  assert.equal((await post("/v1/members/remove", { name: "bea" })).body.removed, true);
  assert.equal((await post("/v1/team/say", { ...ana, text: "gone" }, again.body.token)).status, 401);

  assert.doesNotMatch(fs.readFileSync(path.join(dir, "server.jsonl"), "utf8"), /lanes_m_/);
});

test("a GitHub invite makes a seat with no token, keeps an existing one, and refuses a login taken by someone else", async () => {
  const seat = await post("/v1/members/invite", { name: "dan", github: "@Dan-GH" });
  assert.deepEqual(seat.body, { name: "dan", github: "dan-gh" });
  const { token } = (await post("/v1/members/invite", { name: "eli" })).body;
  assert.equal((await post("/v1/members/invite", { name: "eli", github: "eli-gh" })).body.token, undefined);
  assert.deepEqual((await post("/v1/members/whoami", {}, token)).body, { name: "eli" }, "the existing token still works");
  assert.equal((await post("/v1/members/invite", { name: "fay", github: "dan-gh" })).status, 400);
  assert.equal((await post("/v1/members/invite", { name: "fay", github: "not a login" })).status, 400);
  const list = (await post("/v1/members/list", {})).body.members as { name: string; github?: string }[];
  assert.equal(list.find((m) => m.name === "dan")?.github, "dan-gh");
});

test("admin means the server's own machine: loopback and the machine's own addresses, nobody else", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(fromThisMachine(a), true, a);
  for (const a of ["203.0.113.9", "::ffff:198.51.100.4", "", undefined]) assert.equal(fromThisMachine(a), false, String(a));
  const lan = Object.values(os.networkInterfaces()).flatMap((l) => l ?? []).find((i) => i.family === "IPv4" && !i.internal);
  if (lan) assert.equal(fromThisMachine(lan.address), true);
});

test("members survive a restart", async () => {
  const { token } = (await post("/v1/members/invite", { name: "cai" })).body;
  const second = await startServer({ port: 0, token: ADMIN, membersFile: membersFile() });
  try {
    const res = await fetch(second.url + "/v1/team/requests", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(ana) });
    assert.equal(res.status, 200);
  } finally {
    await second.close();
  }
});
