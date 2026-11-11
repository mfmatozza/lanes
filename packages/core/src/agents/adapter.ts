// A native hook adapter whose config is one repository file that Lanes owns (S3.5). The CLI reads and writes the file;
// these functions stay pure so they can be tested without a repository.

export interface FileAdapter {
  /** The name used with `lanes init --agents`. */
  agent: string;
  /** Repository-relative path of the file Lanes writes, POSIX separators. */
  file: string;
  /** `json` (the file's content, `{}` when missing) with our hooks in, earlier Lanes entries replaced, everyone else's kept. */
  add(json: Record<string, any>): Record<string, any>;
  /** `json` without our hooks: undefined when it held none, `{}` when nothing else is left (the file is then deleted). */
  remove(json: Record<string, any>): Record<string, any> | undefined;
  /** Printed after `init`. */
  note: string;
  /** How to add `lanes mcp` to this agent, given the CLI path. Printed only: user-level config is never edited. */
  mcp(cli: string): string;
}

/**
 * The hook as a command line with no shell syntax beyond `;`, run from the repository root (both adapters set or rely on
 * that working directory), so it parses in bash, sh, PowerShell 5.1/7 and cmd alike. ` ; exit 0` forces exit 0 where
 * `;` separates statements (bash, sh, PowerShell); cmd hands `;`, `exit`, `0` to node as extra arguments, which the
 * hook ignores, and the hook itself always exits 0. The space before `;` keeps the agent name a word of its own in cmd.
 */
export const relativeHookCommand = (event: string, agent: string) => `node --no-warnings .lanes/hook.cjs ${event} --lanes ${agent} ; exit 0`;
