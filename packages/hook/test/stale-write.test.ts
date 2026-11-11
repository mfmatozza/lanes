// #218: a whole-file Write composed from an old copy must not remove what teammates published since. Through the real hook.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "@lanes/server/server.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("a line the agent itself removed on a later Write is not brought back; teammates' lines stay; no teammate means no change", async () => {
  const server = await startServer({ port: 0 });
  const port = Number(new URL(server.url).port);
  const repo = makeTeamRepo("ana", "bea");
  const env = (user: string) => ({ LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: user, LANES_EMAIL: `${user}@example.com` });
  const tool = (session: string, cwd: string) => ({ session_id: session, cwd, tool_name: "Write", tool_input: { file_path: path.join(cwd, "src", "routes.ts") } });
  const routes = (...extra: string[]) => `export const routes = [\n  "/",\n${extra.map((r) => `  "${r}",\n`).join("")}];\n`;
  const write = async (user: string, session: string, wt: string, text: string) => {
    await runHook("pre", tool(session, wt), env(user));
    fs.writeFileSync(path.join(wt, "src", "routes.ts"), text);
    return runHook("post", tool(session, wt), env(user));
  };
  try {
    await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "rework routes" }, env("bea"));
    const v1 = await write("bea", "s-bea", repo.wt.bea, routes("/a"));
    assert.equal(v1.stdout, "", "nothing arrived: no note");
    const v1b = await write("bea", "s-bea", repo.wt.bea, routes("/a", "/a2"));
    assert.equal(v1b.stdout, "", "two Writes in a row without teammate activity change nothing");
    await write("ana", "s-ana", repo.wt.ana, routes("/a", "/a2", "/b")); // ana's edit builds on bea's published lines and adds /b
    const v2 = await write("bea", "s-bea", repo.wt.bea, routes("/c")); // bea deliberately drops /a and /a2 and adds /c
    assert.equal(v2.code, 0, v2.stderr);
    const shared = git(repo.main, "show", "lanes/main:src/routes.ts");
    assert.ok(shared.includes("/b") && shared.includes("/c"), shared);
    assert.ok(!shared.includes('"/a"') && !shared.includes('"/a2"'), `removed lines came back:\n${shared}`);
  } finally {
    await server.close();
    repo.cleanup();
  }
});

test("bea's stale whole-file Write keeps ana's published route", async () => {
  const server = await startServer({ port: 0 });
  const port = Number(new URL(server.url).port);
  const repo = makeTeamRepo("ana", "bea");
  const env = (user: string) => ({ LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: user, LANES_EMAIL: `${user}@example.com` });
  const tool = (session: string, cwd: string, name: string) => ({ session_id: session, cwd, tool_name: name, tool_input: { file_path: path.join(cwd, "src", "routes.ts") } });
  const routes = (...extra: string[]) => `export const routes = [\n  "/",\n${extra.map((r) => `  "${r}",\n`).join("")}];\n`;
  try {
    // bea's turn starts and she reads the file as it is now
    await runHook("prompt", { session_id: "s-bea", cwd: repo.wt.bea, prompt: "add inventory" }, env("bea"));
    // ana publishes a route meanwhile
    await runHook("pre", tool("s-ana", repo.wt.ana, "Edit"), env("ana"));
    fs.writeFileSync(path.join(repo.wt.ana, "src", "routes.ts"), routes("/ana"));
    await runHook("post", tool("s-ana", repo.wt.ana, "Edit"), env("ana"));
    // bea's Write was composed from the old copy: the pre-hook syncs ana's line in, then the Write replaces the whole file
    await runHook("pre", tool("s-bea", repo.wt.bea, "Write"), env("bea"));
    fs.writeFileSync(path.join(repo.wt.bea, "src", "routes.ts"), routes("/bea"));
    const post = await runHook("post", tool("s-bea", repo.wt.bea, "Write"), env("bea"));
    assert.equal(post.code, 0, post.stderr);
    const shared = git(repo.main, "show", "lanes/main:src/routes.ts");
    assert.ok(shared.includes("/ana") && shared.includes("/bea"), shared);
    assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /put back/);
  } finally {
    await server.close();
    repo.cleanup();
  }
});
