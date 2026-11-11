// `lanes pr` (Phase 3 b.8, ADR-0022): one task's checkpoint commits from lanes/main, squashed into a new branch and a PR.
// Only ever adds: a new branch, never a rewrite of pushed history, and the checkpoint commits stay where they are.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findRepo } from "@lanes/core/repo.ts";

export class PrError extends Error {}

export interface TaskGroup {
  key: string;
  title: string;
  session: string;
  commits: { sha: string; name: string; email: string; subject: string; coauthors: { name: string; email: string }[] }[];
}

export interface PrFilter {
  /** Matches the session prefix from the Lanes-Agent trailer or, case-insensitively, a part of the Lanes-Task title. */
  text?: string;
  /** Resolved from a server task id by the caller. */
  title?: string;
  session?: string;
}

export interface PrResult {
  branch: string;
  base: string;
  commit: string;
  title: string;
  contributors: string[];
  commits: number;
  pushed: boolean;
  /** What the user must run themselves (no remote, no gh, or a failed push). */
  commands: string[];
  message: string;
}

const FS = "\u001f";
const RS = "\u001e";

function run(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", ["-c", "core.longpaths=true", "-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new PrError(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split(/\r?\n/).slice(-3).join(" ")}`);
  }
}
const ok = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;

export function ghOnPath(searchPath = process.env.PATH ?? ""): boolean {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
  return searchPath.split(path.delimiter).filter(Boolean).some((d) => names.some((n) => fs.existsSync(path.join(d, n))));
}

/** The task trailers and co-authors of the commits `integration` has and `base` does not (patch-equal commits count as merged). */
export function taskGroups(root: string, base: string, integration: string): TaskGroup[] {
  const out = run(root, ["log", "--no-merges", "--reverse", "--right-only", "--cherry-pick", `--format=${RS}%H${FS}%an${FS}%ae${FS}%s${FS}%B`, `${base}...${integration}`]);
  const groups = new Map<string, TaskGroup>();
  for (const rec of out.split(RS).filter(Boolean)) {
    const [sha, name, email, subject, body] = rec.split(FS);
    const session = /^Lanes-Agent: .*\(session (\S+)\)\s*$/m.exec(body)?.[1];
    const title = /^Lanes-Task: (.+?)\s*$/m.exec(body)?.[1];
    if (!session || !title) continue; // a human's own commit, or one from before the trailers
    const coauthors = [...body.matchAll(/^Co-authored-by: (.+?) <([^<>\s]+)>\s*$/gim)].map((m) => ({ name: m[1], email: m[2] }));
    const key = `${session}\n${title}`;
    const g = groups.get(key) ?? { key, title, session, commits: [] };
    g.commits.push({ sha, name, email, subject, coauthors });
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** One entry per person (case-insensitive e-mail): the commit authors first, then the co-authors the checkpoints already name. */
export function contributors(g: TaskGroup, exclude?: string): { name: string; email: string }[] {
  const seen = new Set(exclude ? [exclude.toLowerCase()] : []);
  const list: { name: string; email: string }[] = [];
  for (const c of g.commits) {
    for (const p of [{ name: c.name, email: c.email }, ...c.coauthors]) {
      const k = p.email.toLowerCase();
      if (seen.has(k) || !p.email) continue;
      seen.add(k);
      list.push(p);
    }
  }
  return list;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";

/**
 * The commit was rejected (a repository hook, or git itself). The task's changes stay staged in the scratch worktree, which gets
 * the branch, and the message is saved beside it: the user fixes the problem there and runs the printed command (#211).
 */
function rejectedCommit(tmp: string, branch: string, message: string, output: string, hasOrigin: boolean): string {
  spawnSync("git", ["switch", "--quiet", "-c", branch], { cwd: tmp, stdio: "ignore" });
  let file = path.join(tmp, "..", `${path.basename(tmp)}-message.txt`);
  try {
    const gitDir = run(tmp, ["rev-parse", "--absolute-git-dir"]);
    file = path.join(gitDir, "LANES_PR_MESSAGE");
  } catch {
    // keep the file beside the worktree
  }
  fs.writeFileSync(file, message);
  // shortcut: a hook needing node_modules is recognised by git/node/sh's usual wording; an unknown wording just gets the output.
  const needsInstall = /node_modules|Cannot find (module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|(husky|lint-staged|eslint|prettier|tsc|jest|vitest)[^\n]*(not found|is not recognized)/i.test(output);
  return [
    "The repository's commit hooks (or git) rejected the commit of this task's changes. Output:",
    "",
    output || "(no output)",
    "",
    needsInstall ? `This looks like a hook that needs the project's dependencies, which the scratch worktree does not have: run your install command (for example npm ci) in "${tmp}", then continue.` : `Fix what the hook reports in "${tmp}" (the task's changes are staged there on branch ${branch}), then continue.`,
    "To continue:",
    `  git -C "${tmp}" commit -F "${file}"   (add --no-verify to skip the hooks yourself)`,
    ...(hasOrigin ? [`  git -C "${tmp}" push -u origin ${branch}`] : [`  (the branch ${branch} then lives in that worktree; no origin remote is set)`]),
    `When done, remove the scratch worktree: git worktree remove --force "${tmp}"`,
  ].join("\n");
}

/**
 * Creates `branch` (default lanes/pr/<title>) at the default branch plus one commit with the task's combined changes,
 * authored by the current git identity with a Co-authored-by line for every other contributor. Opens the PR with `gh` when
 * it is given (`gh: true`) and the repository has an origin; otherwise returns the exact commands to run.
 * shortcut: a task's commits that depend on another task's or a human's unmerged commits do not apply on their own and the
 * command stops with the conflict, until a per-file squash is worth building; an already squash-merged task is listed again.
 */
export function pr(dir: string, options: { filter?: PrFilter; branch?: string; gh: boolean; base?: string }): PrResult {
  const repo = findRepo(dir);
  if (!repo) throw new PrError(`${dir} is not inside a git repository. Run \`lanes pr\` in the project.`);
  const root = repo.root;
  const hasOrigin = ok(root, "remote", "get-url", "origin");
  if (hasOrigin) spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: root, stdio: "ignore", timeout: 20_000 }); // offline: use what is here
  const lanesBranch = process.env.LANES_INTEGRATION ?? "lanes/main";
  const integration = [`refs/remotes/origin/${lanesBranch}`, `refs/heads/${lanesBranch}`].find((r) => ok(root, "rev-parse", "--verify", "--quiet", r));
  if (!integration) throw new PrError(`There is no ${lanesBranch} here yet. Run \`lanes init\` in this project, then let an agent make an edit.`);
  // origin/HEAD is only there after a clone, or a fetch with git >= 2.48 (remote.<name>.followRemoteHEAD); otherwise the fallbacks below.
  const originHead = hasOrigin ? spawnSync("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim().replace("refs/remotes/", "") ?? "" : "";
  const candidates = [options.base && (hasOrigin ? `origin/${options.base}` : options.base), options.base, originHead, "origin/main", "origin/master", "main", "master"].filter((x): x is string => Boolean(x));
  const base = candidates.find((b) => ok(root, "rev-parse", "--verify", "--quiet", `${b}^{commit}`));
  if (!base) throw new PrError("Cannot find the default branch (main or master). Pass --base <branch>.");

  const groups = taskGroups(root, base, integration);
  const f = options.filter ?? {};
  const text = f.text?.toLowerCase();
  const matches = groups.filter((g) => (f.title === undefined || g.title === f.title) && (f.session === undefined || g.session === f.session || f.session.startsWith(g.session)) && (!text || g.title.toLowerCase().includes(text) || g.session.startsWith(text)));
  const list = (gs: TaskGroup[]) => gs.map((g) => `  ${g.session}  ${g.title}  (${g.commits.length} commits, ${contributors(g).length} contributors)`).join("\n");
  if (groups.length === 0) throw new PrError(`No Lanes task commits on ${lanesBranch} that are not already in ${base}.`);
  if (matches.length === 0) throw new PrError(`No task matches. Tasks on ${lanesBranch}:\n${list(groups)}`);
  if (matches.length > 1) throw new PrError(`More than one task matches; pass --task <session or part of the title>:\n${list(matches)}`);
  const g = matches[0];

  const branch = options.branch ?? `lanes/pr/${slug(g.title)}`;
  if (!ok(root, "check-ref-format", "--branch", branch)) throw new PrError(`"${branch}" is not a valid branch name.`);
  if (ok(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) || (hasOrigin && ok(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`))) {
    throw new PrError(`Branch ${branch} already exists. Lanes never overwrites a branch: pass --branch <other name>.`);
  }

  let me = { name: "", email: "" };
  try {
    me = { name: run(root, ["config", "user.name"]), email: run(root, ["config", "user.email"]) };
  } catch {
    throw new PrError("git user.name / user.email are not set. Set them, then run `lanes pr` again.");
  }
  const others = contributors(g, me.email);
  const body = [
    `Squashed from ${g.commits.length} Lanes checkpoint commit${g.commits.length === 1 ? "" : "s"} on ${lanesBranch} (${g.commits[0].sha.slice(0, 8)}..${g.commits[g.commits.length - 1].sha.slice(0, 8)}); the checkpoints are kept there.`,
    "",
    `Lanes-Task: ${g.title}`,
    ...others.map((p) => `Co-authored-by: ${p.name} <${p.email}>`),
  ].join("\n");
  const message = `${g.title.length > 72 ? `${g.title.slice(0, 69).trimEnd()}...` : g.title}\n\n${body}\n`;

  // A scratch checkout: the user's own checkout, index and branches are not touched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-pr-"));
  let commit: string;
  let keep = false; // a rejected commit leaves the scratch worktree for the user to continue in
  try {
    run(root, ["worktree", "add", "--quiet", "--detach", tmp, base]);
    try {
      for (const c of g.commits) run(tmp, ["cherry-pick", "--no-commit", "--allow-empty", c.sha]);
      if (ok(tmp, "diff", "--cached", "--quiet")) throw new PrError(`The task's changes are already in ${base}: nothing to open a PR for.`);
      // The repository's own commit hooks run (ADR-0023: no --no-verify), so secret scanners still apply.
      const made = spawnSync("git", ["-c", "core.longpaths=true", "commit", "--quiet", "-F", "-"], { cwd: tmp, input: message, encoding: "utf8", timeout: 120_000 });
      if (made.status !== 0) {
        keep = true;
        throw new PrError(rejectedCommit(tmp, branch, message, `${made.stdout ?? ""}${made.stderr ?? ""}${made.error?.message ?? ""}`.trim(), hasOrigin));
      }
      commit = run(tmp, ["rev-parse", "HEAD"]);
    } catch (err) {
      if (err instanceof PrError && /cherry-pick failed/.test(err.message)) {
        throw new PrError(`This task's commits do not apply cleanly on ${base} (they depend on changes that are not there yet). Merge those first. ${err.message}`);
      }
      throw err;
    } finally {
      if (!keep) spawnSync("git", ["worktree", "remove", "--force", tmp], { cwd: root, stdio: "ignore" });
    }
  } finally {
    if (!keep) {
      fs.rmSync(tmp, { recursive: true, force: true });
      spawnSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
    }
  }
  run(root, ["branch", branch, commit]);

  const baseName = base.replace(/^origin\//, "");
  const push = `git push -u origin ${branch}`;
  const create = `gh pr create --base ${baseName} --head ${branch} --fill`;
  const result: PrResult = { branch, base: baseName, commit, title: g.title, contributors: [me.email, ...others.map((p) => p.email)], commits: g.commits.length, pushed: false, commands: [], message: "" };
  if (!hasOrigin) {
    result.message = `Created ${branch} (${g.commits.length} commits squashed into one). There is no origin remote, so nothing was pushed; review it with \`git log ${base}..${branch}\`.`;
    return result;
  }
  if (!options.gh) {
    result.commands = [push, `open a pull request from ${branch} into ${baseName} on your git host`];
    result.message = `Created ${branch} (${g.commits.length} commits squashed into one). gh was not found, so run:`;
    return result;
  }
  try {
    run(root, ["push", "-u", "origin", branch]);
    result.pushed = true;
    const made = spawnSync("gh", ["pr", "create", "--base", baseName, "--head", branch, "--title", g.title, "--body", body], { cwd: root, encoding: "utf8" });
    if (made.status !== 0) throw new PrError(String(made.stderr || made.error?.message || "gh failed").trim());
    result.message = `Opened ${String(made.stdout).trim()} from ${branch} (${g.commits.length} commits squashed into one).`;
  } catch (err) {
    result.commands = result.pushed ? [create] : [push, create];
    result.message = `Created ${branch}, but ${result.pushed ? "gh could not open the PR" : "the push failed"} (${err instanceof Error ? err.message : String(err)}). Run:`;
  }
  return result;
}
