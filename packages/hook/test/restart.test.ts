// #89: after a server restart (file versions are in memory only) the next acquirer is still synced. From stress3.ts `restart`.
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

test("after a server restart the next agent is still synced with the last published change", async () => {
  let server = await startServer({ port: 0 });
  const port = Number(new URL(server.url).port);
  const repo = makeTeamRepo("ana", "bea");
  const env = (user: string) => ({ LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: user, LANES_EMAIL: `${user}@example.com` });
  const edit = (session: string, cwd: string) => ({ session_id: session, cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, "src", "routes.ts") } });
  try {
    await runHook("pre", edit("s-ana", repo.wt.ana), env("ana"));
    fs.writeFileSync(path.join(repo.wt.ana, "src", "routes.ts"), 'export const routes = [\n  "/",\n  "/ana",\n];\n');
    await runHook("post", edit("s-ana", repo.wt.ana), env("ana"));
    assert.match(git(repo.main, "show", "lanes/main:src/routes.ts"), /\/ana/);

    await server.close();
    server = await startServer({ port });
    const res = await runHook("pre", edit("s-bea", repo.wt.bea), env("bea"));
    assert.equal(res.code, 0, res.stderr);
    assert.match(fs.readFileSync(path.join(repo.wt.bea, "src", "routes.ts"), "utf8"), /\/ana/, "bea's copy has ana's change");
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /new content since you last read it/);
  } finally {
    await server.close();
    repo.cleanup();
  }
});
