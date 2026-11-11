// #114: session state files do not pile up forever.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTeamRepo } from "./helpers.ts";

const HOOK = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
const sessions = path.join(home, "sessions");

function runHook(event: string, input: object): Promise<void> {
  return new Promise((resolve) => {
    const env = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1", LANES_USER: "ana" };
    const child = spawn(process.execPath, ["--no-warnings", HOOK, event], { env });
    child.on("close", () => resolve());
    child.stdin.end(JSON.stringify(input));
  });
}

test("the end of a session removes its state; old leftovers are pruned at the next start", async () => {
  const repo = makeTeamRepo("ana");
  try {
    const cwd = repo.wt.ana;
    await runHook("prompt", { session_id: "s-end", cwd, prompt: "Add a route" });
    assert.ok(fs.existsSync(path.join(sessions, "s-end.json")), "created by the prompt");
    await runHook("end", { session_id: "s-end", cwd });
    assert.ok(!fs.existsSync(path.join(sessions, "s-end.json")));

    const old = ["s-old.json", "s-old.json.corrupt", "s-old.json.123.tmp"].map((f) => path.join(sessions, f));
    for (const f of old) {
      fs.writeFileSync(f, "{}");
      fs.utimesSync(f, new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000));
    }
    fs.writeFileSync(path.join(sessions, "s-new.json"), "{}");
    await runHook("start", { session_id: "s-start", cwd });
    for (const f of old) assert.ok(!fs.existsSync(f), `${f} pruned`);
    assert.ok(fs.existsSync(path.join(sessions, "s-new.json")), "recent state is kept");
  } finally {
    repo.cleanup();
  }
});

test("state with files still waiting to be published is kept at the end", async () => {
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "s-keep.json"), JSON.stringify({ touched: ["src/a.ts"] }));
  await runHook("end", { session_id: "s-keep", cwd: os.tmpdir() });
  assert.ok(fs.existsSync(path.join(sessions, "s-keep.json")));
});
