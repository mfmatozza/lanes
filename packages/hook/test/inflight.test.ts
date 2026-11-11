// #261 (scale test): an agent writes its file between its pre and post hooks, outside any lock. Another session's publish
// in the same checkout rebased/reset the working tree in that window and silently undid the write. While an edit is marked
// in flight, nothing rewrites the working tree; the publish still goes out (as a replayed tip).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkpointAndPublish, markEditInFlight, syncFromIntegration } from "../src/gitops.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
const who = (name: string) => ({ name, email: `${name}@example.com` });
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

let repo: ReturnType<typeof makeTeamRepo>;
beforeEach(() => (repo = makeTeamRepo("ana", "bea")));
afterEach(() => repo.cleanup());

describe("edits in flight (#261)", () => {
  test("another session's marked edit keeps sync and publish off the working tree; clearing it lets the sync run", async () => {
    const ana = repo.wt.ana;
    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    assert.equal((await checkpointAndPublish(repo.wt.bea, who("bea"), { session: "bea-1", task: "b" }, ["src/b.ts"])).status, "published");

    markEditInFlight(ana, "ana-2", "src/a.ts", true);
    const head = git(ana, "rev-parse", "HEAD");
    const synced = syncFromIntegration(ana, who("ana"));
    assert.equal(synced.ok, false);
    assert.equal(!synced.ok && synced.skipped, true);
    assert.equal(git(ana, "rev-parse", "HEAD"), head, "no rebase while another edit is under way");

    write(ana, "src/c.ts", "export const c = 1;\n");
    const res = await checkpointAndPublish(ana, who("ana"), { session: "ana-1", task: "c" }, ["src/c.ts"]);
    assert.equal(res.status, "published");
    assert.ok(!fs.existsSync(path.join(ana, "src", "b.ts")), "the working tree was not synced");
    const shared = git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main");
    assert.match(shared, /src\/b\.ts/);
    assert.match(shared, /src\/c\.ts/);

    markEditInFlight(ana, "ana-2", "src/a.ts", false);
    assert.ok(syncFromIntegration(ana, who("ana")).ok);
    assert.ok(fs.existsSync(path.join(ana, "src", "b.ts")));
  });

  test("a session's own mark (a Cursor turn) does not stop its own publish from syncing", async () => {
    const ana = repo.wt.ana;
    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    await checkpointAndPublish(repo.wt.bea, who("bea"), { session: "bea-1", task: "b" }, ["src/b.ts"]);
    markEditInFlight(ana, "ana-1", "(turn)", true);
    write(ana, "src/c.ts", "export const c = 1;\n");
    assert.equal((await checkpointAndPublish(ana, who("ana"), { session: "ana-1", task: "c" }, ["src/c.ts"])).status, "published");
    assert.ok(fs.existsSync(path.join(ana, "src", "b.ts")), "synced");
  });

  test("a stale mark (an agent killed mid-edit) is ignored and removed; a session's marks clear together", async () => {
    const ana = repo.wt.ana;
    write(repo.wt.bea, "src/b.ts", "export const b = 1;\n");
    await checkpointAndPublish(repo.wt.bea, who("bea"), { session: "bea-1", task: "b" }, ["src/b.ts"]);
    markEditInFlight(ana, "ana-2", "src/a.ts", true);
    markEditInFlight(ana, "ana-2", "src/routes.ts", true);
    markEditInFlight(ana, "ana-2", undefined, false);
    markEditInFlight(ana, "ana-3", "src/a.ts", true);
    const dir = path.join(process.env.LANES_HOME!, "inflight");
    for (const sub of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, sub))) fs.utimesSync(path.join(dir, sub, f), new Date(0), new Date(0));
    assert.ok(syncFromIntegration(ana, who("ana")).ok);
    assert.ok(fs.existsSync(path.join(ana, "src", "b.ts")));
  });
});
