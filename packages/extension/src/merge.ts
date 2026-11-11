// What "Review and merge" reads from git. Read-only on purpose: Lanes never merges, resets or rewrites anything for the user.
import { execFileSync } from "node:child_process";
import { safeRelPath } from "./model.ts";

const BRANCH = process.env.LANES_INTEGRATION ?? "lanes/main";
const git = (cwd: string, args: string[]): Buffer | null => {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
  } catch {
    return null;
  }
};

/** The shared branch as this checkout knows it (the remote's copy when there is one, else the local branch), or null. */
export function sharedRef(root: string): string | null {
  for (const ref of [`refs/remotes/origin/${BRANCH}`, `refs/heads/${BRANCH}`]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", ref]) !== null) return ref;
  }
  return null;
}

/** Files this checkout's branch changed since it left the shared branch: what has not been shared yet. */
export function unsharedFiles(root: string, ref: string): string[] {
  const out = git(root, ["diff", "--name-only", "-z", "--no-renames", `${ref}...HEAD`]);
  return (out?.toString("utf8").split("\0") ?? []).filter((p) => p !== "" && safeRelPath(p));
}

/** A file as the shared branch has it; empty when the shared branch does not have it yet. */
export function sharedContent(root: string, ref: string, path: string): Buffer {
  return git(root, ["show", `${ref}:${path}`]) ?? Buffer.alloc(0);
}
