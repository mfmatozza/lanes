// Scale test (#261), no LLM: N agents of four kinds (Claude, Codex, Gemini, Cursor event shapes, invoked with `--lanes <agent>`
// as the installed hooks are) spread over K teammates (each a clone of R bare origins, own LANES_HOME, own personal token from
// invite/join) edit hot and cold files with team context on, while teammates chat with @mentions, ask/approve requests, and V
// WebSocket viewers (browser app + VS Code) and P /v1/state pollers watch. Everything in a temp folder; LANES_AUTOSTART=0.
// Measures hook latency per event, server RSS, snapshot and stream bytes, brief size, lost lines, unpublished work, refusals.
// Usage: npm run build && node scripts/e2e/scale.mjs [--agents 8] [--teammates K] [--repos 1] [--minutes 1] [--viewers 10]
//          [--pollers 2] [--think 3000] [--source]   (--source: server and hook from packages/*/src/*.ts instead of dist/*.cjs)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectEvents } from "../../packages/core/src/ws.ts";

const LANES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const num = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const AGENTS = num("--agents", 8), TEAMMATES = num("--teammates", Math.max(2, Math.ceil(AGENTS / 4))), REPOS = num("--repos", 1);
const MINUTES = num("--minutes", 1), VIEWERS = num("--viewers", 10), POLLERS = num("--pollers", 2), THINK = num("--think", 3000);
const SOURCE = argv.includes("--source");
const KINDS = ["claude", "codex", "gemini", "cursor"];
const EDITS_PER_TURN = 4, RSS_LIMIT_MB = 2048;
let seed = num("--seed", 1);
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s]`, ...m);
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);

const root = fs.mkdtempSync(path.join(process.env.LANES_TMP ?? os.tmpdir(), "lanes-scale-"));
// The caller's own Lanes and Claude settings never leak in: every LANES_* is set here or not at all.
const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^LANES_|^CLAUDE_?CODE/i.test(k)));
env0.LANES_AUTOSTART = "0";
const serverHome = path.join(root, "server-home");
fs.mkdirSync(serverHome);
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const serverLog = path.join(root, "server.jsonl");
const cli = (home, args) => spawnSync(process.execPath, [path.join(LANES, "dist", "lanes.cjs"), ...args], { env: { ...env0, LANES_HOME: home }, encoding: "utf8" });

// --- repositories: a bare origin each, seeded with two hot files and team context on (.lanes/team.json)
const teammates = Array.from({ length: TEAMMATES }, (_, i) => ({ name: `tm${i}`, home: path.join(root, `home-tm${i}`), clones: [] }));
for (let r = 0; r < REPOS; r++) {
  const origin = path.join(root, `repo${r}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seedDir = path.join(root, `seed${r}`);
  git(root, "clone", "-q", origin, seedDir);
  for (const [k, v] of [["user.name", "Seed"], ["user.email", "seed@example.com"], ["core.autocrlf", "false"]]) git(seedDir, "config", k, v);
  fs.mkdirSync(path.join(seedDir, "src"));
  fs.mkdirSync(path.join(seedDir, ".lanes"));
  for (const h of ["hot0", "hot1"]) fs.writeFileSync(path.join(seedDir, "src", `${h}.ts`), `export const ${h}_r${r}: string[] = [];\n`);
  fs.writeFileSync(path.join(seedDir, ".lanes", "team.json"), JSON.stringify({ context: true }) + "\n");
  git(seedDir, "add", "-A");
  git(seedDir, "commit", "-qm", "seed");
  git(seedDir, "push", "-q", "origin", "main");
  for (const [i, tm] of teammates.entries()) {
    fs.mkdirSync(tm.home, { recursive: true });
    const dir = path.join(root, `tm${i}-repo${r}`);
    git(root, "clone", "-q", "-c", "core.autocrlf=false", origin, dir);
    for (const [k, v] of [["user.name", tm.name], ["user.email", `${tm.name}@example.com`], ["core.autocrlf", "false"]]) git(dir, "config", k, v);
    const res = cli(tm.home, ["init", "--dir", dir, "--agents", KINDS.join(","), "--server", base, "--user", tm.name]);
    if (res.status !== 0) throw new Error("init failed " + res.stdout + res.stderr);
    if (i === 0) git(dir, "push", "-q", "origin", "HEAD:main");
    else git(dir, "pull", "-q", "--rebase", "--autostash", "origin", "main");
    tm.clones.push(dir);
  }
}

// --- server
let server;
const killServer = () => {
  if (!server) return;
  spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  try { server.kill(); } catch { /* gone */ }
};
process.on("exit", killServer);
process.on("SIGINT", () => process.exit(130));
const serverMain = SOURCE ? path.join(LANES, "packages", "server", "src", "main.ts") : path.join(LANES, "dist", "server.cjs");
server = spawn(process.execPath, ["--no-warnings", serverMain], { env: { ...env0, LANES_HOME: serverHome, LANES_PORT: String(port), LANES_LOG: serverLog }, stdio: "ignore" });
for (let i = 0; ; i++) {
  if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
  if (i > 100) throw new Error("server did not start");
  await sleep(100);
}
const adminToken = fs.readFileSync(path.join(serverHome, "token"), "utf8").trim();
const timings = {}; // route -> ms[]
const errors = [];
const call = async (route, token, body) => {
  const t = performance.now();
  const res = await fetch(base + route, body === undefined ? { headers: { authorization: `Bearer ${token}` } } : { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await res.text();
  (timings[route] ??= []).push(performance.now() - t);
  if (!res.ok) throw Object.assign(new Error(`${route} ${res.status} ${text.slice(0, 120)}`), { status: res.status });
  return { json: JSON.parse(text), bytes: Buffer.byteLength(text) };
};

// --- members: a personal token per teammate (invite on the server's machine, join on the teammate's)
for (const tm of teammates) {
  tm.token = (await call("/v1/members/invite", adminToken, { name: tm.name })).json.token;
  const res = cli(tm.home, ["join", base, tm.token]);
  if (res.status !== 0 || !/Joined/.test(res.stdout)) throw new Error(`join failed for ${tm.name}: ${res.stdout}${res.stderr}`);
}
log(`setup done: ${REPOS} repos x ${TEAMMATES} teammates, server ${SOURCE ? "source" : "bundled"} on ${port}, ${root}`);

// --- hooks
const lat = []; // { event, kind, ms }
const outputs = { deny: [], stopBlocks: 0, failOpen: 0, nonZero: 0, notes: 0, briefs: [], headsUps: [] };
const hookScript = (clone) => (SOURCE ? path.join(LANES, "packages", "hook", "src", "hook.ts") : path.join(clone, ".lanes", "hook.cjs"));
const hook = (a, event, input) =>
  new Promise((resolve) => {
    const args = ["--no-warnings", hookScript(a.clone), event, "--lanes", ...(a.kind === "gemini" || a.kind === "cursor" ? [a.kind] : [])];
    const payload = a.kind === "cursor" ? { conversation_id: a.session, workspace_roots: [a.clone], cursor_version: "1.7.0", ...input } : { session_id: a.session, cwd: a.clone, ...input };
    const t = performance.now();
    const c = spawn(process.execPath, args, { env: { ...env0, LANES_HOME: a.tm.home }, cwd: a.clone });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => {
      lat.push({ event, kind: a.kind, ms: performance.now() - t });
      if (code) outputs.nonZero++;
      if (/coordination paused/.test(err)) { outputs.failOpen++; errors.push(`${a.id} ${event}: ${err.trim().slice(0, 160)}`); }
      // Never a refusal (ADR-0019): no permission decision, no deny, no continue:false. A Stop block is the one designed
      // exception (Claude/Codex: "re-apply your overlapped edit"), counted apart.
      if (/permissionDecision|"permission"\s*:\s*"deny"|"decision"\s*:\s*"deny"|"continue"\s*:\s*false/.test(out) || (/"decision"\s*:\s*"block"/.test(out) && event !== "stop")) outputs.deny.push(`${a.id} ${event}: ${out.slice(0, 200)}`);
      if (/"decision"\s*:\s*"block"/.test(out) && event === "stop") outputs.stopBlocks++;
      if (/additionalContext|additional_context/.test(out)) outputs.notes++;
      const ctx = /Lanes team context\.[^"]*/.exec(out)?.[0];
      if (ctx) outputs.briefs.push(ctx.length);
      const note = /Team note about[^"]*/.exec(out)?.[0];
      if (note) outputs.headsUps.push(note.length);
      resolve({ code, out });
    });
    c.stdin.end(JSON.stringify(payload));
  });

// An edit as each agent's tool reports it. Hot files are appended to (one line), cold files rewritten whole.
const editInput = (a, rel, hot, lastLine) => {
  const abs = path.join(a.clone, rel);
  if (a.kind === "cursor") return { file_path: abs };
  if (a.kind === "codex") return { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** ${hot ? "Update" : "Add"} File: ${rel}\n@@\n+x\n*** End Patch` } };
  if (a.kind === "gemini") return hot ? { tool_name: "replace", tool_input: { file_path: abs, old_string: lastLine } } : { tool_name: "write_file", tool_input: { file_path: abs } };
  return hot ? { tool_name: "Edit", tool_input: { file_path: abs, old_string: lastLine } } : { tool_name: "Write", tool_input: { file_path: abs } };
};
const expected = []; // { repo, file, line, kind, id }
const coldLast = new Map(); // "r|rel" -> { content, clone }
let reapplies = 0;
let stop = false;
const agents = Array.from({ length: AGENTS }, (_, i) => {
  const tm = teammates[i % TEAMMATES], r = Math.floor(i / TEAMMATES) % REPOS, kind = KINDS[i % KINDS.length];
  const id = `${tm.name}-${kind}${i}`;
  return { i, tm, r, kind, id, session: `${id}-scale`, clone: tm.clones[r], turnLines: [] };
});
const hasLine = (file, line) => { try { return fs.readFileSync(file, "utf8").split("\n").includes(line); } catch { return false; } };
const lastLineOf = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).pop() ?? "";
const editOnce = async (a, rel, hot, line, content) => {
  const file = path.join(a.clone, rel);
  if (hot) fs.mkdirSync(path.dirname(file), { recursive: true });
  // An agent told its edit is not in the file now applies it again (up to 3 times), as the soak's agents do. Cursor never hears it.
  for (let attempt = 0; attempt < 4; attempt++) {
    const input = editInput(a, rel, hot, hot ? lastLineOf(file) : undefined);
    if (a.kind !== "cursor") await hook(a, "pre", input);
    if (hot) { if (!hasLine(file, line)) fs.appendFileSync(file, line + "\n"); }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
    const post = await hook(a, "post", input);
    if (!/overlaps your latest edit/.test(post.out) || (hot && hasLine(file, line))) break;
    reapplies++;
  }
};
const runAgent = async (a) => {
  await sleep(rnd() * THINK);
  await hook(a, "start", {});
  let k = 0, turn = 0;
  while (!stop) {
    await hook(a, "prompt", { prompt: `scale task ${a.id} #${turn++}: touch src/hot0.ts` });
    a.turnLines = [];
    for (let e = 0; e < EDITS_PER_TURN && !stop; e++, k++) {
      await sleep(THINK * (0.5 + rnd()));
      if (e % 2 === 0) {
        const rel = `src/hot${rnd() < 0.7 ? 0 : 1}.ts`, line = `// ${a.id} step ${k}`;
        expected.push({ repo: a.r, file: rel, line, kind: a.kind, id: a.id, clone: a.clone });
        a.turnLines.push([rel, line]);
        await editOnce(a, rel, true, line);
      } else {
        const rel = `src/${a.id}/f${k % 6}.ts`, content = `export const v = ${k};\n`;
        coldLast.set(`${a.r}|${rel}`, { content, clone: a.clone });
        await editOnce(a, rel, false, undefined, content);
      }
    }
    let s = await hook(a, "stop", {});
    if (/"decision"\s*:\s*"block"/.test(s.out)) {
      // Claude continues the turn once to re-apply what was overlapped, then stops with stop_hook_active.
      for (const [rel, line] of a.turnLines) if (!hasLine(path.join(a.clone, rel), line)) await editOnce(a, rel, true, line);
      s = await hook(a, "stop", { stop_hook_active: true });
    }
  }
  await hook(a, "end", {});
};

// --- teammates: chat with @mentions, ask each other, approve what is addressed to them
const team = { said: 0, asked: 0, approved: 0, refused: [] };
const asked = new Set();
const runTeammate = async (tm) => {
  const repoIds = [];
  while (!stop) {
    await sleep(5_000 + rnd() * 10_000);
    if (stop) break;
    // the repository id the hooks use: read once from the server's agents list
    if (!repoIds.length) { try { for (const ag of (await call("/v1/state", tm.token)).json.agents) if (!repoIds.includes(ag.repo)) repoIds.push(ag.repo); } catch { /* next round */ } if (!repoIds.length) continue; }
    const repo = pick(repoIds), other = pick(teammates.filter((t) => t !== tm));
    const body = { sessionId: `${tm.name}-cli`, repo };
    try {
      await call("/v1/team/say", tm.token, { ...body, text: `${rnd() < 0.2 ? "@team" : "@" + other.name} heads up: I am changing hot0 (${team.said})` });
      team.said++;
      if (rnd() < 0.4) { const r = (await call("/v1/team/ask", tm.token, { ...body, to: other.name, text: `please check hot1 for ${tm.name}`, scope: "read" })).json; asked.add(r.id); team.asked++; }
      for (const rq of (await call("/v1/team/requests", tm.token, body)).json.requests) {
        if (rq.status === "pending" && rq.to === tm.name) { await call("/v1/team/decide", tm.token, { ...body, id: rq.id, decision: "approve" }); team.approved++; }
      }
    } catch (err) { team.refused.push(String(err.message).slice(0, 160)); }
  }
};

// --- viewers: half the browser app (token in the query, Origin), half VS Code (a teammate's token in a header).
// Refused (stream limit) ones fall back to polling /v1/state every 5 s, as both clients do.
const viewers = [];
const openViewer = (v) => {
  const tm = teammates[v % TEAMMATES];
  const app = v % 2 === 0;
  const s = { kind: app ? "app" : "vscode", bytes: 0, frames: 0, maxFrame: 0, refused: false, closed: "", polls: 0, pollBytes: 0, openedAt: Date.now() };
  viewers.push(s);
  s.client = connectEvents(app ? `ws://127.0.0.1:${port}/v1/events?token=${adminToken}` : `ws://127.0.0.1:${port}/v1/events`, app ? { origin: base } : { authorization: `Bearer ${tm.token}` }, {
    onMessage: (text) => { const n = Buffer.byteLength(text); s.bytes += n; s.frames++; s.maxFrame = Math.max(s.maxFrame, n); },
    onClose: (reason) => {
      s.closed = reason;
      if (/503/.test(reason)) s.refused = true;
      if (stop) return;
      s.timer = setInterval(async () => { if (stop) return clearInterval(s.timer); try { const r = await call("/v1/state", app ? adminToken : tm.token); s.polls++; s.pollBytes += r.bytes; } catch (err) { errors.push("poll " + err.message); } }, 5_000);
    },
  }, 60_000);
};
for (let v = 0; v < VIEWERS; v++) openViewer(v);

// --- server samples: RSS (tasklist) and snapshot size every 5 s; extra /v1/state pollers like the app's fallback
const serverRss = () => {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${server.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  const m = /"([\d,.\s]+) K"/.exec(r.stdout);
  return m ? Number(m[1].replace(/[,.\s]/g, "")) / 1024 : NaN;
};
const samples = []; // { s, rssMb, snapBytes, agents, tasks }
let aborted = "";
const sampler = setInterval(async () => {
  const rssMb = +serverRss().toFixed(1);
  try {
    const { json, bytes } = await call("/v1/state", adminToken);
    samples.push({ s: Math.round((Date.now() - t0) / 1000), rssMb, snapBytes: bytes, agents: json.agents.length, tasks: json.tasks.length, leases: json.leases.length });
  } catch (err) { errors.push("sample " + err.message); }
  if (rssMb > RSS_LIMIT_MB) { aborted = `server RSS ${rssMb} MB over ${RSS_LIMIT_MB} MB`; stop = true; }
}, 5_000);
const pollers = Array.from({ length: POLLERS }, () => setInterval(() => call("/v1/state", adminToken).catch((err) => errors.push("poller " + err.message)), 5_000));

const startedAt = Date.now();
log(`run: ${AGENTS} agents (${KINDS.map((k) => `${agents.filter((a) => a.kind === k).length} ${k}`).join(", ")}), ${VIEWERS} viewers, ${POLLERS} pollers, ${MINUTES} min`);
const runners = [...agents.map(runAgent), ...teammates.map(runTeammate)];
const deadline = setTimeout(() => (stop = true), MINUTES * 60_000);
while (!stop) await sleep(500);
clearTimeout(deadline);
await Promise.all(runners);
const runSecs = (Date.now() - startedAt) / 1000;
clearInterval(sampler);
for (const p of pollers) clearInterval(p);
await sleep(3000);
for (const v of viewers) { v.client?.close(); clearInterval(v.timer); }
const rssEnd = +serverRss().toFixed(1);

// --- checks: lost lines, cold files, unpublished work
const problems = [];
if (aborted) problems.push("ABORTED: " + aborted);
// Missing from lanes/main: "unpublished" if the author's clone still has it committed (safe, the next publish there pushes
// it), "lost" if not even that.
const lost = [], stuck = [];
const show = (clone, rev, rel) => { try { return git(clone, "show", `${rev}:${rel}`) + "\n"; } catch { return null; } };
for (let r = 0; r < REPOS; r++) {
  const c = teammates[0].clones[r];
  git(c, "fetch", "-q", "origin");
  const files = {};
  for (const h of ["src/hot0.ts", "src/hot1.ts"]) files[h] = git(c, "show", `origin/lanes/main:${h}`).split("\n");
  for (const e of expected.filter((x) => x.repo === r)) {
    if (files[e.file].includes(e.line)) continue;
    if (show(e.clone, "HEAD", e.file)?.split("\n").includes(e.line)) stuck.push(e);
    // Only in a re-apply backup ref (refs/lanes/backup/*): kept, but off the branch until the agent re-applies it.
    else lost.push({ ...e, backup: git(e.clone, "log", "--all", "--format=%h", "-S", e.line, "--", e.file) !== "" });
  }
  const dup = Object.values(files).flatMap((ls) => ls.filter((l, i) => l && ls.indexOf(l) !== i));
  if (dup.length) problems.push(`repo${r}: ${dup.length} duplicated lines, e.g. ${dup[0]}`);
  if (Object.values(files).some((ls) => ls.some((l) => /^(<<<<<<<|>>>>>>>|=======)/.test(l)))) problems.push(`repo${r}: conflict markers on lanes/main`);
  for (const [key, { content, clone }] of coldLast) {
    const [rr, rel] = key.split("|");
    if (Number(rr) !== r) continue;
    const got = show(c, "origin/lanes/main", rel);
    if (got === content) continue;
    if (show(clone, "HEAD", rel) === content) stuck.push({ kind: "cold", repo: r, file: rel, line: content.trim() });
    else problems.push(`LOST WRITE repo${r}: ${rel} on lanes/main is ${got === null ? "missing" : JSON.stringify(got)}, in its clone too, instead of ${JSON.stringify(content)}`);
  }
}
for (const l of lost) problems.push(`LOST LINE (${l.kind}${l.backup ? ", only in a re-apply backup commit" : ", in no commit"}) repo${l.repo} ${l.file}: ${l.line}`);
for (const l of stuck) problems.push(`UNPUBLISHED (${l.kind}, committed in its clone) repo${l.repo} ${l.file}: ${l.line}`);
let unpublished = 0, unpublishedCommits = 0;
for (const tm of teammates) for (const c of tm.clones) {
  const st = git(c, "status", "--porcelain");
  if (st) { unpublished++; problems.push(`${path.basename(c)} not clean: ${st.slice(0, 160)}`); }
  git(c, "fetch", "-q", "origin");
  unpublishedCommits += Number(git(c, "rev-list", "--count", "HEAD", "--not", "origin/lanes/main", "origin/main"));
}
// What the hooks reported (publish failures and the like), from the server log.
const observed = {};
for (const line of fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8").split("\n") : []) {
  const kind = line.includes('"type":"observe"') ? /"kind":"([^"]+)"/.exec(line)?.[1] : undefined;
  if (kind) observed[kind] = (observed[kind] ?? 0) + 1;
}
for (const d of outputs.deny) problems.push("REFUSAL: " + d);
const finalSnap = await call("/v1/state", adminToken).catch(() => null);
// Bytes per top-level snapshot field at the end, to see what a snapshot is made of.
const snapParts = finalSnap ? Object.fromEntries(Object.entries(finalSnap.json).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v))])) : {};
const openRequests = finalSnap ?finalSnap.json.team.requests.filter((r) => asked.has(r.id)) : [];
killServer();
server = undefined;

// --- server-side latency from its log (never holds chat text)
const srv = {};
const briefChars = [], headsUpChars = [];
for (const line of fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8").split("\n") : []) {
  if (!line) continue;
  const e = JSON.parse(line);
  if (typeof e.ms !== "number") continue;
  const type = e.type === "team-context" ? (e.path ? "team-context(path)" : "team-context(brief)") : e.type;
  (srv[type] ??= []).push(e.ms);
  if (e.type === "team-context" && e.chars) (e.path ? headsUpChars : briefChars).push(e.chars);
}

const events = ["start", "prompt", "pre", "post", "stop", "end"];
const hookStats = Object.fromEntries(events.map((ev) => { const a = lat.filter((l) => l.event === ev).map((l) => l.ms); return [ev, { n: a.length, p50: +pct(a, 0.5).toFixed(0), p95: +pct(a, 0.95).toFixed(0), p99: +pct(a, 0.99).toFixed(0), max: a.length ? +Math.max(...a).toFixed(0) : NaN }]; }));
const srvStats = Object.fromEntries(Object.entries(srv).map(([k, a]) => [k, { n: a.length, p50: +pct(a, 0.5).toFixed(2), p95: +pct(a, 0.95).toFixed(2), p99: +pct(a, 0.99).toFixed(2), max: +Math.max(...a).toFixed(2) }]));
const live = viewers.filter((v) => !v.refused);
const result = {
  setup: { agents: AGENTS, teammates: TEAMMATES, repos: REPOS, minutes: MINUTES, viewers: VIEWERS, pollers: POLLERS, think: THINK, build: SOURCE ? "source" : "bundled", node: process.version, cpus: os.cpus().length },
  runSecs: +runSecs.toFixed(0),
  hook: hookStats,
  server: srvStats,
  rss: { start: samples[0]?.rssMb, max: Math.max(...samples.map((s) => s.rssMb)), end: rssEnd },
  snapshot: { maxBytes: Math.max(...samples.map((s) => s.snapBytes)), lastBytes: samples.at(-1)?.snapBytes, maxTasks: Math.max(...samples.map((s) => s.tasks)), finalParts: snapParts },
  streams: { live: live.length, refused: viewers.length - live.length, bytesPerSecPerClient: +(live.reduce((n, v) => n + v.bytes, 0) / Math.max(live.length, 1) / runSecs).toFixed(0), framesPerSecPerClient: +(live.reduce((n, v) => n + v.frames, 0) / Math.max(live.length, 1) / runSecs).toFixed(1), maxFrame: Math.max(0, ...live.map((v) => v.maxFrame)), pollingFallbacks: viewers.filter((v) => v.polls > 0).length },
  brief: { n: briefChars.length, p50: pct(briefChars, 0.5), max: briefChars.length ? Math.max(...briefChars) : 0, printed: outputs.briefs.length, printedMax: Math.max(0, ...outputs.briefs) },
  headsUp: { n: headsUpChars.length, max: headsUpChars.length ? Math.max(...headsUpChars) : 0 },
  team: { ...team, refused: team.refused.length, refusedSample: team.refused.slice(0, 3), delivered: openRequests.filter((r) => r.status === "delivered").length, stillApproved: openRequests.filter((r) => r.status === "approved").length },
  edits: { hotLines: expected.length, cold: coldLast.size, reapplies, stopBlocks: outputs.stopBlocks, notes: outputs.notes },
  lostLines: lost.length,
  lostByKind: Object.fromEntries(KINDS.map((k) => [k, lost.filter((l) => l.kind === k).length])),
  unpublishedClones: unpublished,
  unpublishedEdits: stuck.length,
  unpublishedByKind: Object.fromEntries([...KINDS, "cold"].map((k) => [k, stuck.filter((l) => l.kind === k).length])),
  unpublishedCommits,
  observed,
  refusals: outputs.deny.length,
  hookNonZeroExit: outputs.nonZero,
  failOpen: outputs.failOpen,
  errors: errors.slice(0, 20),
  errorCount: errors.length,
  rssSamples: samples,
  problems,
};
const outDir = path.join(process.env.LANES_TMP ?? os.tmpdir(), "lanes-scale-results");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `scale-n${AGENTS}-v${VIEWERS}-${SOURCE ? "src" : "dist"}-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

console.log(`\n=== ${AGENTS} agents, ${TEAMMATES} teammates, ${REPOS} repos, ${VIEWERS} viewers, ${result.setup.build}, ${result.runSecs} s ===`);
console.log("hook ms      " + events.map((ev) => `${ev} n=${hookStats[ev].n} p50=${hookStats[ev].p50} p95=${hookStats[ev].p95} p99=${hookStats[ev].p99}`).join(" | "));
console.log("server ms    " + Object.entries(srvStats).map(([k, s]) => `${k} p50=${s.p50} p99=${s.p99}`).join(" | "));
console.log(`server RSS   start ${result.rss.start} MB, max ${result.rss.max} MB, end ${result.rss.end} MB`);
console.log(`snapshot     max ${result.snapshot.maxBytes} B (${result.snapshot.maxTasks} tasks); streams live ${result.streams.live}, refused ${result.streams.refused}, ${result.streams.bytesPerSecPerClient} B/s and ${result.streams.framesPerSecPerClient} frames/s per client, max frame ${result.streams.maxFrame} B`);
console.log(`snap parts   ${JSON.stringify(snapParts)}`);
console.log(`brief        served p50 ${result.brief.p50} max ${result.brief.max} chars (n=${result.brief.n}); heads-up max ${result.headsUp.max}`);
console.log(`team         said ${team.said}, asked ${team.asked}, approved ${team.approved}, delivered ${result.team.delivered}, refused calls ${team.refused.length}`);
console.log(`edits        hot lines ${expected.length}, cold files ${coldLast.size}, re-applies ${reapplies}, stop blocks ${outputs.stopBlocks}`);
console.log(`hooks saw    ${JSON.stringify(observed)}`);
console.log(`unpublished  ${stuck.length} edits committed in their clone only ${JSON.stringify(result.unpublishedByKind)}; ${unpublishedCommits} local commits not on lanes/main`);
console.log(`lost lines   ${lost.length} ${JSON.stringify(result.lostByKind)}; unpublished clones ${unpublished}; refusals ${outputs.deny.length}; fail-open ${outputs.failOpen}; errors ${errors.length}`);
for (const p of problems.slice(0, 30)) console.log("PROBLEM:", p);
for (const e of errors.slice(0, 5)) console.log("error:", e);
console.log(`results ${outFile}`);
console.log(problems.length ? `FAILED (${problems.length})` : "ALL OK");
if (!problems.length && !process.env.SCALE_KEEP) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); else console.log("kept", root);
process.exit(problems.length ? 1 : 0);
