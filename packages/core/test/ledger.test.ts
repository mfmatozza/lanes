// The local ledger (#223): what it stores, how it is capped, and what it summarises.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-ledger-"));
process.env.LANES_HOME = home;
process.env.LANES_LEDGER_MAX_BYTES = "400";
const { appendLedger, p95, readLedger, repoKey, summarize, takeUnreported, WEEK_MS } = await import("../src/ledger.ts");
const ledger = path.join(home, "ledger.jsonl");

test("an entry holds a time, a hashed repository, a kind and milliseconds: no path, no name", () => {
  const repo = "github.com/acme/secret-project-name";
  appendLedger(repo, "failopen", 123.6, 1_000);
  const text = fs.readFileSync(ledger, "utf8");
  assert.deepEqual(JSON.parse(text), { ts: 1_000, repo: repoKey(repo), kind: "failopen", ms: 124 });
  assert.ok(!text.includes("acme") && !text.includes("secret"));
  fs.rmSync(ledger);
});

test("the file is size-capped: it rotates to ledger.jsonl.1 and keeps both files readable", () => {
  for (let i = 0; i < 30; i++) appendLedger("r", "ok", i, 2_000 + i);
  assert.ok(fs.existsSync(ledger + ".1"), "rotated");
  assert.ok(fs.statSync(ledger).size <= 800, "the live file stays near the cap");
  const entries = readLedger();
  assert.ok(entries.length >= 10 && entries.length <= 30);
  assert.equal(entries.at(-1)!.ms, 29, "newest last");
  fs.rmSync(ledger, { force: true });
  fs.rmSync(ledger + ".1", { force: true });
});

test("a damaged line is skipped, not fatal", () => {
  fs.writeFileSync(ledger, "not json\n" + JSON.stringify({ ts: 5, repo: "x", kind: "ok", ms: 1 }) + "\n{\"ts\":1}\n");
  assert.equal(readLedger().length, 1);
  fs.rmSync(ledger);
});

test("summary: counts, coordinated share, collisions, p95 queue wait, downtime weeks, per repository", () => {
  const now = 10 * WEEK_MS;
  const e = (kind: "ok" | "queued" | "failopen", ms: number, ago: number, repo = "a") => ({ ts: now - ago, repo, kind, ms });
  const entries = [
    ...Array.from({ length: 16 }, () => e("ok", 0, 1_000)),
    ...Array.from({ length: 20 }, (_, i) => e("queued", (i + 1) * 100, 2_000)), // waits 100 ms .. 2000 ms
    e("failopen", 50, 3_000),
    e("failopen", 50, WEEK_MS + 3_000, "b"), // a different week
    e("failopen", 50, 90 * 24 * 3_600_000), // outside the 28-day window
  ];
  const s = summarize(entries, now, 28);
  assert.equal(s.edits, 38);
  assert.equal(s.uncoordinated, 2);
  assert.equal(s.coordinated, 36);
  assert.equal(s.queued, 20);
  assert.equal(s.queueWaitP95Ms, 1_900);
  assert.equal(s.downtimeWeeks, 2);
  assert.ok(Math.abs(s.coordinatedShare! - 36 / 38) < 1e-9);
  assert.deepEqual(s.repos.map((r) => [r.repo, r.edits, r.uncoordinated]).sort(), [["a", 37, 1], ["b", 1, 1]]);
  assert.equal(summarize([], now).coordinatedShare, null);
  assert.equal(p95([]), null);
});

test("uncoordinated edits are handed over once, and only for their own repository", () => {
  const now = 50_000_000_000;
  appendLedger("repo-1", "failopen", 10, now - 5_000);
  appendLedger("repo-1", "failopen", 10, now - 4_000);
  appendLedger("repo-2", "failopen", 10, now - 3_000);
  appendLedger("repo-1", "failopen", 10, now - 40 * 24 * 3_600_000); // too old to matter
  assert.equal(takeUnreported("repo-1", now), 2);
  assert.equal(takeUnreported("repo-1", now + 1), 0, "not reported twice");
  assert.ok(fs.existsSync(path.join(home, "ledger.pending")), "repo-2 is still waiting");
  assert.equal(takeUnreported("repo-2", now + 2), 1);
  assert.ok(!fs.existsSync(path.join(home, "ledger.pending")), "nothing left to report");
  assert.equal(takeUnreported("repo-3", now + 3), 0);
});

test("a ledger that cannot be written never throws", () => {
  const blocked = path.join(home, "blocked");
  fs.writeFileSync(blocked, "a file, not a folder");
  const saved = process.env.LANES_HOME;
  process.env.LANES_HOME = path.join(blocked, "sub");
  try {
    assert.doesNotThrow(() => appendLedger("r", "ok", 1));
    assert.equal(takeUnreported("r"), 0);
  } finally {
    process.env.LANES_HOME = saved;
  }
});
