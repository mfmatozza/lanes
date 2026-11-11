// #223: an edit that goes ahead because the server is down is counted locally, then reported once the server answers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "@lanes/server/server.ts";
import { locate } from "@lanes/core/repo.ts";
import { makeTeamRepo } from "./helpers.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_HOME = home;
process.env.LANES_AUTOSTART = "0"; // no server may be left running by this test
const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));

function runHook(event: string, input: object, env: Record<string, string>) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("server down: the edit goes ahead and is counted; server back: the count reaches the snapshot once", async () => {
  const repo = makeTeamRepo("ana");
  const down = await startServer({ port: 0 });
  const deadUrl = down.url;
  await down.close();
  const up = await startServer({ port: 0 });
  try {
    const file = "src/routes.ts";
    const input = { session_id: "s-ana", cwd: repo.wt.ana, tool_name: "Edit", tool_input: { file_path: path.join(repo.wt.ana, file) } };
    const env = (url: string) => ({ LANES_SERVER: url, LANES_USER: "ana", LANES_EMAIL: "ana@example.com" });

    const first = await runHook("pre", input, env(deadUrl));
    assert.equal(first.code, 0, "fail open: the edit is never refused");
    const ledger = fs.readFileSync(path.join(home, "ledger.jsonl"), "utf8");
    const [entry] = ledger.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entry.kind, "failopen");
    assert.deepEqual(Object.keys(entry).sort(), ["kind", "ms", "repo", "ts"]);
    assert.ok(!ledger.includes("routes") && !ledger.includes(path.basename(repo.main)) && !ledger.includes("ana"), "no path, no name");

    const repoId = locate(path.join(repo.wt.ana, file))!.repo.id;
    assert.equal(up.coordinator.snapshot().uncoordinated?.[repoId], undefined);
    const second = await runHook("pre", input, env(up.url));
    assert.equal(second.code, 0, second.stderr);
    assert.equal(up.coordinator.snapshot().uncoordinated?.[repoId], 1);
    const kinds = fs.readFileSync(path.join(home, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
    assert.deepEqual(kinds, ["failopen", "ok"], "a coordinated edit is recorded too");

    await runHook("pre", input, env(up.url));
    assert.equal(up.coordinator.snapshot().uncoordinated?.[repoId], 1, "reported once, not again");
  } finally {
    await up.close();
    repo.cleanup();
  }
});
