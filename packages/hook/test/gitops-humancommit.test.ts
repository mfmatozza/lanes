// #244: a checkout with unpushed human commits must still publish after a rebase conflict with the shared tip.
// Two insertions at one spot are merged; a real conflict ends as shared-wins + backup + re-apply; later publishes never get stuck.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkpointAndPublish } from "../src/gitops.ts";
import { git, makeTeamRepo } from "./helpers.ts";

process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-home-"));
process.env.LANES_AUTOSTART = "0";
const who = (name: string) => ({ name, email: `${name}@example.com` });
const trailers = { session: "session-1", task: "Test task" };
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const publish = (dir: string, user: string, ...paths: string[]) => checkpointAndPublish(dir, who(user), trailers, paths);
const routes = (...extra: string[]) => `export const routes = [\n  "/",\n${extra.map((r) => `  "${r}",\n`).join("")}];\n`;
// an agent's edit: one more route at the end of the list, whatever else the checkout's copy holds
const append = (dir: string, route: string) => {
  const file = path.join(dir, "src/routes.ts");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\];\s*$/, `  "${route}",\n];\n`));
};
const sharedFile =(main: string, f = "src/routes.ts") => git(main, "show", `lanes/main:${f}`);
const humanCommit = (dir: string, n: number) => {
  write(dir, `human-${n}.txt`, `note ${n}\n`);
  git(dir, "add", `human-${n}.txt`);
  git(dir, "commit", "-qm", `human: note ${n}`);
};

let repo: ReturnType<typeof makeTeamRepo>;
beforeEach(() => (repo = makeTeamRepo("ana", "bea")));
afterEach(() => {
  delete process.env.LANES_MAX_REPLAY;
  repo.cleanup();
});

describe("a human commit in the range does not stop a publish (#244)", () => {
  test("adjacent insertions on both clones are merged and the human's commit stays out", async () => {
    const { ana, bea } = repo.wt;
    humanCommit(ana, 0);
    write(bea, "src/routes.ts", routes("/bea"));
    assert.equal((await publish(bea, "bea", "src/routes.ts")).status, "published");
    write(ana, "src/routes.ts", routes("/ana"));
    const res = await publish(ana, "ana", "src/routes.ts");
    assert.equal(res.status, "published");
    assert.equal((res as { reapply?: unknown }).reapply, undefined, "nothing for the agent to redo");
    const text = sharedFile(repo.main);
    assert.ok(text.includes("/bea") && text.includes("/ana") && !/<<<<|>>>>/.test(text), text);
    assert.ok(!git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main").includes("human-0.txt"), "the human's work never travels");
    assert.match(git(ana, "log", "--format=%s"), /human: note 0/, "the human's commit is still in the branch");
    assert.ok(fs.existsSync(path.join(ana, "human-0.txt")));
    assert.equal(git(ana, "status", "--porcelain"), "");
  });

  test("many human commits between many publishes, with teammates appending at the same spot throughout", async () => {
    const { ana, bea } = repo.wt;
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      humanCommit(ana, i);
      append(bea, `/b${i}`);
      lines.push(`/b${i}`);
      assert.equal((await publish(bea, "bea", "src/routes.ts")).status, "published", `bea ${i}`);
      append(ana, `/a${i}`);
      lines.push(`/a${i}`);
      const res = await publish(ana, "ana", "src/routes.ts");
      assert.equal(res.status, "published", `ana ${i}: ${JSON.stringify(res)}`);
    }
    const text = sharedFile(repo.main);
    for (const l of lines) assert.ok(text.includes(`"${l}"`), `${l} missing:\n${text}`);
    assert.equal(git(ana, "status", "--porcelain"), "");
  });

  test("a real conflict (same line changed differently) ends as shared-wins, a backup and one re-apply note", async () => {
    const { ana, bea } = repo.wt;
    humanCommit(ana, 0);
    write(bea, "src/routes.ts", routes().replace('"/"', '"/home"'));
    assert.equal((await publish(bea, "bea", "src/routes.ts")).status, "published");
    write(ana, "src/routes.ts", routes().replace('"/"', '"/index"'));
    const res = await publish(ana, "ana", "src/routes.ts");
    assert.equal(res.status, "published", JSON.stringify(res));
    assert.deepEqual((res as { reapply?: { paths: string[] } }).reapply?.paths, ["src/routes.ts"]);
    assert.ok(sharedFile(repo.main).includes("/home"));
    assert.ok(git(ana, "for-each-ref", "refs/lanes/backup").length > 0, "the agent's version is in a backup ref");
    const backup = git(ana, "for-each-ref", "--format=%(objectname)", "refs/lanes/backup").split("\n")[0];
    assert.match(git(ana, "show", `${backup}:src/routes.ts`), /\/index/, "the agent's version is kept in the backup");
    assert.match(git(ana, "log", "--format=%s"), /human: note 0/);
  });

  test("many Lanes commits that stay blocked do not starve the independent ones (bounded replay per publish)", async () => {
    const { ana } = repo.wt;
    write(ana, "src/human.ts", "export const h = 0;\n");
    git(ana, "add", "-A");
    git(ana, "commit", "-qm", "human wip");
    // 12 old Lanes commits (the replay cap is set to 5) that build on the human's unshared file: each stays local
    process.env.LANES_MAX_REPLAY = "5";
    for (let i = 1; i <= 12; i++) {
      write(ana, "src/human.ts", `export const h = ${i};\n`);
      git(ana, "commit", "-qam", `task\n\nLanes-Agent: claude-code (session s1)\nLanes-Task: task`);
    }
    write(ana, "src/fresh.ts", "export const f = 1;\n");
    const started = Date.now();
    const first = await publish(ana, "ana", "src/fresh.ts");
    const second = await publish(ana, "ana", "src/fresh.ts");
    const third = await publish(ana, "ana", "src/fresh.ts");
    assert.ok([first, second, third].some((r) => r.status === "published"), JSON.stringify([first, second, third]));
    assert.ok(git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main").includes("src/fresh.ts"), "the independent file is published within two publishes");
    assert.ok(!git(repo.main, "ls-tree", "-r", "--name-only", "lanes/main").includes("src/human.ts"));
    assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
  });

  test("after a conflict the next publishes succeed and the replay work stays bounded", async () => {
    const { ana, bea } = repo.wt;
    humanCommit(ana, 0);
    write(bea, "src/routes.ts", routes().replace('"/"', '"/home"'));
    await publish(bea, "bea", "src/routes.ts");
    write(ana, "src/routes.ts", routes().replace('"/"', '"/index"'));
    assert.equal((await publish(ana, "ana", "src/routes.ts")).status, "published");
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      humanCommit(ana, i + 1);
      write(ana, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
      const res = await publish(ana, "ana", `src/f${i}.ts`);
      assert.equal(res.status, "published", `publish ${i}: ${JSON.stringify(res)}`);
      assert.deepEqual((res as { paths: string[] }).paths, [`src/f${i}.ts`], "only the new file is sent each time");
    }
    assert.ok(Date.now() - started < 60_000);
    for (let i = 0; i < 12; i++) assert.ok(sharedFile(repo.main, `src/f${i}.ts`));
  });
});
