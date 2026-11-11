// #223: `lanes report` prints counts and times from the local ledger, never paths, prompts or names, and sends nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-report-"));
const home = path.join(dir, "home");
fs.mkdirSync(home);
const now = Date.now();
const line = (kind: string, ms: number, ago: number, repo = "ab12cd34") => JSON.stringify({ ts: now - ago, repo, kind, ms });
fs.writeFileSync(
  path.join(home, "ledger.jsonl"),
  [...Array.from({ length: 8 }, () => line("ok", 0, 1_000)), line("queued", 400, 2_000), line("queued", 1_500, 3_000), line("failopen", 30, 4_000), line("failopen", 30, 5_000)].join("\n") + "\n",
);

// The server address is a closed port: the report must work offline, from the ledger alone.
function lanes(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir, env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("lanes report prints the counts a team needs to see its own downtime", () => {
  const r = lanes("report");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Edits seen on this machine:\s+12/);
  assert.match(r.out, /went ahead uncoordinated:\s+2/);
  assert.match(r.out, /\(83\.3% of edits/);
  assert.match(r.out, /Collisions handled \(waited in queue\):\s+2/);
  assert.match(r.out, /95th percentile:\s+1\.5 s/);
  assert.match(r.out, /ab12cd34: 12 edits/);
  assert.match(r.out, /Server: did not answer/);
  assert.match(r.out, /Nothing was sent/);
});

test("lanes report --json is the same data, and holds no path, prompt or name field", () => {
  const r = lanes("report", "--json");
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.local.uncoordinated, 2);
  assert.equal(j.local.queueWaitP95Ms, 1500);
  assert.equal(j.server, null);
  assert.ok(!/path|prompt|title|user|name|email/i.test(JSON.stringify(Object.keys(j.local).concat(Object.keys(j)))));
});

test("lanes report --file writes optional blank notes and sends nothing", () => {
  const file = path.join(dir, "feedback.txt");
  const r = lanes("report", "--file", file);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Edits seen on this machine/);
  assert.match(text, /Optional notes\. Skip anything/);
  assert.match(text, /not obliged to send/);
  assert.match(r.out, /email it only if you want to/);
});

test("a bad --days is a usage error", () => {
  assert.equal(lanes("report", "--days", "0").code, 2);
  assert.equal(lanes("report", "--days", "abc").code, 2);
  assert.equal(lanes("report", "--days", "7").code, 0);
});

test("with no ledger, report says so instead of failing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-report-empty-"));
  const r = spawnSync(process.execPath, [cli, "report"], { encoding: "utf8", env: { ...process.env, LANES_HOME: empty, LANES_AUTOSTART: "0", LANES_SERVER: "http://127.0.0.1:1" } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No edits recorded yet/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("lanes hosted prints a waitlist email, labelled as not a purchase, and sends nothing", () => {
  const r = lanes("hosted");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /waitlist, not a purchase/);
  assert.match(r.out, /mailto:.*subject=Lanes%20hosted%20server%20waitlist/);
  assert.match(r.out, /Nothing is sent from here/);
});
