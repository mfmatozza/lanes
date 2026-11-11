// `lanes invite | join | members` (ADR-0030) against an in-process server; every LANES_HOME is a temp folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startServer } from "@lanes/server/server.ts";
import { startGitHubMock } from "../../server/test/github-mock.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LANES_")));

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { ...clean, LANES_AUTOSTART: "0", ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("invite prints a join command; join saves the server, token and name and checks them", async () => {
  const server = await startServer({ port: 0, token: "admin-token" });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lanes-join-"));
  const admin = { LANES_HOME: tmp(), LANES_SERVER: server.url, LANES_TOKEN: "admin-token" };
  try {
    const invite = await run(["invite", "bea"], admin);
    assert.equal(invite.code, 0, invite.err);
    const token = /lanes join \S+ (lanes_m_\S+) --user "bea"/.exec(invite.out)?.[1];
    assert.ok(token, invite.out);
    assert.match(invite.out, /shown only this once/);

    const home = tmp();
    const join = await run(["join", server.url, token, "--user", "bea"], { LANES_HOME: home });
    assert.equal(join.code, 0, join.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")), { serverUrl: server.url, token, user: "bea" });

    assert.match((await run(["members"], admin)).out, /^1 teammate has a personal token\n {2}bea {2}invited \d{4}-\d{2}-\d{2}/);
    const wrong = await run(["join", server.url, "lanes_m_wrong", "--user", "bea"], { LANES_HOME: tmp() });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /refused the token/);
    // The server names the token: no --user needed, and a wrong one is ignored.
    const named = tmp();
    const noUser = await run(["join", server.url, token, "--user", "mallory"], { LANES_HOME: named });
    assert.equal(noUser.code, 0, noUser.err);
    assert.match(noUser.out, /as bea .*--user mallory was ignored/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(named, "config.json"), "utf8")).user, "bea");
    assert.equal((await run(["join", server.url], { LANES_HOME: tmp() })).code, 2);

    const gh = await run(["invite", "cai", "--github", "cai-gh"], admin);
    assert.equal(gh.code, 0, gh.err);
    assert.match(gh.out, /Invited cai as GitHub @cai-gh\.\nAsk cai to run: lanes login --server http:\/\/[\d.]+:\d+/);
    assert.match((await run(["members"], admin)).out, /cai {2}invited \S+ {2}GitHub @cai-gh/);
  } finally {
    await server.close();
  }
});

test("lanes login runs the device flow through the server and saves the member token", async () => {
  const gh = await startGitHubMock();
  const server = await startServer({ port: 0, token: "admin-token", githubClientId: "Iv1.test", githubWeb: gh.url, githubApi: gh.url });
  try {
    const admin = { LANES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "lanes-login-")), LANES_SERVER: server.url, LANES_TOKEN: "admin-token" };
    assert.equal((await run(["invite", "bea", "--github", "bea-gh"], admin)).code, 0);
    gh.users.gho_SECRET = { login: "bea-gh", id: 7 };
    gh.replies.push({ error: "authorization_pending" }, { access_token: "gho_SECRET" });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-login-"));
    const login = await run(["login", "--server", server.url, "--print"], { LANES_HOME: home });
    assert.equal(login.code, 0, login.err);
    assert.match(login.out, /Open https:\/\/github\.com\/login\/device and enter ABCD-1234/);
    assert.match(login.out, /Signed in as bea/);
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.serverUrl, server.url);
    assert.equal(config.user, "bea");
    assert.match(config.token, /^lanes_m_/);

    gh.users.gho_OTHER = { login: "stranger", id: 8 };
    gh.replies.push({ access_token: "gho_OTHER" });
    const denied = await run(["login", "--server", server.url, "--print"], { LANES_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "lanes-login-")) });
    assert.equal(denied.code, 1);
    assert.match(denied.err, /stranger isn't on this team/);
  } finally {
    await server.close();
    await gh.close();
  }
});
