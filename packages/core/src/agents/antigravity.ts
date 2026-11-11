// `.agents/hooks.json` for Google Antigravity (app, IDE and `agy` CLI): https://antigravity.google/docs/hooks (read 2026-11-02).
import { isLanesHook, type HookHandler } from "../settings.ts";

/** Top-level keys are hook names, each mapping event names to handlers (or, for tool events, `{matcher, hooks}` groups). */
export type AntigravityHooks = Record<string, unknown>;

const KEY = "lanes";
const TOOLS = "write_to_file|replace_file_content|multi_replace_file_content";
const SCRIPT = "$(git rev-parse --show-toplevel)/.lanes/hook.cjs";

/**
 * PreToolUse and Stop must answer with a `decision`; the reply is echoed after the hook, so it is there even when node is
 * missing or the hook fails. `allow` hands the call on to the next hook or the user's own policy: never an approval or a
 * refusal (ADR-0019). No PreInvocation hook: it fires before every model call and carries no prompt text.
 * shortcut: the shell and working directory Antigravity runs hooks with are undocumented; `$(...)` and `echo '...'` parse in
 * bash, sh and PowerShell. Check on a real Antigravity, Windows above all, before claiming support.
 */
export function withLanesAntigravityHooks(file: AntigravityHooks): AntigravityHooks {
  const handler = (event: string, timeout: number, reply = "; exit 0"): HookHandler => ({ type: "command", command: `node --no-warnings "${SCRIPT}" ${event} --lanes antigravity${reply}`, timeout });
  const allow = `; echo '{"decision":"allow"}'`;
  return {
    ...withoutLanesAntigravityHooks(file),
    [KEY]: {
      SessionStart: [handler("start", 5)],
      PreToolUse: [{ matcher: TOOLS, hooks: [handler("pre", 300, allow)] }],
      PostToolUse: [{ matcher: TOOLS, hooks: [handler("post", 40, "; echo '{}'")] }],
      Stop: [handler("stop", 90, allow)],
    },
  };
}

/** `file` without our entry. A `lanes` key holding someone else's hooks is left alone. */
export function withoutLanesAntigravityHooks(file: AntigravityHooks): AntigravityHooks {
  if (!hasLanesAntigravityHooks(file)) return file;
  const { [KEY]: _ours, ...rest } = file;
  return rest;
}

export function hasLanesAntigravityHooks(file: AntigravityHooks): boolean {
  const ours = file[KEY];
  if (!ours || typeof ours !== "object") return false;
  const handlers = Object.values(ours as Record<string, any[]>).flat().flatMap((h: any) => (Array.isArray(h?.hooks) ? h.hooks : [h]));
  return handlers.some((h: HookHandler) => h && isLanesHook(h));
}
