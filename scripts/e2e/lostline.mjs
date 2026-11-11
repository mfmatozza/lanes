// Deterministic hook-event driver, no LLM: N agents (2 per human clone) each add lines to one shared file through the
// real bundled hook (pre -> the edit -> post), interleaved with random delays. Verifies no line is lost on lanes/main.
// Usage: npm run build && node scripts/e2e/lostline.mjs [--agents 4] [--edits 12] [--runs 1] [--seed 1] [--human]
//   --human: a human commits and pulls --rebase in ana's clone while the agents work.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LANES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const num = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
const AGENTS = num("--agents", 4), EDITS = num("--edits", 12), RUNS = num("--runs", 1);
let seed = num("--seed", 1);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();

async function oneRun(n) {
  const root = fs.mkdtempSync(path.join((process.env.LANES_TMP ?? "C:/lanes-tmp"), "lanes-lostline-"));
  const problems = [];
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seedDir = path.join(root, "seed");
  git(root, "clone", "-q", origin, seedDir);
  for (const [k, v] of [["user.name", "Seed"], ["user.email", "seed@example.com"], ["core.autocrlf", "false"]]) git(seedDir, "config", k, v);
  fs.mkdirSync(path.join(seedDir, "src"));
  fs.writeFileSync(path.join(seedDir, "src", "shared.ts"), "export const shared: string[] = [];\n");
  git(seedDir, "add", "-A");
  git(seedDir, "commit", "-qm", "seed");
  git(seedDir, "push", "-q", "origin", "main");
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
    if (r.status !== 0) throw new Error("init failed: " + r.stdout + r.stderr);
    if (h === "ana") git(dir, "push", "-q", "origin", "HEAD:main");
    else git(dir, "pull", "-q", "--rebase", "--autostash", "origin", "main");
    clone[h] = dir;
    if (argv.includes("--trace")) console.log(`after init ${h}: status=${JSON.stringify(git(dir, "status", "--porcelain"))} diff=${JSON.stringify(git(dir, "diff").slice(0, 300))}`);
  }
  const port = 4300 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [path.join(LANES, "dist", "server.cjs")], { env: { ...env0, LANES_PORT: String(port) }, stdio: "ignore" });
  await sleep(1500);
  const hook = (h, session, event, input) =>
    new Promise((resolve) => {
      const env = { ...env0, LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: h, LANES_EMAIL: `${h}@example.com` };
      const c = spawn(process.execPath, [path.join(clone[h], ".lanes", "hook.cjs"), event], { env, cwd: clone[h] });
      let out = "", err = "";
      const t0 = Date.now();
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => {
        if (argv.includes("--trace")) console.log(`${new Date(t0).toISOString().slice(14, 23)}..${new Date().toISOString().slice(14, 23)} ${session.slice(0, 5)} ${event} ${input.tool_input?.file_path?.split(/[\/]/).pop() ?? ""} exit=${code} ${out.slice(0, 90)} ${err.slice(0, 120)}`);
        resolve({ code, out });
      });
      c.stdin.end(JSON.stringify({ session_id: session, cwd: clone[h], ...input }));
    });
  const agent = async (i) => {
    const h = humans[i % 2], id = `${h}${Math.floor(i / 2)}`, session = `${id}-session-${n}`;
    await hook(h, session, "start", {});
    await hook(h, session, "prompt", { prompt: `agent ${id} adds lines` });
    for (let k = 0; k < EDITS; k++) {
      const edits = [["src/shared.ts", (f) => fs.appendFileSync(f, `// ${id} step ${k}\n`)], [`src/${id}_${k}.ts`, (f) => fs.writeFileSync(f, `export const ${id}_${k} = ${k};\n`)]];
      for (const [rel, apply] of edits) {
        const file = path.join(clone[h], rel), input = { tool_name: "Edit", tool_input: { file_path: file } };
        await sleep(rnd() * 300);
        if (argv.includes("--trace")) console.log(`  ${id} before pre ${rel}: status=${JSON.stringify(git(clone[h], "status", "--porcelain"))}`);
        const pre = await hook(h, session, "pre", input);
        // Claude Code reads the file and rewrites it in one tool step, after the pre hook: re-read the file here.
        apply(file);
        await sleep(rnd() * 100);
        const post = await hook(h, session, "post", input);
        if (pre.code || post.code) problems.push(`${id} ${rel}: hook exit ${pre.code}/${post.code}`);
        if (/"deny"|"block"/.test(pre.out)) problems.push(`${id}: refused an edit`);
        for (const o of [pre.out, post.out]) if (/newer content|new content/.test(o)) (agent.notes ??= []).push(`${id} ${rel} k=${k}: ${o.slice(0, 160)}`);
      }
    }
    await hook(h, session, "stop", {});
    await hook(h, session, "end", {});
  };
  const human = argv.includes("--human") && (async () => {
    await sleep(8000);
    const d = clone.ana;
    fs.writeFileSync(path.join(d, "human-notes.txt"), "own note\n");
    // A human whose commit meets Lanes' index.lock just runs it again.
    for (let i = 0; i < 20; i++) {
      try { git(d, "add", "human-notes.txt"); git(d, "commit", "-qm", "human: notes"); break; } catch { await sleep(200); }
    }
    await sleep(4000);
    try { git(d, "pull", "--rebase", "--autostash", "-q", "origin", "main"); } catch { /* reported by the checks below */ }
  })();
  await Promise.all([...Array.from({ length: AGENTS }, (_, i) => agent(i)), human]);
  git(clone.ana, "fetch", "-q", "origin");
  const shared = git(clone.ana, "show", "origin/lanes/main:src/shared.ts").split("\n");
  const tree = git(clone.ana, "ls-tree", "-r", "--name-only", "origin/lanes/main").split("\n");
  for (let i = 0; i < AGENTS; i++) {
    const id = `${humans[i % 2]}${Math.floor(i / 2)}`;
    for (let k = 0; k < EDITS; k++) {
      if (!shared.includes(`// ${id} step ${k}`)) problems.push(`LOST LINE on lanes/main: "// ${id} step ${k}"`);
      if (!tree.includes(`src/${id}_${k}.ts`)) problems.push(`missing src/${id}_${k}.ts`);
    }
  }
  const dup = shared.filter((l, i) => l && shared.indexOf(l) !== i);
  if (dup.length) problems.push(`duplicated lines: ${dup.slice(0, 3)}`);
  for (const h of humans) {
    const st = git(clone[h], "status", "--porcelain");
    if (st) problems.push(`${h} clone not clean: ${st.slice(0, 200)}`);
    const local = fs.readFileSync(path.join(clone[h], "src", "shared.ts"), "utf8").split("\n");
    if (local.some((l) => /^(<<<<<<<|>>>>>>>|=======)/.test(l))) problems.push(`${h}: conflict markers in shared.ts`);
  }
  try {
    const snap = await (await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { authorization: `Bearer ${fs.readFileSync(path.join(home, "token"), "utf8").trim()}` } })).json();
    const kinds = {};
    for (const e of snap.events ?? []) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    console.log("server events", JSON.stringify(kinds));
    for (const e of snap.events ?? []) if (e.kind !== "synced" && e.kind !== "pulled") console.log("  event", JSON.stringify(e).slice(0, 400));
  } catch { /* server gone */ }
  console.log(`run ${n}: ${problems.length ? "FAILED" : "ok"} (shared.ts ${shared.length - 1} lines, ${(agent.notes ?? []).length} 'newer content' notes) ${root}`);
  for (const p of problems) console.log("  PROBLEM:", p);
  for (const p of (agent.notes ?? []).slice(0, 5)) console.log("  note:", p);
  server.kill();
  spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  if (!problems.length) fs.rmSync(root, { recursive: true, force: true });
  return problems.length;
}

let failed = 0;
for (let n = 1; n <= RUNS; n++) failed += (await oneRun(n)) ? 1 : 0;
console.log(failed ? `${failed}/${RUNS} runs FAILED` : `all ${RUNS} runs ok`);
process.exit(failed ? 1 : 0);
