import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A temp git repo with one commit (src/a.ts) and a worktree next to it. */
export function makeRepo(): { main: string; worktree: string; cleanup: () => void } {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-spike-")));
  const main = path.join(base, "app");
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 1;\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  const worktree = path.join(base, "app-wt");
  git(main, "worktree", "add", "-q", worktree, "-b", "wt");
  return { main, worktree, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** A repo with an integration branch (lanes/main) and one worktree per named teammate. */
export function makeTeamRepo(...users: string[]): { main: string; wt: Record<string, string>; cleanup: () => void } {
  const { main, worktree, cleanup } = makeRepo();
  git(main, "worktree", "remove", "--force", worktree);
  fs.writeFileSync(path.join(main, "src", "routes.ts"), "export const routes = [\n  \"/\",\n];\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "routes");
  git(main, "branch", "lanes/main");
  const wt: Record<string, string> = {};
  for (const user of users) {
    wt[user] = path.join(path.dirname(main), `wt-${user}`);
    git(main, "worktree", "add", "-q", wt[user], "-b", `agent/${user}`);
  }
  return { main, wt, cleanup };
}

/** Spike v3 remote mode: a bare "origin" with lanes/main, and one separate clone per teammate (as if on different machines). */
export function makeRemoteTeam(...users: string[]): { origin: string; clone: Record<string, string>; cleanup: () => void } {
  const { main, cleanup } = makeTeamRepo();
  const origin = path.join(path.dirname(main), "origin.git");
  git(path.dirname(main), "clone", "-q", "--bare", main, origin);
  const clone: Record<string, string> = {};
  for (const user of users) {
    clone[user] = path.join(path.dirname(main), `clone-${user}`);
    git(path.dirname(main), "clone", "-q", "-b", "lanes/main", origin, clone[user]);
    git(clone[user], "checkout", "-q", "-b", `agent/${user}`);
  }
  return { origin, clone, cleanup };
}

/**
 * The POSIX shell Claude Code runs hook commands with. On Windows that is Git Bash, whose sh is on PATH on CI runners but not
 * after a default Git for Windows install (only Git\cmd is), so fall back to the sh next to git.
 */
export const SH = ((): string => {
  if (process.platform !== "win32" || spawnSync("where", ["sh"], { stdio: "ignore" }).status === 0) return "sh";
  const sh = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", "..", "bin", "sh.exe");
  return fs.existsSync(sh) ? sh : "sh";
})();
