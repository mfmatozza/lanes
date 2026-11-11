// Soak: N agents (2 per human clone, no LLM: real hook events against the real bundled server) edit a shared file for
// --minutes minutes while a human commits, the server is restarted once and the origin goes away and comes back.
// Reports server memory (RSS) over time, hook latency per window (drift), and checks no line is missing from lanes/main.
// Usage: npm run build && node scripts/e2e/soak.mjs [--minutes 30] [--agents 4] [--think 2000]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LANES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const num = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const MINUTES = num("--minutes", 30), AGENTS = num("--agents", 4), THINK = num("--think", 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();
const t0 = Date.now();
const mins = () => ((Date.now() - t0) / 60000).toFixed(1);
const log = (...m) => console.log(`[${mins()} min]`, ...m);

const root = fs.mkdtempSync(path.join((process.env.LANES_TMP ?? "C:/lanes-tmp"), "lanes-soak-"));
const origin = path.join(root, "origin.git");
const originAway = path.join(root, "origin-away.git");
git(root, "init", "-q", "--bare", "-b", "main", origin);
const seed = path.join(root, "seed");
git(root, "clone", "-q", origin, seed);
for (const [k, v] of [["user.name", "Seed"], ["user.email", "seed@example.com"], ["core.autocrlf", "false"]]) git(seed, "config", k, v);
fs.mkdirSync(path.join(seed, "src"));
fs.writeFileSync(path.join(seed, "src", "shared.ts"), "export const shared: string[] = [];\n");
git(seed, "add", "-A"); git(seed, "commit", "-qm", "seed"); git(seed, "push", "-q", "origin", "main");
const home = path.join(root, "home");
fs.mkdirSync(home);
const env0 = { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" };
for (const k of Object.keys(env0)) if (/^CLAUDE_?CODE/i.test(k)) delete env0[k];
const humans = ["ana", "bea"], clone = {};
for (const h of humans) {
  const dir = path.join(root, `${h}-repo`);
  git(root, "clone", "-q", "-c", "core.autocrlf=false", origin, dir);
  for (const [k, v] of [["user.name", h], ["user.email", `${h}@example.com`], ["core.autocrlf", "false"]]) git(dir, "config", k, v);
  const r = spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), "init", "--dir", dir], { env: { ...env0, LANES_USER: h }, encoding: "utf8" });
  if (r.status !== 0) throw new Error("init failed " + r.stdout + r.stderr);
  if (h === "ana") git(dir, "push", "-q", "origin", "HEAD:main"); else git(dir, "pull", "-q", "--rebase", "--autostash", "origin", "main");
  clone[h] = dir;
}
const port = 4800 + Math.floor(Math.random() * 150);
let server;
const startServerProc = () => { server = spawn(process.execPath, [path.join(LANES, "dist", "server.cjs")], { env: { ...env0, LANES_PORT: String(port) }, stdio: "ignore" }); };
const killServer = () => { try { server.kill(); } catch { /* gone */ } spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }); };
startServerProc();
await sleep(1500);

// --- measurements
const lat = []; // { at, event, ms }
const hook = (h, session, event, input) =>
  new Promise((resolve) => {
    const env = { ...env0, LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: h, LANES_EMAIL: `${h}@example.com` };
    const t = Date.now();
    const c = spawn(process.execPath, [path.join(clone[h], ".lanes", "hook.cjs"), event], { env, cwd: clone[h] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.resume();
    c.on("close", (code) => { lat.push({ at: Date.now() - t0, event, ms: Date.now() - t }); resolve({ code, out }); });
    c.stdin.end(JSON.stringify({ session_id: session, cwd: clone[h], ...input }));
  });
const rss = [];
const serverRss = () => {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${server.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  const m = /"([\d,.\s]+) K"/.exec(r.stdout);
  return m ? Number(m[1].replace(/[,.\s]/g, "")) / 1024 : NaN;
};
const kindsAt = [];
const sampler = setInterval(async () => {
  rss.push({ min: +mins(), mb: +serverRss().toFixed(1) });
  try {
    const snap = await (await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { authorization: `Bearer ${fs.readFileSync(path.join(home, "token"), "utf8").trim()}` } })).json();
    const kinds = {};
    for (const e of snap.events ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    kindsAt.push([+mins(), kinds]);
  } catch { /* server restarting */ }
}, 30_000);

const problems = [];
let reapplies = 0;
const expected = []; // [id, k]
let stop = false;
const agent = async (i) => {
  const h = humans[i % 2], id = `${h}${Math.floor(i / 2)}`, session = `${id}-soak`;
  await hook(h, session, "start", {});
  let k = 0;
  while (!stop) {
    await hook(h, session, "prompt", { prompt: `soak task ${id} #${Math.floor(k / 5)}` });
    for (let e = 0; e < 5 && !stop; e++, k++) {
      const rel = e % 2 ? `src/${id}_${k}.ts` : "src/shared.ts";
      const file = path.join(clone[h], rel), input = { tool_name: "Edit", tool_input: { file_path: file } };
      await sleep(THINK * (0.5 + Math.random()));
      // An agent told "that edit is not in the file now, apply it again" does so (up to 3 times), as Claude does.
      for (let attempt = 0; attempt < 4; attempt++) {
        await hook(h, session, "pre", input);
        if (rel === "src/shared.ts") { fs.appendFileSync(file, `// ${id} step ${k}\n`); if (!attempt) expected.push(`// ${id} step ${k}`); }
        else fs.writeFileSync(file, `export const ${id}_${k} = ${k};\n`);
        const post = await hook(h, session, "post", input);
        if (!/overlaps your latest edit/.test(post.out)) break;
        reapplies++;
      }
    }
    await hook(h, session, "stop", {});
  }
  await hook(h, session, "end", {});
};
// Windows refuses to rename a folder a git process has open at that instant: try again.
const move = async (a, b) => { for (let i = 0; ; i++) { try { return fs.renameSync(a, b); } catch (e) { if (i > 40) throw e; await sleep(500); } } };
const events = (async () => {
  const at = (min) => sleep(Math.max(0, t0 + min * 60000 - Date.now()));
  // a human commits (and sometimes pulls) every minute
  const humanLoop = (async () => {
    let n = 0;
    while (!stop) {
      await sleep(60_000);
      if (stop) break;
      const d = clone.ana;
      try {
        fs.writeFileSync(path.join(d, `human-${n}.txt`), `note ${n}\n`);
        git(d, "add", `human-${n}.txt`); git(d, "commit", "-qm", `human: note ${n}`);
        if (n % 3 === 2) git(d, "pull", "--rebase", "--autostash", "-q", "origin", "main");
        log("human commit", n);
      } catch (e) {
        log("human step failed (a Lanes git operation held the repository?)", String(e.stderr ?? e).split("\n")[0]);
        // a human whose pull conflicts resolves or aborts it; an abandoned rebase would stop every later publish (#100)
        try { git(d, "rebase", "--abort"); log("human aborted the rebase"); } catch { /* none in progress */ }
      }
      n++;
    }
  })();
  await at(MINUTES * 0.3);
  log("restarting the server"); killServer(); await sleep(3000); startServerProc(); log("server back");
  await at(MINUTES * 0.55);
  log("origin goes away"); await move(origin, originAway);
  await at(MINUTES * 0.7);
  await move(originAway, origin); log("origin is back");
  await humanLoop;
})();

log(`soak start: ${AGENTS} agents for ${MINUTES} min in ${root}`);
const runners = Array.from({ length: AGENTS }, (_, i) => agent(i));
await sleep(MINUTES * 60_000);
stop = true;
await Promise.all(runners);
await events;
clearInterval(sampler);
rss.push({ min: +mins(), mb: +serverRss().toFixed(1) });
// after the origin came back, a final publish round (one more turn end per agent) has run; give the last pushes a moment
await sleep(3000);
git(clone.ana, "fetch", "-q", "origin");
const shared = git(clone.ana, "show", "origin/lanes/main:src/shared.ts").split("\n");
const missing = expected.filter((l) => !shared.includes(l));
for (const l of missing.slice(0, 10)) problems.push(`missing on lanes/main: ${l}`);
if (missing.length) problems.push(`${missing.length} of ${expected.length} shared.ts lines missing on lanes/main`);
for (const h of humans) {
  const st = git(clone[h], "status", "--porcelain");
  if (st) problems.push(`${h} not clean: ${st.slice(0, 120)}`);
}
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN;
console.log("\n=== hook latency by 5-minute window (ms) ===");
for (let w = 0; w * 5 < MINUTES + 5; w++) {
  const inW = lat.filter((l) => l.at >= w * 300_000 && l.at < (w + 1) * 300_000);
  if (!inW.length) continue;
  const f = (ev) => { const a = inW.filter((l) => l.event === ev).map((l) => l.ms); return a.length ? `${ev} n=${a.length} p50=${pct(a, 0.5)} p95=${pct(a, 0.95)} max=${Math.max(...a)}` : ""; };
  console.log(`min ${w * 5}-${w * 5 + 5}: ${["pre", "post", "prompt", "stop"].map(f).filter(Boolean).join(" | ")}`);
}
console.log("\n=== server RSS (MB) ===");
console.log(rss.map((r) => `${r.min}m:${r.mb}`).join("  "));
console.log(`\nedits expected ${expected.length}; lanes/main shared.ts lines ${shared.filter(Boolean).length - 1}; hook calls ${lat.length}`);
const snap = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { authorization: `Bearer ${fs.readFileSync(path.join(home, "token"), "utf8").trim()}` } }).then((r) => r.json()).catch(() => null);
if (snap) { const kinds = {}; for (const e of snap.events ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1; console.log("server events", JSON.stringify(kinds), "agents", snap.agents.length, "leases", snap.leases.length); }
killServer();
for (const p of problems) console.log("PROBLEM:", p);
console.log(problems.length ? `FAILED (${problems.length})` : "ALL OK");
if (!problems.length && !process.env.SOAK_KEEP) fs.rmSync(root, { recursive: true, force: true }); else console.log("kept", root);
process.exit(problems.length ? 1 : 0);
