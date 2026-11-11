// Sign in with GitHub (ADR-0031) against a mock GitHub: the server runs the device flow and issues member tokens.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { GitHubLogin } from "../src/login.ts";
import { Members } from "../src/members.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { startGitHubMock, type GitHubMock } from "./github-mock.ts";

const ADMIN = "admin-token";
let gh: GitHubMock;
let server: RunningServer;
let dir: string;
before(async () => {
  gh = await startGitHubMock();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-login-"));
  server = await startServer({ port: 0, token: ADMIN, membersFile: path.join(dir, "members.json"), logFile: path.join(dir, "server.jsonl"), githubClientId: "Iv1.test", githubWeb: gh.url, githubApi: gh.url });
});
after(async () => {
  await server.close();
  await gh.close();
});

const post = async (route: string, body: unknown, token?: string, url = server.url) => {
  const res = await fetch(url + route, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
/** Starts a sign-in (no token) and polls it, as the CLI does, until it is no longer pending. */
async function signIn(replies: Record<string, unknown>[]) {
  gh.replies.push(...replies);
  const start = await post("/v1/login/github/start", {});
  assert.equal(start.status, 200, JSON.stringify(start.body));
  for (;;) {
    await sleep(60);
    const r = await post("/v1/login/github/poll", { loginId: start.body.loginId });
    if (r.body.status !== "pending") return { ...r, loginId: start.body.loginId as string };
  }
}
const ana = { user: "ana", sessionId: "s", repo: "r", label: "app" };

test("config says GitHub is on; start returns a code and keeps the device code on the server", async () => {
  assert.deepEqual(await (await fetch(server.url + "/v1/login/config")).json(), { github: true });
  const start = await post("/v1/login/github/start", {});
  assert.deepEqual(Object.keys(start.body).sort(), ["expiresIn", "interval", "loginId", "userCode", "verificationUri"]);
  assert.equal(start.body.userCode, "ABCD-1234");
  assert.doesNotMatch(JSON.stringify(start.body), /dev-/);
  // The Host check still applies to the token-less routes.
  const rebound = await new Promise<number>((resolve) => http.get(server.url + "/v1/login/config", { headers: { host: "evil.example" } }, (r) => resolve(r.statusCode ?? 0)));
  assert.equal(rebound, 403);
  const plain = await fetch(server.url + "/v1/login/github/start", { method: "POST", body: "{}" });
  assert.equal(plain.status, 415);
});

test("an invited login signs in, gets a member token under the member's name; the access token is never kept", async () => {
  assert.equal((await post("/v1/members/invite", { name: "bea", github: "Bea-GH" }, ADMIN)).body.token, undefined);
  gh.users.gho_SECRET_bea = { login: "Bea-GH", id: 101 };
  const before = gh.calls.token;
  const r = await signIn([{ error: "authorization_pending" }, { access_token: "gho_SECRET_bea", token_type: "bearer" }]);
  assert.equal(r.body.status, "done");
  assert.equal(r.body.name, "bea");
  assert.ok(gh.calls.token - before >= 2);
  const said = await post("/v1/team/say", { ...ana, text: "hi" }, r.body.token);
  assert.equal(said.status, 200);
  assert.equal(said.body.user, "bea");
  assert.deepEqual((await post("/v1/members/whoami", {}, r.body.token)).body, { name: "bea" });
  for (const file of ["members.json", "server.jsonl"]) assert.doesNotMatch(fs.readFileSync(path.join(dir, file), "utf8"), /gho_SECRET|lanes_m_/);
  assert.match(fs.readFileSync(path.join(dir, "members.json"), "utf8"), /"githubId": 101/);

  // The loginId is single use.
  assert.equal((await post("/v1/login/github/poll", { loginId: r.loginId })).body.status, "denied");
});

test("the GitHub id is bound: a renamed login keeps the seat, a recycled handle does not", async () => {
  gh.users.gho_SECRET_renamed = { login: "bea-new-name", id: 101 };
  const renamed = await signIn([{ access_token: "gho_SECRET_renamed" }]);
  assert.equal(renamed.body.status, "done");
  assert.equal(renamed.body.name, "bea");

  // Someone else now registers the old handle: a different id, so no seat.
  await post("/v1/members/invite", { name: "cai", github: "cai-gh" }, ADMIN);
  gh.users.gho_SECRET_cai = { login: "cai-gh", id: 202 };
  assert.equal((await signIn([{ access_token: "gho_SECRET_cai" }])).body.name, "cai");
  gh.users.gho_SECRET_squatter = { login: "Bea-GH", id: 999 };
  assert.equal((await signIn([{ access_token: "gho_SECRET_squatter" }])).body.status, "denied");
});

test("an uninvited login, a cancelled and an expired code are denied", async () => {
  gh.users.gho_SECRET_x = { login: "stranger", id: 303 };
  const r = await signIn([{ access_token: "gho_SECRET_x" }]);
  assert.deepEqual(r.body, { status: "denied", error: "stranger isn't on this team: ask the admin to run lanes invite <name> --github stranger" });
  assert.match((await signIn([{ error: "access_denied" }])).body.error, /cancelled/);
  assert.match((await signIn([{ error: "expired_token" }])).body.error, /expired/);
});

test("slow_down raises the interval, and the server never polls GitHub faster than it", async () => {
  gh.users.gho_SECRET_slow = { login: "Bea-New-Name", id: 101 };
  gh.replies.push({ error: "slow_down", interval: 0.4 }, { access_token: "gho_SECRET_slow" });
  const { body } = await post("/v1/login/github/start", {});
  const first = await post("/v1/login/github/poll", { loginId: body.loginId });
  assert.deepEqual(first.body, { status: "pending", interval: 0.4 });
  const calls = gh.calls.token;
  assert.equal((await post("/v1/login/github/poll", { loginId: body.loginId })).body.status, "pending");
  assert.equal(gh.calls.token, calls, "a fast client must not make the server poll GitHub");
  await sleep(450);
  assert.equal((await post("/v1/login/github/poll", { loginId: body.loginId })).body.status, "done");
});

test("without a client id: config says off and the routes answer 501", async () => {
  const off = await startServer({ port: 0, token: ADMIN });
  try {
    assert.deepEqual(await (await fetch(off.url + "/v1/login/config")).json(), { github: false });
    for (const route of ["/v1/login/github/start", "/v1/login/github/poll"]) {
      const r = await post(route, { loginId: "x" }, undefined, off.url);
      assert.equal(r.status, 501);
      assert.equal(r.body.error, "GitHub sign-in isn't set up on this server");
    }
  } finally {
    await off.close();
  }
});

test("pending sign-ins are capped per address and in total", async () => {
  const login = new GitHubLogin({ clientId: "Iv1.test", web: gh.url, api: gh.url }, new Members());
  for (let i = 0; i < 5; i++) assert.equal((await login.start("10.0.0.1")).status, 200);
  assert.equal((await login.start("10.0.0.1")).status, 429);
  for (let i = 0; i < 15; i++) assert.equal((await login.start(`10.0.1.${i}`)).status, 200);
  assert.equal((await login.start("10.0.2.1")).status, 429);
});
