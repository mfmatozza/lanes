// Git operations the hook performs in the background: handoff sync (ADR-0015) and signed checkpoints (ADR-0017).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateDir } from "@lanes/core/local.ts";
import { gitDirOf, hasOrigin } from "@lanes/core/repo.ts";
import { MAX_RANGES, mergeRanges } from "@lanes/core/ranges.ts";
import type { LineRange } from "@lanes/core/types.ts";

export const INTEGRATION_BRANCH = process.env.LANES_INTEGRATION ?? "lanes/main";
/**
 * Remote mode (ADR-0021): the integration branch lives on the remote, so teammates can be on different machines.
 * Default is `origin` when the repository has one, no env var needed (#102); LANES_REMOTE overrides it, and
 * LANES_REMOTE="" forces local mode. Without any remote, `lanes/main` is a local branch that `lanes init` created.
 */
function remoteOf(cwd: string): string | null {
  const env = process.env.LANES_REMOTE;
  if (env !== undefined) return env || null;
  const known = hasOrigin(cwd); // read from the config file: a git launch costs 25-60 ms on Windows (#132)
  if (known !== null) return known ? "origin" : null;
  return tryGit(cwd, ["remote", "get-url", "origin"]) === null ? null : "origin";
}

/**
 * The ref to sync and publish against, and the commit it points at; null if there is no integration branch. In remote
 * mode the remote is asked first (one cheap `ls-remote`) and fetched only when its tip is not already here (#132).
 */
function integrationRef(cwd: string): { ref: string; sha: string } | null {
  const REMOTE = remoteOf(cwd);
  if (!REMOTE) {
    const sha = tryGit(cwd, ["rev-parse", "--verify", INTEGRATION_BRANCH]);
    return sha === null ? null : { ref: INTEGRATION_BRANCH, sha };
  }
  const tracking = `refs/remotes/${REMOTE}/${INTEGRATION_BRANCH}`;
  const advertised = netGit(cwd, ["ls-remote", "--refs", REMOTE, `refs/heads/${INTEGRATION_BRANCH}`]);
  const tip = advertised?.split(/\s/)[0];
  if (!tip) return null;
  let sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", tracking]);
  if (sha !== tip) {
    if (netGit(cwd, ["fetch", "--quiet", REMOTE, `+refs/heads/${INTEGRATION_BRANCH}:${tracking}`]) === null) return null;
    sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", tracking]);
  }
  return sha === null ? null : { ref: tracking, sha };
}

export interface Identity {
  name: string;
  email: string;
}

// Big trees print big status/ls-files output; the 1 MB default made them look empty (ENOBUFS -> null -> []).
const MAX_BUFFER = 512 * 1024 * 1024;

// A network call that hangs must not eat the hook's whole timeout (#81, #131), but a slow one is not a dead one: a loaded
// machine (CI) took over 2 s for an ls-remote, got the remote marked down, and dropped every later publish (#141). The first
// attempt always runs; a retry only starts with one fetch of the budget left. LANES_NET_TIMEOUT_MS overrides both.
const netTimeout = (kind: "fetch" | "push") => Number(process.env.LANES_NET_TIMEOUT_MS ?? (kind === "push" ? 20_000 : 10_000));

// Windows: Git for Windows refuses paths over 260 characters unless core.longpaths is set (#109).
// No automatic gc/maintenance: it would be launched behind every commit and fetch of an agent edit.
const LANES_GIT = ["-c", "core.longpaths=true", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];

function gitRaw(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout?: number): string {
  return execFileSync("git", LANES_GIT.concat(args), {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  });
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return gitRaw(cwd, args, env).trim();
}

/** A NUL-separated path list (`-z` is added): byte-exact, never quoted like "caf\303\251.ts" (#76). Throws on failure. */
export function gitPaths(cwd: string, args: string[]): string[] {
  return gitRaw(cwd, [...args, "-z"]).split("\0").filter(Boolean);
}

/** Tracked files of the checkout; empty when git fails. */
export function listFiles(cwd: string): string[] {
  try {
    return gitPaths(cwd, ["ls-files"]);
  } catch {
    return [];
  }
}

// An unreachable remote is remembered per checkout, so the next hooks skip the fetch instead of each waiting for a
// timeout (#131). The pause grows with consecutive failures: 30 s, 60 s, 2 min, capped at 5 min.
const originDownFile = (cwd: string) => path.join(privateDir("cache"), `origin-down-${crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`);

function originDownUntil(cwd: string): { until: number; failures: number } {
  try {
    return JSON.parse(fs.readFileSync(originDownFile(cwd), "utf8"));
  } catch {
    return { until: 0, failures: 0 };
  }
}

function markOrigin(cwd: string, reachable: boolean): void {
  try {
    const file = originDownFile(cwd);
    if (reachable) return void fs.rmSync(file, { force: true });
    const { failures } = originDownUntil(cwd);
    fs.writeFileSync(file, JSON.stringify({ until: Date.now() + Math.min(300_000, 30_000 * 2 ** failures), failures: failures + 1 }), { mode: 0o600 });
  } catch {
    // the cache is an optimisation only
  }
}

/** True for a failure of the connection itself; a rejected push or a missing branch means the remote answered. */
function unreachable(err: unknown): boolean {
  const e = err as { code?: string; signal?: string; stderr?: string };
  return e.code === "ETIMEDOUT" || e.signal === "SIGTERM" || /could not resolve host|connection (refused|timed out|reset)|network is unreachable|failed to connect|operation timed out/i.test(e.stderr ?? "");
}

/** A git call that talks to the remote: bounded in time, null on failure, and not even tried while the remote is known to be down. */
function netGit(cwd: string, args: string[]): string | null {
  if (Date.now() < originDownUntil(cwd).until) return null;
  try {
    const out = gitRaw(cwd, args, {}, netTimeout(args[0] === "push" ? "push" : "fetch")).trim();
    markOrigin(cwd, true);
    return out;
  } catch (err) {
    if (unreachable(err)) markOrigin(cwd, false);
    return null;
  }
}

export function tryGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string | null {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

/** Like tryGit, but returns git's error output on failure, for diagnostics. */
function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: git(cwd, args, env) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    return { ok: false, error: `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().slice(0, 500) || e.message };
  }
}

/**
 * Git must never fall back to a machine identity (or fail for lack of one): commits and rebases carry the human's.
 * shortcut (#88): "signed as the human" means identity, not a cryptographic signature. Checkpoint commits are unsigned
 * (commit.gpgsign=false) because a signer that prompts or is missing fails every publish inside a hook; sign when
 * there is a non-interactive way to.
 */
function identityEnv(who: Identity): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
  };
}

// On a branch with pushed commits Lanes cannot rebase onto its own published tip, so the checkout stays beside it. The
// originals and replays it published are remembered here (a file in the git directory), so the next publish neither
// replays them again (linear cost per edit instead of growing with every edit) nor merges its own tip back in as if a
// teammate had written it (#132, #124).
const MAX_PUBLISHED = 2_000;
const publishedFile = (cwd: string) => {
  const dir = gitDirOf(cwd);
  return dir ? path.join(dir, "lanes-published") : null;
};

function publishedSet(cwd: string): Set<string> {
  try {
    return new Set(fs.readFileSync(publishedFile(cwd)!, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function rememberPublished(cwd: string, hashes: string[]): void {
  try {
    const file = publishedFile(cwd);
    if (!file || hashes.length === 0) return;
    const all = [...publishedSet(cwd), ...hashes];
    if (all.length > MAX_PUBLISHED) fs.writeFileSync(file, all.slice(-MAX_PUBLISHED / 2).join("\n") + "\n");
    else fs.appendFileSync(file, hashes.join("\n") + "\n");
  } catch {
    // only an optimisation: without it the next publish replays and merges as before
  }
}

// Lanes commits that did not apply onto the shared tip at the last publish (they depend on the human's unshared work): tried last
// next time. An optimisation and a work bound only: losing the file changes the order, never what is published (#244).
const MAX_REPLAY = () => Number(process.env.LANES_MAX_REPLAY ?? 100);
const MAX_REBASE = 20;
const blockedFile = (cwd: string) => {
  const dir = gitDirOf(cwd);
  return dir ? path.join(dir, "lanes-blocked") : null;
};
function blockedSet(cwd: string): Set<string> {
  try {
    return new Set(fs.readFileSync(blockedFile(cwd)!, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
function rememberBlocked(cwd: string, hashes: string[]): void {
  try {
    const file = blockedFile(cwd);
    if (file && (hashes.length > 0 || fs.existsSync(file))) fs.writeFileSync(file, hashes.slice(-MAX_PUBLISHED).join("\n") + "\n");
  } catch {
    // see above
  }
}

/** True if `commit` is something this checkout published itself (a replayed tip it pushed). */
export function isOwnPublished(cwd: string, commit: string): boolean {
  return publishedSet(cwd).has(commit);
}

/** True if everything `sha` has that HEAD lacks was published from this checkout: there is nothing to bring in. */
function onlyOwnIncoming(cwd: string, sha: string): boolean {
  const own = publishedSet(cwd);
  if (own.size === 0) return false;
  try {
    const incoming = gitRaw(cwd, ["rev-list", `HEAD..${sha}`]).split("\n").filter(Boolean);
    return incoming.length > 0 && incoming.every((h) => own.has(h));
  } catch {
    return false;
  }
}

export function isAncestor(cwd: string, commit: string, of = "HEAD"): boolean {
  return tryGit(cwd, ["merge-base", "--is-ancestor", "--end-of-options", commit, of]) !== null;
}

export function fileHash(file: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Resolves diff3 conflict blocks: the agent's lines, then the lines the teammates added there (theirs minus base). Lines the
 * agent removed from base stay removed (a union would bring them back); nothing a teammate added is dropped.
 */
function resolveConflicts(text: string, onlyInsertions = false): string | null {
  const out: string[] = [];
  let part: "text" | "ours" | "base" | "theirs" = "text";
  let ours: string[] = [], base: string[] = [], theirs: string[] = [];
  for (const line of text.split("\n")) {
    if (part === "text") {
      if (line.startsWith("<<<<<<< ")) { part = "ours"; ours = []; base = []; theirs = []; } else out.push(line);
    } else if (part === "ours" && line.startsWith("||||||| ")) part = "base";
    else if (part === "base" && line.startsWith("=======")) part = "theirs";
    else if (part === "theirs" && line.startsWith(">>>>>>> ")) {
      // Competing changes to existing lines (not just two insertions at one spot) are for the agent to redo.
      if (onlyInsertions && base.length > 0) return null;
      const left = [...base];
      const added = theirs.filter((l) => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; });
      out.push(...ours, ...added.filter((l) => !ours.includes(l)));
      part = "text";
    } else (part === "ours" ? ours : part === "base" ? base : theirs).push(line);
  }
  return out.join("\n");
}

/**
 * A whole-file `Write` is composed before the pre-hook runs, so it can drop lines teammates published since the agent read the
 * file (#218). Three-way merge: base = the file where the turn started, theirs = the checkout's committed file (what the
 * pre-hook synced in), ours = what was written. Both sides' lines are kept (conflicting hunks go through resolveConflicts: lines added at the same spot, the usual
 * "append a route" case, would otherwise conflict); "conflict" only means git could not merge the file at all.
 * shortcut: a conflicting hunk can leave a duplicated or out-of-order line; the agent is told to re-read the file.
 */
export function mergeStaleWrite(cwd: string, rel: string, turnStart: string): "merged" | "conflict" | "same" {
  const show = (rev: string): Buffer | null => {
    try {
      return execFileSync("git", LANES_GIT.concat(["show", "--end-of-options", `${rev}:${rel}`]), { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: MAX_BUFFER });
    } catch {
      return null; // a new file, or a commit this checkout does not have
    }
  };
  const theirs = show("HEAD");
  const base = /^[0-9a-f]{40,64}$/.test(turnStart) ? show(turnStart) : null;
  if (!theirs || !base || theirs.equals(base)) return "same"; // nothing arrived since the turn started
  let ours: Buffer;
  try {
    ours = fs.readFileSync(path.join(cwd, rel));
  } catch {
    return "same";
  }
  if (ours.equals(theirs) || ours.includes(0) || theirs.includes(0)) return "same";
  const merged = mergeBoth(ours, base, theirs);
  if (!merged) return "conflict";
  if (merged.equals(ours)) return "same";
  fs.writeFileSync(path.join(cwd, rel), merged);
  return "merged";
}

/** Three-way merge that keeps both sides' additions (see resolveConflicts); null for binary content or when git cannot merge. */
function mergeBoth(ours: Buffer, base: Buffer, theirs: Buffer, onlyInsertions = false): Buffer | null {
  if (ours.includes(0) || base.includes(0) || theirs.includes(0)) return null;
  const dir = fs.mkdtempSync(path.join(privateDir("tmp"), "merge-"));
  try {
    for (const [name, data] of [["ours", ours], ["base", base], ["theirs", theirs]] as const) fs.writeFileSync(path.join(dir, name), data, { mode: 0o600 });
    const run = spawnSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", "ours", "base", "theirs"], { cwd: dir, windowsHide: true, maxBuffer: MAX_BUFFER });
    if (run.status === null || run.status < 0 || run.status > 127) return null;
    if (run.status === 0) return run.stdout;
    const resolved = resolveConflicts(run.stdout.toString("latin1"), onlyInsertions);
    return resolved === null ? null : Buffer.from(resolved, "latin1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `rev:path` as bytes; null when it does not exist there (a new or deleted file, or an index stage that is empty). */
function blobAt(cwd: string, rev: string, p: string): Buffer | null {
  try {
    return execFileSync("git", LANES_GIT.concat(["show", "--end-of-options", `${rev}:${p}`]), { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: MAX_BUFFER });
  } catch {
    return null;
  }
}

/** The three versions of a file merged keeping both sides' insertions; null if they compete for existing lines (or a side is missing). */
function keepBoth(ours: Buffer | null, base: Buffer | null, theirs: Buffer | null): Buffer | null {
  return ours && base && theirs ? mergeBoth(ours, base, theirs, true) : null;
}

// An agent writes its file after its pre hook and before its post hook, outside any lock. Another session's rebase, stash or
// reset of the same checkout in that window silently undid the write (#261, scale test). So pre marks the edit (under the
// checkout lock), post clears it, and no git operation rewrites the working tree while another session's edit is marked.
// Stale after INFLIGHT_MS: an agent killed mid-edit, or a user who never answers the approval prompt.
// Cursor has no pre-edit hook: its whole turn is marked, from the prompt to the stop.
// shortcut: a human's own edits are never marked; the window is the length of one git operation, as before.
const INFLIGHT_MS = 10 * 60_000;
const sha16 = (text: string) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const inflightDir = (cwd: string) => privateDir("inflight", sha16(cwd));

/** Marks (or clears) `session`'s edit of `rel` as under way in this checkout. Without `rel`, clears all of the session's. */
export function markEditInFlight(cwd: string, session: string, rel: string | undefined, on: boolean): void {
  const dir = inflightDir(cwd);
  if (on && rel !== undefined) return fs.writeFileSync(path.join(dir, `${sha16(session)}-${sha16(rel)}`), "");
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${sha16(session)}-`) && (rel === undefined || name.endsWith(`-${sha16(rel)}`))) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** True while another session's edit is marked in this checkout (the caller's own, `self`, never stops it). */
function editInFlight(cwd: string, self?: string): boolean {
  const dir = inflightDir(cwd);
  for (const name of fs.readdirSync(dir)) {
    if (self !== undefined && name.startsWith(`${sha16(self)}-`)) continue;
    try {
      if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs < INFLIGHT_MS) return true;
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // cleared meanwhile
    }
  }
  return false;
}

/** Brings the integration branch into this checkout, keeping uncommitted work. */
export function syncFromIntegration(cwd: string, who: Identity, session?: string): { ok: true } | { ok: false; error: string; skipped?: true } {
  const target = integrationRef(cwd);
  const REMOTE = remoteOf(cwd);
  if (target === null) return REMOTE ? { ok: false, error: `cannot fetch ${INTEGRATION_BRANCH} from ${REMOTE}` } : { ok: true };
  if (isAncestor(cwd, target.sha) || onlyOwnIncoming(cwd, target.sha)) return { ok: true };
  const res = rebaseOnto(cwd, target.ref, identityEnv(who), true, false, session);
  return res.ok ? { ok: true } : { ok: false, error: res.error, ...(res.inFlight && { skipped: true as const }) };
}

/** The human's own rebase/merge/cherry-pick/revert, if one is in progress: Lanes never touches the checkout then (#100). */
function operationInProgress(cwd: string): string | null {
  const gitDir = gitDirOf(cwd);
  if (gitDir) {
    // All five markers live in the checkout's own git directory: five `rev-parse --git-path` launches avoided (#132).
    for (const [name, label] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
      if (fs.existsSync(path.join(gitDir, name))) return label;
    }
    return null;
  }
  for (const [name, label] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
    const where = tryGit(cwd, ["rev-parse", "--git-path", name]);
    if (where && fs.existsSync(path.resolve(cwd, where))) return label;
  }
  return null;
}

type RebaseResult = { ok: true; reapplied?: string[] } | { ok: false; error: string; overlap?: true; inFlight?: true; skipped?: "busy" | "pushed" };

/**
 * Rebases the checkout onto `ref`, keeping uncommitted work. Never merges into a file the human has uncommitted
 * changes in: `rebase --autostash` exits 0 even when re-applying the stash conflicts, leaving markers in their file
 * (#79). Such a rebase is skipped (ADR-0019: never refuse, just don't sync) and reported as `overlap`.
 * Also skipped, and never aborted, while the human's own rebase/merge is in progress (#100) and when it would
 * rewrite commits that are already on a remote (#111).
 * shortcut: a branch that was never pushed is still rebased; so is a branch with nothing of its own (a fast-forward).
 */
function rebaseOnto(cwd: string, ref: string, env: NodeJS.ProcessEnv, mergePushed = true, sharedWins = false, session?: string): RebaseResult {
  const busy = operationInProgress(cwd);
  if (busy) return { ok: false, skipped: "busy", error: `a ${busy} is in progress in this checkout` };
  // Treated like the human's overlapping uncommitted work: no sync now, the publish goes out as a replayed tip.
  if (editInFlight(cwd, session)) return { ok: false, overlap: true, inFlight: true, error: "another agent is editing a file in this checkout" };
  let pushed = false;
  try {
    const fork = tryGit(cwd, ["merge-base", "HEAD", ref]);
    if (fork) {
      const own = Number(git(cwd, ["rev-list", "--count", `${fork}..HEAD`]));
      const unpushed = Number(git(cwd, ["rev-list", "--count", "HEAD", "--not", fork, "--remotes"]));
      // Too many local commits to replay one by one (a rebase that is going to conflict costs time per commit, at every sync and
      // publish, #244): merge, which costs the same however long the branch is.
      pushed = unpushed < own || own > MAX_REBASE;
    }
    const incoming = new Set(fork ? gitPaths(cwd, ["diff", "--name-only", "--no-renames", fork, ref]) : []);
    const clash = changedPaths(cwd).filter((p) => incoming.has(p));
    if (clash.length > 0) return { ok: false, overlap: true, error: `uncommitted changes in ${clash.slice(0, 3).join(", ")} overlap the incoming ones` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  // Pushed commits are never rewritten (#111): merge instead, so the teammate's content still arrives (#124).
  // Merging touches no file the human has uncommitted changes in (checked above); a conflict is undone.
  if (pushed && !mergePushed) return { ok: false, skipped: "pushed", error: "this branch has commits that are already pushed; not rewriting them" };
  if (pushed) return mergeIn(cwd, ref, env, sharedWins);
  const res = runGit(cwd, ["rebase", "--quiet", "--autostash", ref], env);
  if (res.ok) return { ok: true };
  tryGit(cwd, ["rebase", "--abort"]); // only reached for a rebase Lanes itself just started: none was in progress above
  return { ok: false, error: res.error };
}

/**
 * Merges `ref` into the branch (a new merge commit, nothing rewritten). A conflict that is only two insertions at one spot is
 * resolved keeping both sides' lines (#240, #244); with `sharedWins`, other overlaps take the shared content and the agent's
 * version goes to a backup ref (#144). Anything else is undone and reported with `skipped: "pushed"` (history is not ours to rewrite).
 */
function mergeIn(cwd: string, ref: string, env: NodeJS.ProcessEnv, sharedWins: boolean): RebaseResult {
  const merged = runGit(cwd, ["merge", "--quiet", "--no-edit", ref], env);
  if (merged.ok) return { ok: true };
  const clashing = tryGit(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])?.split("\0").filter(Boolean) ?? [];
  const both = clashing.length > 0 ? clashing.map((p) => [p, keepBoth(blobAt(cwd, ":2", p), blobAt(cwd, ":1", p), blobAt(cwd, ":3", p))] as const) : [];
  if (both.length > 0 && both.every(([, data]) => data)) {
    try {
      for (const [p, data] of both) {
        fs.writeFileSync(path.join(cwd, p), data!);
        git(cwd, ["add", "--", `:(literal)${p}`]);
      }
      git(cwd, ["commit", "--quiet", "--no-edit"], env);
      return { ok: true };
    } catch {
      // fall through: undo and take the shared content below
    }
  }
  tryGit(cwd, ["merge", "--abort"]);
  if (sharedWins && clashing.length > 0) {
    // Overlapping edits on a branch whose history cannot be rewritten: the shared content wins in the checkout (a new
    // merge commit, nothing rewritten), the agent's version stays in the backup ref and the agent re-applies (#144).
    const mine = tryGit(cwd, ["rev-parse", "HEAD"]);
    const again = runGit(cwd, ["merge", "--quiet", "--no-edit", "-X", "theirs", ref], env);
    if (again.ok && mine) {
      tryGit(cwd, ["update-ref", `refs/lanes/backup/${mine}`, mine]);
      return { ok: true, reapplied: clashing };
    }
    tryGit(cwd, ["merge", "--abort"]);
  }
  return { ok: false, skipped: "pushed", error: merged.error };
}

/** The files in the index (under `pathspec` if given), as `git commit` would record them. */
function stagedFiles(cwd: string, pathspec: string[]): string[] {
  return gitRaw(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z", ...pathspec]).split("\0").filter(Boolean);
}

/** Fingerprint of the files a checkpoint commits: stored in its message, checked before the commit is published (#107). */
function filesHash(files: string[]): string {
  return crypto.createHash("sha1").update([...files].sort().join("\0")).digest("hex");
}

/**
 * Commits of `range` that Lanes made, oldest first: they carry the Lanes-Agent trailer and still change exactly the
 * files recorded in their Lanes-Files trailer. A human who amends or squashes content into a checkpoint keeps the
 * message but not the file list, so that commit is no longer Lanes' and never travels (#107).
 * shortcut: checkpoints made before Lanes-Files existed are trusted on their trailer alone.
 */
function lanesRange(cwd: string, range: string): { mine: string[]; total: number; messages: Map<string, string> } {
  // One `git log` for the hash, message and files of every commit in the range (it used to be a rev-list, then a show and a
  // diff-tree per Lanes commit, then a count): records are \x01 hash \x02 message \x03, then the NUL-separated file names.
  const out = gitRaw(cwd, ["log", "--reverse", "--no-renames", "-z", "--name-only", "--format=%x01%H%x02%B%x03", range]);
  const records = out.split("\x01").slice(1);
  const mine: string[] = [];
  const messages = new Map<string, string>();
  for (const record of records) {
    const [hash, rest] = record.split("\x02") as [string, string];
    const [message, names = ""] = rest.split("\x03") as [string, string?];
    if (!/^Lanes-Agent: /m.test(message)) continue;
    const recorded = /^Lanes-Files: ([0-9a-f]{40})$/m.exec(message)?.[1];
    const files = names.split("\0").map((n) => n.replace(/^\n/, "")).filter(Boolean);
    if (!recorded || filesHash(files) === recorded) {
      mine.push(hash);
      messages.set(hash, message);
    }
  }
  return { mine, total: records.length, messages };
}

/** Files whose edit overlapped newer shared content: the agent re-applies it; its version is kept in `backup`. */
export interface Reapply {
  backup: string;
  paths: string[];
}

export type PublishResult =
  | { status: "nothing"; pulled?: string[]; failed?: string[] }
  // blocked: files of Lanes commits that depend on the human's unshared commits; they stay local (#106).
  // failed: files `git add` could not stage (too long a path, a locked file, safecrlf); retried at the next publish (#109).
  // base: the shared tip the publish built on (absent when nothing new was pushed), so base..commit is what it published.
  | { status: "published"; commit: string; base?: string; paths: string[]; reapply?: Reapply; pulled?: string[]; blocked?: string[]; failed?: string[]; syncSkipped?: string }
  // commit-pending: the repository's own commit hooks are still running; the commit lands later and the next publish sends it.
  | { status: "conflict" | "retries-exhausted" | "no-integration-branch" | "commit-failed" | "commit-pending"; error?: string; failed?: string[] };

/**
 * Every path git reports as changed, staged or untracked (not ignored), repo-relative; only those under `only`
 * (literal paths) when given. Throws if git fails: an unreadable status is not an empty one (#84).
 */
export function changedPaths(cwd: string, only?: string[]): string[] {
  const spec = only ? ["--", ...only.map((p) => `:(literal)${p}`)] : [];
  const out = gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...spec]);
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(fields[++i]); // a rename also lists its old path
  }
  return paths;
}

/**
 * New-side line ranges per file from `git diff -U0` output (S6.1). A deletion has no new lines: it marks the line it was
 * at. Files git quotes (odd characters), deleted files and binaries get no entry, which reads as "unknown" (file-level).
 */
export function parseHunks(diff: string, max = MAX_RANGES): Record<string, LineRange[]> {
  const out: Record<string, LineRange[]> = Object.create(null); // paths are keys: "__proto__" must stay one
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6).replace(/[\t\r]+$/, "") : null; // git ends a name with a space in a tab
    else if (line.startsWith("diff --git ")) file = null;
    const hunk = file !== null && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    (out[file!] ??= []).push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1]);
  }
  for (const f in out) out[f] = mergeRanges(out[f], max);
  return out;
}

/** Line ranges `from..to` changed in `paths`; empty when git fails (the heads-up then stays file-level). */
export function changedRanges(cwd: string, from: string, to: string, paths: string[]): Record<string, LineRange[]> {
  if (paths.length === 0) return Object.create(null);
  const out = tryGit(cwd, ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--", ...paths.map((p) => `:(literal)${p}`)]);
  return parseHunks(out ?? "");
}

// Never published even when they appear during an agent's turn: they usually hold credentials (ADR-0023).
const SECRET_LIKE = /(^|\/)(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]+\.(pem|key|p12|pfx|keystore|jks))$/i;
const MAX_NEW_FILE = 1_000_000;

/**
 * Files a turn produced outside the edit tools (generators, scripts, `mkdir`/`cp`): changed now but not before the
 * prompt, so never the human's own work. Secret-looking and very large files (likely build output) are left out.
 */
export function filesFromTurn(cwd: string, before: string[]): string[] {
  const earlier = new Set(before);
  return changedPaths(cwd).filter((p) => {
    if (earlier.has(p) || SECRET_LIKE.test(p)) return false;
    try {
      return fs.statSync(`${cwd}/${p}`).size <= MAX_NEW_FILE;
    } catch {
      return true; // deleted during the turn: publishing the deletion is right
    }
  });
}

function checkpointMessage(trailers: { session: string; task: string }, files: string[]): string {
  const subject = trailers.task.length > 72 ? `${trailers.task.slice(0, 69).trimEnd()}...` : trailers.task;
  return [
    subject,
    "",
    `Lanes-Agent: claude-code (session ${trailers.session.slice(0, 8)})`,
    `Lanes-Task: ${trailers.task}`,
    `Lanes-Files: ${filesHash(files)}`,
    "Co-authored-by: Claude <noreply@anthropic.com>",
  ].join("\n");
}


/** The paths of `paths` that git sees as changed. Ignored, unchanged and never-tracked-and-gone ones are dropped, one by one (#82). */
function committable(cwd: string, paths: string[]): string[] {
  try {
    const changed = new Set(changedPaths(cwd, paths));
    return paths.filter((p) => changed.has(p));
  } catch {
    return paths; // status unreadable: let git decide, as before
  }
}

export interface PublishLimits {
  /** How long `git commit` (and the repository's hooks) may run before the publish gives up waiting for it. */
  commitDeadlineMs?: number;
  /** Total time the publish may take, from the hook's timeout. */
  budgetMs?: number;
  /** Bring the checkout up to date even with nothing to publish, so `pulled` says what teammates changed (team context, turn end). */
  sync?: boolean;
}

/**
 * Runs a git command, but stops waiting for it after `ms`: it is then left running, with its output in a file, not
 * killed (a killed `git commit` could leave a lock or half a commit). Resolves "pending" in that case (#81).
 */
function commitWithin(cwd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<{ ok: true } | { ok: false; error: string } | "pending"> {
  return new Promise((resolve) => {
    let log: number;
    const logFile = path.join(privateDir("logs"), `commit-${process.pid}-${Date.now()}.log`);
    try {
      log = fs.openSync(logFile, "w", 0o600);
    } catch (err) {
      return resolve({ ok: false, error: (err as Error).message });
    }
    // detached: the commit must keep running when this hook exits or is killed at its timeout.
    const child = spawn("git", LANES_GIT.concat(args), { cwd, stdio: ["ignore", log, log], windowsHide: true, detached: true, env: { ...process.env, ...env } });
    let abandoned = false;
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      clearTimeout(timer);
      if (abandoned) return void fs.rmSync(logFile, { force: true }); // finished after we stopped waiting
      fs.closeSync(log);
      if (!result.ok) result.error = fs.readFileSync(logFile, "utf8").trim().slice(0, 500) || result.error;
      fs.rmSync(logFile, { force: true });
      resolve(result);
    };
    const timer = setTimeout(() => {
      abandoned = true;
      child.unref();
      fs.closeSync(log);
      resolve("pending");
    }, ms);
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: `git exited with ${code}` }));
  });
}

/**
 * Commits the checkout's changes as the human (with Lanes trailers), rebases them onto the integration branch
 * and advances it with a compare-and-swap, retrying if another agent published in between.
 * Only Lanes' own commits are published (ADR-0023, finding 4): the human's own commits on the checked-out branch
 * stay local even when they sit under the agent's checkpoints.
 */
export async function checkpointAndPublish(
  cwd: string,
  who: Identity,
  trailers: { session: string; task: string },
  paths: string[],
  limits: PublishLimits = {},
): Promise<PublishResult> {
  const failed: string[] = [];
  const result = await publishCore(cwd, who, trailers, paths, limits, failed);
  return failed.length > 0 ? { ...result, failed } : result;
}

async function publishCore(
  cwd: string,
  who: Identity,
  trailers: { session: string; task: string },
  paths: string[],
  limits: PublishLimits,
  failed: string[],
): Promise<PublishResult> {
  const started = Date.now();
  const REMOTE = remoteOf(cwd);
  // Not a Lanes repository (no integration branch): never commit someone's work uninvited.
  // With a remote, a known tracking ref is enough; otherwise ask (a submodule or nested repository has an origin but no lanes/main, #146).
  const known = REMOTE ? tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${INTEGRATION_BRANCH}`]) !== null : false;
  if (!known && integrationRef(cwd) === null) return { status: "no-integration-branch" };
  const env = identityEnv(who);
  const busy = operationInProgress(cwd);
  if (busy) return { status: "conflict", error: `a ${busy} is in progress in this checkout; the edit is not committed until it ends` };

  // Only the files the agent's edit tools changed, as literal paths: never the human's other work or stray secrets,
  // and the repository's own commit hooks run, so secret scanners still apply (security review).
  // The commit names the same paths, so anything else the human has staged stays staged and out of it.
  const literal = (list: string[]) => ["--", ...list.map((p) => `:(literal)${p}`)];
  let todo = committable(cwd, paths);
  // Nothing of ours is left staged in the shared index (#204): a human's `git commit` in the moments between our `git add` and
  // our `git commit` took the agent's edit into their own commit, which is never published, and every later checkpoint built
  // on it was stuck behind it. `git commit -- <paths>` reads the working tree under its own index lock; a new file only needs
  // intent-to-add (`-N`), which a commit made without that path never includes.
  type Committed = Awaited<ReturnType<typeof commitWithin>>;
  const commitTodo = async (): Promise<Committed> => {
    const staged = gitRaw(cwd, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ...literal(todo)]).split("\0").filter(Boolean); // empty: the file is unchanged, or already committed
    // The repository's hooks (husky, lint-staged, scanners) run in here and can be slow: never wait past the deadline.
    return staged.length === 0 ? { ok: true } : commitWithin(cwd, ["commit", "--quiet", "-m", checkpointMessage(trailers, staged), ...literal(todo)], env, limits.commitDeadlineMs ?? 12_000);
  };
  if (todo.length > 0) {
    const intent = runGit(cwd, ["add", "-N", ...literal(todo)]).ok;
    let commit: Committed = intent ? await commitTodo() : { ok: false, error: "" };
    if (commit !== "pending" && !commit.ok) {
      // The commit refused something (core.safecrlf, a path that is too long): stage path by path to find what git cannot stage,
      // report it, and retry it next time (#109). Only this fallback uses the shared index.
      if (!runGit(cwd, ["add", "-A", ...literal(todo)]).ok) {
        for (const p of todo) if (!runGit(cwd, ["add", "-A", ...literal([p])]).ok) failed.push(p);
        todo = todo.filter((p) => !failed.includes(p));
      }
      commit = todo.length > 0 ? await commitTodo() : { ok: true };
    }
    if (commit === "pending") return { status: "commit-pending" };
    if (!commit.ok) return { status: "commit-failed", error: commit.error };
  }

  // Nothing changed now and every Lanes commit is already in the last known shared tip: no fetch, no push (#132).
  if (todo.length === 0 && failed.length === 0 && !limits.sync) {
    try {
      if (lanesRange(cwd, `${REMOTE ? `refs/remotes/${REMOTE}/${INTEGRATION_BRANCH}` : INTEGRATION_BRANCH}..HEAD`).mine.length === 0) return { status: "nothing" };
    } catch {
      // no tracking ref yet: take the full path below
    }
  }

  // Committed first, so an unreachable remote leaves the work safe in a local commit; the next publish pushes it.
  let reapply: Reapply | undefined;
  // Files other people changed that this publish brought into the checkout (the agent's copy is now newer than
  // what it read: spike v3d, L5).
  const before = git(cwd, ["rev-parse", "HEAD"]);
  const pulledSince = (base: string) => {
    const forkPoint = tryGit(cwd, ["merge-base", before, base]);
    if (!forkPoint) return [];
    // Only files that really differ from this checkout: a checkpoint the human amended has a new hash, which moves the
    // merge base back and would list the agent's own published files as news (#191).
    const unseen = new Set(gitPaths(cwd, ["diff", "--name-only", "--no-renames", before, base]));
    return gitPaths(cwd, ["diff", "--name-only", "--no-renames", forkPoint, base]).filter((p) => unseen.has(p));
  };
  let pulled: string[] = [];
  let syncSkipped: string | undefined; // why the checkout was not brought up to date (published anyway)
  let moved = false; // HEAD may have changed since `before`
  let sharedWon = false; // a merge resolved overlapping files in favour of the shared content: replay the same way
  let unrewritable = false; // the branch has pushed commits: publish a replayed tip instead of rebasing it (#111)
  for (let attempt = 0; attempt < 8; attempt++) {
    // Leave room for a fetch and a push inside the hook's own timeout; the next publish picks up where this stopped.
    if (attempt > 0 && Date.now() - started > (limits.budgetMs ?? 30_000) - netTimeout("fetch")) return { status: "retries-exhausted", error: "out of time" };
    const target = integrationRef(cwd); // remote: re-fetch what another publisher pushed
    if (target === null) return { status: "no-integration-branch" };
    const base = target.sha;
    if (!isAncestor(cwd, base) && onlyOwnIncoming(cwd, base)) {
      unrewritable = true; // only our own replayed tip is missing here: nothing to bring in, publish beside it
    } else if (!isAncestor(cwd, base)) {
      moved = true;
      pulled = pulledSince(base);
      // --autostash: files Lanes didn't commit (the human's, or a shell command's) ride along untouched.
      const rebase = rebaseOnto(cwd, base, env, true, true, trailers.session);
      if (rebase.ok && rebase.reapplied) {
        reapply = { backup: before, paths: rebase.reapplied };
        sharedWon = true;
      }
      // Pushed commits, or the human's uncommitted file overlapping what came in: skip the sync into the working tree
      // only; the agent's commits still publish as a replayed tip (#111, #128).
      unrewritable = !rebase.ok && (rebase.skipped === "pushed" || rebase.overlap === true);
      syncSkipped = !rebase.ok && unrewritable && !rebase.inFlight ? rebase.error : undefined; // in flight: momentary, not worth a flag
      if (!rebase.ok && !unrewritable) {
        if (rebase.skipped) return { status: "conflict", error: rebase.error };
        reapply = moveOntoShared(cwd, base, trailers, env);
        if (reapply) continue; // publish whatever didn't overlap
        // The range holds the human's own commits (never rewritten, #244): merge the shared tip in instead; the replay below
        // then publishes the Lanes commits alone.
        const merge = mergeIn(cwd, base, env, true);
        if (!merge.ok) return { status: "conflict", error: rebase.error };
        if (merge.reapplied) {
          reapply = { backup: before, paths: merge.reapplied };
          sharedWon = true;
        }
      }
    }
    // Read once: the range is classified up to this commit and this commit is what gets pushed. A human commit that lands in
    // between must not be pushed unclassified (#205).
    const head = moved ? git(cwd, ["rev-parse", "HEAD"]) : before;
    const range = lanesRange(cwd, `${base}..${head}`);
    const published = unrewritable || range.total !== range.mine.length ? publishedSet(cwd) : new Set<string>();
    const mine = range.mine.filter((h) => !published.has(h));
    if (mine.length === 0) return reapply ? { status: "published", commit: base, paths: [], reapply, pulled } : { status: "nothing", pulled };
    // Usually every commit above the shared tip is Lanes'. If not, publish a tip made of Lanes' commits alone.
    let tip = head;
    let blocked: string[] | undefined;
    let replayed: { done: string[]; made: string[] } | undefined;
    if (unrewritable || range.total !== range.mine.length || mine.length !== range.mine.length) {
      const replay = onlyLanes(cwd, base, mine, range.messages, env, sharedWon);
      replayed = replay;
      tip = replay.tip;
      if (replay.blocked.length > 0) blocked = replay.blocked;
      if (tip === base && blocked) return { status: "conflict", error: replay.error };
    }
    // Compare-and-swap: locally update-ref with the expected old value; remotely a push that git refuses unless it fast-forwards.
    const swapped = REMOTE
      ? netGit(cwd, ["push", "--quiet", REMOTE, `${tip}:refs/heads/${INTEGRATION_BRANCH}`]) !== null
      : tryGit(cwd, ["update-ref", `refs/heads/${INTEGRATION_BRANCH}`, tip, base]) !== null;
    if (swapped) {
      if (replayed) rememberPublished(cwd, [...replayed.done, ...replayed.made]);
      const changed = gitPaths(cwd, ["diff", "--name-only", "--no-renames", base, tip]);
      // The published tip is not in this branch when the human's commits are mixed in: rebase onto it so the
      // duplicates drop out (best effort; the next publish would do the same).
      if (tip !== head && !unrewritable) rebaseOnto(cwd, tip, env, false, false, trailers.session);
      return { status: "published", commit: tip, base, paths: changed, reapply, pulled, blocked, syncSkipped };
    }
  }
  return { status: "retries-exhausted" };
}

/**
 * The tree of `commit` replayed onto `tip` in memory (no working tree): a clean `merge-tree`, or one whose only conflicting
 * files are two insertions at one spot, resolved keeping both sides' lines; null when any file competes for existing lines,
 * is missing at the tip, or git fails.
 */
function replayTree(cwd: string, tip: string, commit: string, sharedWins: boolean): string | null {
  const run = spawnSync("git", LANES_GIT.concat(["merge-tree", "--write-tree", "--name-only", "-z", ...(sharedWins ? ["-X", "ours"] : []), `--merge-base=${commit}^`, tip, commit]), { cwd, windowsHide: true, maxBuffer: MAX_BUFFER });
  const fields = run.stdout?.toString("utf8").split("\0") ?? [];
  if (run.status === 0) return fields[0];
  if (run.status !== 1) return null; // not a content conflict
  const conflicted = fields.slice(1, fields.indexOf("", 1)); // the names end at the first empty field
  if (conflicted.length === 0) return null;
  const merged: (readonly [string, Buffer])[] = [];
  for (const p of conflicted) {
    // a file missing at the tip (it only exists in the human's unshared work) is a real dependency: stop at the first one
    const data = blobAt(cwd, tip, p) ? keepBoth(blobAt(cwd, commit, p), blobAt(cwd, `${commit}^`, p), blobAt(cwd, tip, p)) : null;
    if (!data) return null;
    merged.push([p, data]);
  }
  const dir = fs.mkdtempSync(path.join(privateDir("tmp"), "tree-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    git(cwd, ["read-tree", fields[0]], env);
    for (const [p, data] of merged) {
      const file = path.join(dir, "blob");
      fs.writeFileSync(file, data!);
      const mode = tryGit(cwd, ["ls-tree", commit, "--", `:(literal)${p}`])?.split(" ")[0] ?? "100644";
      git(cwd, ["update-index", "--add", "--cacheinfo", `${mode},${git(cwd, ["hash-object", "-w", "--", file])},${p}`], env);
    }
    return git(cwd, ["write-tree"], env);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The shared tip plus Lanes' commits only: each is replayed in memory (`merge-tree`, no working tree involved) so the
 * human's commits underneath never travel. A commit that depends on the human's unpublished work does not apply
 * cleanly; it stays local and is reported in `blocked`, and the independent commits after it are still published (#106).
 */
function onlyLanes(cwd: string, base: string, commits: string[], messages: Map<string, string>, env: NodeJS.ProcessEnv, sharedWins = false): { tip: string; blocked: string[]; error: string; done: string[]; made: string[] } {
  let tip = base;
  let tipTree: string | undefined;
  const blocked: string[] = [];
  const done: string[] = []; // originals now in the tip
  const made: string[] = []; // replay commits created
  let error = "";
  // Bounded work per publish (#244): commits that did not apply last time go last, and at most MAX_REPLAY are tried, so a few
  // commits that stay blocked can never make every publish replay hundreds of commits. The rest waits for the next publish.
  const was = blockedSet(cwd);
  const stuck: string[] = [];
  const order = [...commits.filter((c) => !was.has(c)), ...commits.filter((c) => was.has(c))].slice(0, MAX_REPLAY());
  for (const commit of order) {
    // Two insertions at one spot (the usual "append a line" race) are not a dependency on the human's work: keep both (#244).
    const tree = replayTree(cwd, tip, commit, sharedWins);
    if (!tree) {
      error = "a Lanes commit depends on local commits that are not shared";
      blocked.push(...gitPaths(cwd, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--no-renames", commit]));
      stuck.push(commit);
      continue;
    }
    tipTree ??= git(cwd, ["rev-parse", `${tip}^{tree}`]);
    done.push(commit);
    if (tree === tipTree) continue;
    tip = git(cwd, ["commit-tree", tree, "-p", tip, "-m", messages.get(commit) ?? git(cwd, ["log", "-1", "--format=%B", commit])], env);
    tipTree = tree;
    made.push(tip);
  }
  rememberBlocked(cwd, [...[...was].filter((h) => !done.includes(h)), ...stuck.filter((h) => !was.has(h))]);
  return { tip, blocked, error, done, made };
}

/**
 * A rebase conflict means someone edited the same lines without a lease (server down, or a wait that ran out).
 * Never stuck and never lost (spike v3c): this checkout's version is kept in a backup ref, the branch moves onto
 * the shared version, files that didn't overlap are carried over, and the overlapping ones are left for the agent
 * to re-apply on top of the newer content.
 *
 * Fail safe (#77): if anything goes wrong after the reset, the checkout is put back as it was. Not attempted at all
 * (the caller reports a conflict, the work stays committed locally) when the branch holds commits that are not
 * Lanes' or the human has uncommitted changes the move would touch.
 * shortcut: such branches are left to the human; moving them would rewrite their own history.
 */
function moveOntoShared(cwd: string, base: string, trailers: { session: string; task: string }, env: NodeJS.ProcessEnv): Reapply | undefined {
  const mine = git(cwd, ["rev-parse", "HEAD"]);
  const forkPoint = tryGit(cwd, ["merge-base", mine, base]);
  if (!forkPoint) return undefined;
  let ours: Set<string>;
  let theirs: Set<string>;
  try {
    const range = `${forkPoint}..${mine}`;
    const own = lanesRange(cwd, range);
    if (own.mine.length !== own.total) return undefined;
    const changed = (from: string, to: string) => new Set(gitPaths(cwd, ["diff", "--name-only", "--no-renames", from, to]));
    const moved = changed(mine, base);
    if (changedPaths(cwd).some((p) => moved.has(p))) return undefined;
    ours = changed(forkPoint, mine);
    theirs = changed(forkPoint, base);
  } catch {
    return undefined;
  }
  let overlapping = [...ours].filter((f) => theirs.has(f));
  const carried = [...ours].filter((f) => !theirs.has(f));
  // Files both sides changed are merged line-wise, keeping both sides' additions (#240); only what cannot be merged is
  // left to "shared wins, the agent re-applies". Computed before the reset, from the three versions.
  const mergedFiles = new Map<string, Buffer>();
  for (const p of overlapping) {
    const m = keepBoth(blobAt(cwd, mine, p), blobAt(cwd, forkPoint, p), blobAt(cwd, base, p));
    if (m) mergedFiles.set(p, m);
  }
  overlapping = overlapping.filter((p) => !mergedFiles.has(p));
  tryGit(cwd, ["update-ref", `refs/lanes/backup/${mine}`, mine]);
  // Uncommitted files (not Lanes') are set aside and put back, so the reset below can't lose anyone's work.
  // Compare before/after: with nothing to stash git makes no entry, and the user's own older stash must not be popped.
  const stashTop = () => tryGit(cwd, ["rev-parse", "-q", "--verify", "refs/stash"]);
  const stashBefore = stashTop();
  tryGit(cwd, ["stash", "push", "--include-untracked", "--quiet", "-m", "lanes: kept during re-apply"]);
  const stashed = stashTop() !== stashBefore;
  const restoreStash = () => {
    // If they don't apply cleanly they stay in `git stash list`: kept, never dropped.
    if (stashed) tryGit(cwd, ["stash", "pop", "--quiet"]);
  };
  try {
    git(cwd, ["reset", "--quiet", "--hard", base]);
    for (const [p, data] of mergedFiles) {
      fs.writeFileSync(path.join(cwd, p), data);
      git(cwd, ["add", "--", `:(literal)${p}`]);
    }
    if (carried.length > 0 || mergedFiles.size > 0) {
      const spec = (paths: string[]) => ["--", ...paths.map((p) => `:(literal)${p}`)];
      const kept = carried.filter((p) => tryGit(cwd, ["cat-file", "-e", `${mine}:${p}`]) !== null);
      const deleted = carried.filter((p) => !kept.includes(p));
      if (kept.length > 0) git(cwd, ["restore", `--source=${mine}`, "--staged", "--worktree", ...spec(kept)]);
      if (deleted.length > 0) git(cwd, ["rm", "-q", "-f", "--ignore-unmatch", ...spec(deleted)]);
      tryGit(cwd, ["commit", "--quiet", "-m", checkpointMessage(trailers, stagedFiles(cwd, []))], env);
    }
  } catch {
    // Back to what it was: the agent's commits and the human's stash.
    tryGit(cwd, ["reset", "--quiet", "--hard", mine]);
    restoreStash();
    return undefined;
  }
  restoreStash();
  return { backup: mine, paths: overlapping };
}
