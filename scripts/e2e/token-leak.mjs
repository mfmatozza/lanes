// Runs `lanes init --server --token` in a temp repo and checks the secret appears nowhere in the committed files or the
// hook's settings, only in the private ~/.lanes/config.json (LANES_HOME is a temp folder: nothing real is touched).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const lanes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "lanes.cjs");
const t = fs.mkdtempSync(path.join((process.env.LANES_TMP ?? "C:/lanes-tmp"), "lanes-leak-"));
const repo = path.join(t, "repo"), home = path.join(t, "home");
fs.mkdirSync(repo); fs.mkdirSync(home);
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "T"); git("config", "user.email", "t@e.com");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git("add", "-A"); git("commit", "-qm", "init");
const SECRET = "TEAM-SECRET-" + "q".repeat(24);
const r = spawnSync(process.execPath, [lanes, "init", "--dir", repo, "--server", "http://10.0.0.5:4317", "--token", SECRET], { env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" }, encoding: "utf8" });
console.log("init exit", r.status, "| token echoed in output:", (r.stdout + r.stderr).includes(SECRET));
const tracked = git("ls-files").split("\n");
let leaks = 0;
for (const f of tracked) if (fs.readFileSync(path.join(repo, f)).includes(SECRET)) { console.log("LEAK in committed file", f); leaks++; }
for (const f of fs.readdirSync(path.join(repo, ".git", "refs", "heads"))) void f;
const cfg = path.join(home, "config.json");
console.log("config.json has it:", fs.existsSync(cfg) && fs.readFileSync(cfg, "utf8").includes(SECRET), "| mode", (fs.statSync(cfg).mode & 0o777).toString(8), "(Windows ignores POSIX modes)");
console.log("git log message leaks:", git("log", "--all", "--format=%B").includes(SECRET));
fs.rmSync(t, { recursive: true, force: true });
process.exit(leaks ? 1 : 0);
