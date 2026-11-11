// Hook latency benchmark (requirement N1): `npm run build && npm run bench [runs]`.
// Builds a throwaway clone with a local bare origin and a real `lanes init`, then runs the bundled dist/hook.cjs the way
// Claude Code does (one process per event, hook JSON on stdin) and reports wall-clock p50/p95/max per event, with a warm
// and a cold repository-identity cache. A local origin means no network time: with a real remote the fetch (and, for
// `post`, the push) adds one round trip each. Also counts `git` launches per event (GIT_TRACE2_EVENT).
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const runs = Number(process.argv[2] ?? 50);
const dist = path.resolve(import.meta.dirname, "..", "dist");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-bench-"));
const home = path.join(base, "home");
const origin = path.join(base, "origin.git");
const repo = path.join(base, "ana");
const trace = path.join(base, "trace.json");
fs.mkdirSync(home);

const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const env: NodeJS.ProcessEnv = { ...process.env, LANES_HOME: home, LANES_SERVER: `http://127.0.0.1:${port}`, LANES_USER: "bench", LANES_EMAIL: "bench@example.com", LANES_IDLE_EXIT_MS: "5000", GIT_AUTHOR_NAME: "Bench", GIT_AUTHOR_EMAIL: "bench@example.com", GIT_COMMITTER_NAME: "Bench", GIT_COMMITTER_EMAIL: "bench@example.com" };
for (const k of ["LANES_REMOTE", "LANES_TOKEN", "LANES_AUTOSTART"]) delete env[k];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Bench", "-c", "user.email=bench@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A repository of a realistic size for the prediction step: 300 small files.
git(base, "init", "-q", "--bare", "-b", "main", origin);
git(base, "clone", "-q", origin, repo);
for (let i = 0; i < 300; i++) {
  fs.mkdirSync(path.join(repo, "src", `m${i % 20}`), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", `m${i % 20}`, `file${i}.js`), `export const v${i} = ${i};\n`);
}
git(repo, "add", "-A");
git(repo, "commit", "-qm", "seed");
git(repo, "push", "-q", "origin", "main");
execFileSync(process.execPath, ["--no-warnings", path.join(dist, "lanes.cjs"), "init", "--dir", repo], { cwd: repo, env, stdio: ["ignore", "ignore", "inherit"] });
git(repo, "push", "-q", "origin", "main");
const file = path.join(repo, "src", "m0", "file0.js");

function run(event: string, input: object, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ["--no-warnings", path.join(dist, "hook.cjs"), event], { env: { ...env, ...extraEnv }, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("close", () => resolve(performance.now() - started));
    child.stdin.end(JSON.stringify(input));
  });
}
const edit = { session_id: "bench-session", cwd: repo, tool_name: "Edit", tool_input: { file_path: file } };
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
const gitLaunches = async (event: string, input: object) => {
  fs.rmSync(trace, { force: true });
  await run(event, input, { GIT_TRACE2_EVENT: trace });
  try {
    return fs.readFileSync(trace, "utf8").split("\n").filter((l) => l.includes('"event":"start"')).length;
  } catch {
    return 0;
  }
};

await run("start", edit); // autostarts the server
await run("prompt", { ...edit, prompt: "bench" });
const cases: [string, string, () => void][] = [
  ["start", "start", () => {}],
  ["pre", "pre", () => {}],
  ["post, nothing to publish", "post", () => {}],
  ["post, one edited file", "post", () => fs.appendFileSync(file, `// ${Math.random()}\n`)],
];
console.log(`runs per cell: ${runs}; repository: 300 files; origin: local bare repository`);
console.log("event".padEnd(26), "cache".padEnd(5), "p50 ms".padStart(7), "p95 ms".padStart(7), "max ms".padStart(7), "git launches".padStart(13));
for (const cold of [false, true]) {
  for (const [label, event, prepare] of cases) {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      if (cold) fs.rmSync(path.join(home, "cache", "repos.json"), { force: true });
      prepare();
      times.push(await run(event, edit));
    }
    if (cold) fs.rmSync(path.join(home, "cache", "repos.json"), { force: true });
    prepare();
    const launches = await gitLaunches(event, edit);
    console.log(label.padEnd(26), (cold ? "cold" : "warm").padEnd(5), q(times, 0.5).toFixed(0).padStart(7), q(times, 0.95).toFixed(0).padStart(7), Math.max(...times).toFixed(0).padStart(7), String(launches).padStart(13));
  }
}
const bare: number[] = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  execFileSync(process.execPath, ["-e", "0"]);
  bare.push(performance.now() - t);
}
console.log(`bare node startup: p50 ${q(bare, 0.5).toFixed(0)} ms (a floor no hook can beat)`);
try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {
  // the autostarted server may still hold a file for a moment
}
