// #261 (scale test): what viewers get stays bounded as prompts pile up, and ended sessions are not kept forever.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Coordinator } from "../src/coordinator.ts";
import { recentTasks, startServer } from "../src/server.ts";

const ref = (user: string, n: number) => ({ user, sessionId: `${user}-${n}`, repo: "r", label: "app" });

describe("scale bounds (#261)", () => {
  test("a snapshot carries every active task and only each person's latest finished ones; team context still sees all", async () => {
    const coordinator = new Coordinator();
    for (let n = 0; n < 40; n++) {
      coordinator.createTask({ ...ref("ana", n), title: `t${n}`, predicted: [] });
      coordinator.publish({ ...ref("ana", n), paths: [], final: true });
    }
    coordinator.createTask({ ...ref("ana", 99), title: "live", predicted: [] });
    coordinator.createTask({ ...ref("bea", 1), title: "bea", predicted: [] });
    coordinator.publish({ ...ref("bea", 1), paths: [], final: true });
    const server = await startServer({ port: 0, coordinator });
    try {
      const snap = await (await fetch(server.url + "/v1/state")).json();
      const done = snap.tasks.filter((t: { status: string; user: string }) => t.status === "done");
      assert.equal(done.filter((t: { user: string }) => t.user === "ana").length, 10);
      assert.deepEqual(done.filter((t: { user: string }) => t.user === "ana").map((t: { title: string }) => t.title), Array.from({ length: 10 }, (_, i) => `t${30 + i}`), "the latest, in order");
      assert.ok(snap.tasks.some((t: { title: string }) => t.title === "live"));
      assert.ok(snap.tasks.some((t: { title: string }) => t.title === "bea"));
      assert.equal(coordinator.snapshot().tasks.length, 42, "the coordinator keeps them all");
    } finally {
      await server.close();
    }
  });

  test("recentTasks keeps order and active tasks", () => {
    const t = (id: string, user: string, status: "active" | "done") => ({ id, user, status, repo: "r", sessionId: id, title: id, predicted: [], touched: [], createdAt: 0 });
    assert.deepEqual(recentTasks([t("a", "x", "done"), t("b", "x", "active"), t("c", "x", "done"), t("d", "x", "done")], 2).map((x) => x.id), ["b", "c", "d"]);
  });

  test("ended sessions are remembered up to a bound", () => {
    const coordinator = new Coordinator();
    for (let n = 0; n < 10_050; n++) coordinator.session({ ...ref("ana", n), event: "end" });
    assert.equal((coordinator as unknown as { endedSessions: Set<string> }).endedSessions.size, 10_000);
  });
});
