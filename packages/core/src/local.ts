// Per-user private state: the hook's caches and the local server's token.
// Security review (spike v3c): a shared /tmp/lanes-hook let another local user poison the repository cache
// (making the hook run git in a folder they control) or plant symlinks the hook would write through.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The one place that decides where per-user Lanes files live: LANES_HOME, else ~/.lanes (config, token, cache, sessions). */
export function lanesHome(): string {
  return process.env.LANES_HOME ?? path.join(os.homedir(), ".lanes");
}

/** ~/.lanes/<sub>, created private (0700) and refused if it is a symlink or someone else's. A looser mode is tightened. */
export function privateDir(...sub: string[]): string {
  const dir = path.join(lanesHome(), ...sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`${dir} is not a private directory owned by this user`);
  }
  // A folder left group/world-writable (older tool, bad umask) would let another user swap the token or the cache (#91).
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readToken(file: string): string | null {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token && process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    return token || null;
  } catch {
    return null;
  }
}

/** The token the local server requires: LANES_TOKEN, else ~/.lanes/token, created (0600) on first use. Never empty. */
export function loadOrCreateToken(): string {
  if (process.env.LANES_TOKEN) return process.env.LANES_TOKEN;
  const file = path.join(privateDir(), "token");
  const existing = readToken(file);
  if (existing) return existing;
  // Written to a temp file and linked into place, so no process can ever read a half-written token (#87).
  const token = crypto.randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try {
    // Links are atomic and complete, so a file that exists and is empty can only be a leftover of an older version.
    if (fs.existsSync(file) && fs.statSync(file).size === 0) fs.renameSync(tmp, file);
    else fs.linkSync(tmp, file); // fails if another process just made one: that one wins
  } catch {
    // lost the race, or the filesystem has no hard links (then rename; the last writer wins)
    if (!fs.existsSync(file)) fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  for (let i = 0; i < 40; i++) {
    const winner = readToken(file);
    if (winner) return winner;
    sleepSync(25);
  }
  return token;
}

/** True unless the process is certainly gone (EPERM means it exists but is not ours). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock whose recorded owner process has died (killed by a hook timeout, kill -9, power loss) is free at once (#110). */
function ownerGone(dir: string): boolean {
  try {
    const read = () => Number(fs.readFileSync(path.join(dir, "owner"), "utf8"));
    const pid = read();
    // Read again after the check: a live owner can release and exit between the two, and a new owner can then be in the
    // directory. A dead process cannot release, so an unchanged owner is the dead one's (#141).
    return Number.isInteger(pid) && pid > 0 && !alive(pid) && read() === pid;
  } catch {
    return false; // no owner recorded yet (being created) or an older lock: only its age counts
  }
}

/**
 * Deletes a lock directory in one atomic step (rename aside, then delete). Deleting it in place empties it before
 * removing it, and on Linux and macOS a rename onto an empty directory succeeds: a new owner could then take the lock
 * in that gap and the old release would fail or delete it (#141).
 */
function removeLock(dir: string): void {
  const aside = `${dir}.del-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(dir, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // gone already
    // Windows refuses to rename a directory while another process has a file in it open (a waiter reading `owner`): delete it
    // in place, with retries, rather than leave the lock held for good.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      // still held: the owner's pid will be dead soon enough, and a waiter takes it over then
    }
    return;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch {
    // a leftover `.del-*` folder is harmless
  }
}

/**
 * Frees a lock whose owner is gone. Takers go one at a time through a short-lived gate, and judge the lock inside it: a
 * dead owner's directory can only be changed by a taker (ownerGone re-reads the owner to be sure it is the dead one's).
 * Judging first and deleting later let a waiter delete a live lock under load, so two publishes ran in one checkout and
 * a file was left staged but never committed (#141).
 */
function takeOverIfDead(dir: string, staleMs: number): void {
  const gate = `${dir}.take`;
  try {
    fs.mkdirSync(gate);
  } catch {
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs > 5_000) fs.rmSync(gate, { recursive: true, force: true }); // a taker that was killed
    } catch {
      // gone already
    }
    return;
  }
  try {
    if (ownerGone(dir) || Date.now() - fs.statSync(dir).mtimeMs > staleMs) removeLock(dir);
  } catch {
    // gone already: try again
  } finally {
    fs.rmSync(gate, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` while holding a lock named `name` (a directory under ~/.lanes/locks; mkdir is atomic everywhere).
 * Fails open (ADR-0019): after `waitMs` it runs anyway, and a lock whose owner process is gone, or that is older than
 * `staleMs`, is taken over. shortcut: a reused pid keeps a dead owner's lock alive until `staleMs`. Used to serialise per-session state and per-checkout publishing (#83).
 */
export async function withLock<T>(name: string, fn: () => Promise<T> | T, waitMs = 5_000, staleMs = 90_000): Promise<T> {
  let lock: string | null = null;
  try {
    const dir = path.join(privateDir("locks"), name.replace(/[^\w-]/g, "_"));
    for (const started = Date.now(); ; ) {
      try {
        // Built aside with its owner inside, then renamed into place: the lock never exists without its owner, and the
        // rename fails while another non-empty lock is there (#141).
        const mine = `${dir}.new-${process.pid}-${Date.now()}`;
        fs.mkdirSync(mine);
        try {
          fs.writeFileSync(path.join(mine, "owner"), String(process.pid));
          fs.renameSync(mine, dir);
        } catch (err) {
          fs.rmSync(mine, { recursive: true, force: true });
          throw err;
        }
        lock = dir;
        break;
      } catch {
        takeOverIfDead(dir, staleMs);
        if (Date.now() - started > waitMs) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  } catch {
    // no private folder: run unlocked rather than not at all
  }
  try {
    return await fn();
  } finally {
    if (lock) removeLock(lock);
  }
}

export interface Config {
  serverUrl: string;
  user?: string;
  email?: string;
  token?: string;
}

/** Hook and CLI configuration: environment, then ~/.lanes/config.json, then defaults (#129: one resolution for all). */
export function loadConfig(): Config {
  let file: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lanesHome(), "config.json"), "utf8"));
    if (parsed && typeof parsed === "object") file = parsed;
  } catch {
    // No per-user config: environment and defaults apply.
  }
  // A hand-edited `null` or a number in the file crashed every hook and command: only non-empty strings count.
  const text = (key: string) => (typeof file[key] === "string" && file[key] ? (file[key] as string) : undefined);
  return {
    serverUrl: (process.env.LANES_SERVER ?? text("serverUrl") ?? "http://127.0.0.1:4317").replace(/\/+$/, ""),
    user: process.env.LANES_USER ?? text("user"),
    email: process.env.LANES_EMAIL ?? text("email"),
    token: process.env.LANES_TOKEN ?? text("token"),
  };
}

/** Merges the given fields into ~/.lanes/config.json (private, 0600): the one place the CLI and the extension store a server and token (#123). */
export function writeUserConfig(fields: { serverUrl?: string | null; user?: string | null; token?: string | null }): void {
  const file = path.join(privateDir(), "config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {
    // First run.
  }
  // A string sets the field, null removes it, undefined leaves it alone.
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete config[key];
    else if (value) config[key] = key === "serverUrl" ? value.replace(/\/+$/, "") : value;
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600); // an older, looser file keeps its mode on rewrite
}

export const isLoopback = (url: string): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

/** True for a server on this machine, including when it is reached by its LAN address or host name (#123). */
export function isLocalServer(url: string): boolean {
  let host: string;
  try {
    if (isLoopback(url)) return true;
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  const me = os.hostname().toLowerCase();
  if (host === me || host === `${me}.local`) return true;
  return Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((a) => a.address.toLowerCase() === host));
}

/** The token for `config.serverUrl`: the configured one, else this machine's own token when the server is on this machine. */
export function tokenFor(config: Config): string | undefined {
  return config.token ?? (isLocalServer(config.serverUrl) ? loadOrCreateToken() : undefined);
}
