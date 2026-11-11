// GitHub Copilot native hooks: `.github/hooks/lanes.json` (S3.5), read by Copilot CLI, VS Code and the Copilot app
// (https://docs.github.com/en/copilot/reference/hooks-reference, read 2026-11-02).
import { isLanesHook, withoutLanesCursorHooks, type HookHandler } from "../settings.ts";
import { relativeHookCommand, type FileAdapter } from "./adapter.ts";

/**
 * camelCase events, so the payload is Copilot's own (`sessionId`, `toolName`, `toolArgs`). Shape: `{version: 1, hooks:
 * {event: [{type, command, cwd, timeoutSec, matcher}]}}`; `command` is copied to `bash` and `powershell`, `cwd` is relative
 * to the repository root. No preToolUse: there any non-zero exit denies the edit and so does a PowerShell parse error, and
 * the hook would only print nothing (ADR-0019), so Copilot edits are coordinated after the fact, like Cursor's.
 * userPromptSubmitted output is ignored by Copilot: the prompt hook records the task and prints nothing.
 * shortcut: the edit tools' argument names are undocumented (the hook reads path, file_path or filePath); edits it can't
 * place are published at agentStop. Re-check against a real Copilot.
 */
export function withLanesCopilotHooks(file: Record<string, any>): Record<string, any> {
  const handler = (event: string, timeoutSec: number, matcher?: string): HookHandler => ({ type: "command", command: relativeHookCommand(event, "copilot"), cwd: ".", timeoutSec, ...(matcher && { matcher }) });
  const ours: Record<string, HookHandler[]> = {
    sessionStart: [handler("start", 5)],
    userPromptSubmitted: [handler("prompt", 15)],
    postToolUse: [handler("post", 40, "^(edit|create)$")],
    agentStop: [handler("stop", 90)],
    sessionEnd: [handler("end", 5)],
  };
  const hooks: Record<string, HookHandler[]> = { ...file.hooks };
  for (const [event, list] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []).filter((h) => !isLanesHook(h)), ...list];
  return { ...file, version: file.version ?? 1, hooks };
}

export const copilotAdapter: FileAdapter = {
  agent: "copilot",
  file: ".github/hooks/lanes.json",
  add: withLanesCopilotHooks,
  remove: (json) => (Object.values((json.hooks ?? {}) as Record<string, HookHandler[]>).some((l) => l.some(isLanesHook)) ? withoutLanesCursorHooks(json) : undefined),
  note: "Copilot: each edit is published right after it is made (Copilot denies an edit when a preToolUse hook fails, so Lanes does not use one and cannot queue Copilot's edits behind a teammate's). The hooks do nothing in the Copilot cloud agent. The Claude Code hooks stay inert inside Copilot.",
  // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
  mcp: (cli) => `copilot mcp add lanes -- node "${cli}" mcp`,
};
