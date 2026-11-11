// `lanes mcp` (ADR-0028): MCP handshake, the tool list, and tool calls against a real in-process server.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { startServer, type RunningServer } from "@lanes/server/server.ts";
import { handle } from "../src/mcp.ts";
import { teamPost, whoAmI } from "../src/team.ts";
import { git, makeRepo } from "../../hook/test/helpers.ts";

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

const call = (id: number, method: string, params?: Record<string, unknown>) => handle({ jsonrpc: "2.0", id, method, params }, repo.main) as Promise<{ result?: any; error?: any }>;

test("initialize echoes the protocol version and offers tools; there is no approve tool", async () => {
  assert.equal((await call(1, "initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  const names = (await call(2, "tools/list")).result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ["team_brief", "team_check_file", "team_say", "team_ask", "team_requests", "team_status", "team_members"]);
  assert.ok(!names.some((n: string) => /approve|deny|decide/.test(n)), "only a person approves");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, repo.main), undefined);
  assert.equal((await call(3, "bogus")).error.code, -32601);
});

test("team_ask and team_requests round-trip through the server; errors come back as tool results", async () => {
  const asked = await call(4, "tools/call", { name: "team_ask", arguments: { to: "bea", text: "Check the migration" } });
  assert.match(asked.result.content[0].text, /sent to bea/);
  const listed = await call(5, "tools/call", { name: "team_requests", arguments: {} });
  assert.match(listed.result.content[0].text, /^\w{8} {2}Waiting {2}to bea {2}Read only {2}~\d+ min left {2}Check the migration$/);
  const bad = await call(6, "tools/call", { name: "team_say", arguments: { text: "" } });
  assert.equal(bad.result.isError, true);
  assert.ok(git(repo.main, "rev-parse", "HEAD"));
});

test("team_check_file: a teammate's published lines near the given range, nothing elsewhere; the old team_heads_up name still works (S3.6)", async () => {
  const init = (await call(7, "initialize", {})).result;
  assert.match(init.instructions, /team_brief when you start a task and team_check_file before editing/);
  const tools = (await call(8, "tools/list")).result.tools as { name: string; description: string }[];
  assert.match(tools.find((t) => t.name === "team_brief")!.description, /^Call at the start of each task/);
  assert.match(tools.find((t) => t.name === "team_check_file")!.description, /^Call before editing.*never blocked/);
  for (const t of tools) assert.doesNotMatch(t.description, /\bstop\b|ask (your|the) user|wait for/i, "information only, never an instruction to stop or ask");

  const bea = { ...whoAmI(repo.main), user: "bea", sessionId: "s-bea" };
  await teamPost("/v1/task", { ...bea, title: "Tidy utils", predicted: [] });
  await teamPost("/v1/acquire", { ...bea, tool: "Edit", paths: ["src/u.ts"], waitMs: 0 });
  await teamPost("/v1/publish", { ...bea, commit: "b".repeat(40), paths: ["src/u.ts"], ranges: { "src/u.ts": [[10, 12]] } });
  const check = async (args: Record<string, unknown>, name = "team_check_file") => (await call(9, "tools/call", { name, arguments: args })).result.content[0].text as string;
  assert.match(await check({ path: "src/u.ts", startLine: 11, endLine: 14 }), /bea.*changed lines 10-12/);
  assert.equal(await check({ path: "src/u.ts", startLine: 100, endLine: 120 }), "No teammate is changing this file.");
  assert.match(await check({ path: "src/u.ts" }), /bea/, "no lines given: file-level");
  assert.match(await check({ path: "src/u.ts", startLine: 0, endLine: "x" }), /bea/, "a bad range is ignored, not an error");
  assert.match(await check({ path: "src/u.ts" }, "team_heads_up"), /bea/);
  assert.equal(await check({ path: "src/other.ts" }), "No teammate is changing this file.");
});

test("team_status: the Team view as text, with waiting, files, task titles and the team context switch", async () => {
  const status = async () => (await call(10, "tools/call", { name: "team_status", arguments: {} })).result.content[0].text as string;
  const me = whoAmI(repo.main);
  const cara = { ...me, user: "cara", sessionId: "s-cara" };
  await teamPost("/v1/session", { ...cara, event: "start" });
  await teamPost("/v1/task", { ...cara, title: "Rework login", predicted: [] });
  await teamPost("/v1/acquire", { ...cara, tool: "Edit", paths: ["src/login.ts"], waitMs: 0 });
  const ana = { ...me, sessionId: "s-ana" };
  await teamPost("/v1/session", { ...ana, event: "start" });
  // ana's agent queues behind cara's lease; the status shows it waiting while the acquire is pending.
  const queued = teamPost("/v1/acquire", { ...ana, tool: "Edit", paths: ["src/login.ts"], waitMs: 3_000 });
  await new Promise((r) => setTimeout(r, 200));
  const text = await status();
  assert.match(text, /^Team context is off in this repository\./);
  assert.match(text, /^cara:$/m);
  assert.match(text, /^ {2}\S.*: working; task "Rework login"; files: src\/login\.ts$/m);
  assert.match(text, /^ana \(your user\):$/m);
  assert.match(text, /waiting on src\/login\.ts \(held by cara's agent\)/);
  await teamPost("/v1/release", { repo: me.repo, path: "src/login.ts" });
  await queued;

  fs.mkdirSync(path.join(repo.main, ".lanes"), { recursive: true });
  fs.writeFileSync(path.join(repo.main, ".lanes", "team.json"), JSON.stringify({ context: true }));
  assert.match(await status(), /^Team context is on/);
  const tools = (await call(11, "tools/list")).result.tools as { name: string; description: string }[];
  for (const name of ["team_status", "team_members"]) assert.match(tools.find((t) => t.name === name)!.description, /Information only\.$/);
});

test("team_members: names the server has seen, marked by personal token; the version comes from the build", async () => {
  const members = async () => (await call(12, "tools/call", { name: "team_members", arguments: {} })).result.content[0].text as string;
  await teamPost("/v1/members/invite", { name: "dora", github: "dora-gh" }, true);
  const text = await members();
  assert.match(text, /^dora: personal token \(GitHub @dora-gh\)$/m);
  assert.match(text, /^cara: no personal token \(name is self-declared\)$/m);
  assert.equal(typeof (await call(13, "initialize", {})).result.serverInfo.version, "string");
});
