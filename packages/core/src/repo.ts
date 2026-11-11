// Repository identity: maps any file path to (repository ID, repo-relative path),
// so the same file reached through different clones or worktrees gets the same lease.
// See docs/architecture/coordination-model.md §2.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateDir } from "./local.ts";

export interface RepoInfo {
  /** Shared by every clone and worktree: normalized origin URL, else the main checkout's path. */
  id: string;
  /** Root of this checkout (the worktree root for worktrees). */
  root: string;
  /** Short display name of this checkout. */
  label: string;
}

export interface FileLocation {
  repo: RepoInfo;
  /** Repo-relative path with forward slashes. */
  path: string;
}

const byCheckout = new Map<string, RepoInfo | null>();

/** Finds the checkout containing `target`. The target may not exist yet (a file about to be created). */
export function findRepo(target: string): RepoInfo | null {
  let dir = path.resolve(target);
  while (!isDirectory(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return repoAt(d);
    if (path.dirname(d) === d) return null;
  }
}

export function relativePath(repo: RepoInfo, file: string): string | null {
  const rel = path.relative(repo.root, path.resolve(file));
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null; // not "..weird.ts": that is a file name
  return rel.split(path.sep).join("/");
}

export function locate(file: string): FileLocation | null {
  const real = onDisk(file);
  const repo = findRepo(real);
  const rel = repo && relativePath(repo, real);
  return repo && rel ? { repo, path: rel } : null;
}

/**
 * The path as the disk knows it: symlinks resolved (macOS /var → /private/var) and, on case-insensitive disks,
 * the stored case (SRC/A.TS → src/a.ts), so one file always gets one lease. Parts that don't exist yet are kept.
 */
function onDisk(file: string): string {
  const rest: string[] = [];
  let dir = path.resolve(file);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(file);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/** `git@github.com:Acme/App.git`, `https://user:tok@github.com/acme/app` → `github.com/acme/app`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(u);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "").replace(/^([^/:]+):\d+\//, "$1/");
  }
  return u.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

export function gitUserName(dir: string): string | null {
  return git(dir, ["config", "--get", "user.name"]);
}

// Each hook call is a new process, and each git call costs ~25 ms on Windows, so identity is also cached on disk
// (spike v3 latency). An entry is invalidated when the repository's git config changes (e.g. a new origin URL).
// Private per-user folder, never shared /tmp: a poisoned entry would make the hook run git in someone else's folder.
const diskCache = () => path.join(privateDir("cache"), "repos.json");
type DiskEntry = { info: RepoInfo; config: string; mtimeMs: number };

function readDiskCache(): Record<string, DiskEntry> {
  try {
    return JSON.parse(fs.readFileSync(diskCache(), "utf8"));
  } catch {
    return {};
  }
}

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function writeDiskCache(disk: Record<string, DiskEntry>): void {
  try {
    // Write-then-rename so concurrent hooks never read a half-written file.
    const file = diskCache();
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(disk), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // The cache is an optimisation only.
  }
}

function repoAt(checkout: string): RepoInfo | null {
  const cached = byCheckout.get(checkout);
  if (cached !== undefined) return cached;
  const disk = readDiskCache();
  const hit = disk[checkout];
  if (hit && mtime(hit.config) === hit.mtimeMs) {
    byCheckout.set(checkout, hit.info);
    return hit.info;
  }
  const info = resolveRepo(checkout, disk);
  byCheckout.set(checkout, info);
  return info;
}

/**
 * The git directory of the checkout at `root` (the worktree's own one for linked worktrees), read from the file system:
 * a few ms cheaper than a `git rev-parse` launch, which costs 25-60 ms on Windows (#132). Null when it cannot tell.
 */
export function gitDirOf(root: string): string | null {
  try {
    const dot = path.join(root, ".git");
    if (fs.statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, "utf8"));
    return m ? path.resolve(root, m[1]) : null;
  } catch {
    return null;
  }
}

/** True/false if the repository at `root` has an origin remote, read from its config file; null when git must be asked (includes, odd layouts). */
export function hasOrigin(root: string): boolean | null {
  try {
    const gitDir = gitDirOf(root);
    if (!gitDir) return null;
    const common = fs.statSync(path.join(root, ".git")).isDirectory() ? gitDir : path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    const config = fs.readFileSync(path.join(common, "config"), "utf8");
    if (/^\s*\[\s*(include|worktree)/im.test(config)) return null;
    return /^\s*\[\s*remote\s+"origin"\s*\]/im.test(config);
  } catch {
    return null;
  }
}

/** The origin URL as `git config --get remote.origin.url` would print it, read from the repository's config file; null for anything unusual. */
function originFromConfig(config: string): string | null {
  if (/^\s*\[\s*(include|worktree)|^\s*(bare\s*=\s*true|worktree\s*=)/im.test(config)) return null; // includes and odd layouts: let git answer
  let inOrigin = false;
  let url: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\s\]"]+)(?:\s+"([^"\\]*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    const value = inOrigin ? /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1] : undefined;
    if (value === undefined) continue;
    if (/["#;]/.test(value)) return null; // quoting and comments: let git answer
    const marked = value.replace(/\\\\/g, "\u0001"); // git stores a backslash (a Windows path) doubled
    if (marked.includes("\\")) return null; // any other escape: let git answer
    url = marked.replace(/\u0001/g, "\\");
  }
  return url;
}

/** Repository identity without launching git: only for a checkout with an origin URL in a plain config file. */
function resolveFast(checkout: string): { info: RepoInfo; config: string } | null {
  try {
    const gitDir = gitDirOf(checkout);
    if (!gitDir) return null;
    const common = fs.statSync(path.join(checkout, ".git")).isDirectory() ? gitDir : path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    const config = path.join(common, "config");
    const origin = originFromConfig(fs.readFileSync(config, "utf8"));
    if (!origin) return null;
    const root = onDisk(checkout);
    return { info: { id: normalizeRemote(origin), root, label: path.basename(root) }, config };
  } catch {
    return null;
  }
}

function resolveRepo(checkout: string, disk: Record<string, DiskEntry>): RepoInfo | null {
  const fast = resolveFast(checkout);
  const fastMtime = fast && mtime(fast.config);
  if (fast && fastMtime !== null) {
    writeDiskCache({ ...disk, [checkout]: { info: fast.info, config: fast.config, mtimeMs: fastMtime } });
    return fast.info;
  }
  let info: RepoInfo | null = null;
  const out = git(checkout, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (out) {
    const [top, commonDir] = out.split(/\r?\n/);
    const root = onDisk(top); // same form as the file paths compared against it
    const origin = git(checkout, ["config", "--get", "remote.origin.url"]);
    const mainCheckout = path.dirname(path.resolve(commonDir));
    info = { id: origin ? normalizeRemote(origin) : normalizeLocal(mainCheckout), root, label: path.basename(root) };
    const config = path.join(path.resolve(commonDir), "config");
    const mtimeMs = mtime(config);
    if (mtimeMs !== null) writeDiskCache({ ...disk, [checkout]: { info, config, mtimeMs } });
  }
  return info;
}

function normalizeLocal(dir: string): string {
  const p = dir.split(path.sep).join("/");
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Multiplayer team context is one committed switch per repository: `.lanes/team.json` with `{"context": true}` (ADR-0028). */
export function teamContextOn(root: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".lanes", "team.json"), "utf8")).context === true;
  } catch {
    return false;
  }
}
