// `lanes mcp` corner cases (multiplayer/research/use-cases-and-corner-cases.md, Q.1): odd arguments from an agent and a
// server that is down come back as tool results the agent can read; nothing throws or hangs.
// No "outside git" case here: os.tmpdir() can sit inside a home folder that is itself a repository.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { handle } from "../src/mcp.ts";
import { makeRepo } from "../../hook/test/helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
let server: RunningServer;
let repo: ReturnType<typeof makeRepo>;
before(async () => {
  server = await startServer({ port: 0 });
  process.env.LANES_SERVER = server.url;
  process.env.LANES_USER = "ana";
  repo = makeRepo();
});
after(async () => {
  await server.close();
  repo.cleanup();
});

type Reply = { result?: { content: { text: string }[]; isError?: boolean }; error?: { code: number } };
const tool = (params: Record<string, unknown> | undefined, dir = repo.main) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params }, dir) as Promise<Reply>;

test("arguments that are missing, a string or a list are tool errors, never a crash", async () => {
  for (const params of [undefined, {}, { name: "team_say", arguments: "hello" }, { name: "team_say", arguments: ["hi"] }, { name: "team_heads_up", arguments: null }, { name: "team_ask", arguments: { to: 7, text: {} } }]) {
    const r = await tool(params);
    assert.equal(r.result?.isError, true, JSON.stringify(params));
  }
});

test("asking your own agent through MCP is refused with the reason, as a tool result", async () => {
  const r = await tool({ name: "team_ask", arguments: { to: "@ANA", text: "do it" } });
  assert.equal(r.result?.isError, true);
  assert.match(r.result!.content[0].text, /ask your own agent/);
});

test("server down: every tool answers at once with a readable error (fail open), the brief included", async () => {
  process.env.LANES_SERVER = "http://127.0.0.1:1";
  try {
    for (const name of ["team_brief", "team_heads_up", "team_say", "team_requests", "team_status", "team_members"]) {
      const started = performance.now();
      const r = await tool({ name, arguments: { path: "src/a.ts", text: "x" } });
      assert.equal(r.result?.isError, true, name);
      assert.match(r.result!.content[0].text, /Can't reach the Lanes server/, name);
      assert.ok(performance.now() - started < 6_000, name);
    }
  } finally {
    process.env.LANES_SERVER = server.url;
  }
});

test("team_members away from the server's machine: names only, and it says why", async () => {
  const other = await startServer({ port: 0 });
  const { token } = (await (await fetch(other.url + "/v1/members/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ana" }) })).json()) as { token: string };
  Object.assign(process.env, { LANES_SERVER: other.url, LANES_TOKEN: token });
  try {
    await fetch(other.url + "/v1/session", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ user: "ana", sessionId: "s1", repo: "r", label: "r", event: "start" }) });
    const r = await tool({ name: "team_members", arguments: {} });
    assert.equal(r.result?.isError, undefined);
    assert.equal(r.result!.content[0].text, "ana\nWhether each has a personal token can only be read on the server's machine.");
  } finally {
    process.env.LANES_SERVER = server.url;
    delete process.env.LANES_TOKEN;
    await other.close();
  }
});
