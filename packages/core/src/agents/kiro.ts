// Kiro agent hooks: `.kiro/hooks/lanes.json` (S3.5), for the Kiro IDE and CLI V3 (https://kiro.dev/docs/hooks/, read 2026-11-02).
import { isLanesHook } from "../settings.ts";
import { relativeHookCommand, type FileAdapter } from "./adapter.ts";

interface KiroHook {
  name?: string;
  trigger?: string;
  matcher?: string;
  action?: { type?: string; command?: string };
  [key: string]: unknown;
}
const ours = (h: KiroHook) => h.action?.type === "command" && isLanesHook({ type: "command", command: h.action.command });

/**
 * `{version: "v1", hooks: [{name, trigger, matcher, action: {type: "command", command}, timeout (s)}]}`; command actions run in
 * the project root. No PreToolUse: a non-zero exit blocks the tool there (which exit codes do is stated differently on
 * different pages), so Kiro edits are coordinated after the fact. PostToolUse on the `write` group and Stop cannot block.
 * Stdout of an exit-0 command is added to the agent's context, so the hook prints plain text, never JSON.
 * shortcut: the write tools' `tool_input` path field is undocumented (the hook tries path, file_path, operations[].path);
 * edits it can't place are published at Stop. Not run against a real Kiro; the shell it uses on Windows is undocumented.
 */
export function withLanesKiroHooks(file: Record<string, any>): Record<string, any> {
  const hook = (name: string, trigger: string, event: string, timeout: number, matcher?: string): KiroHook => ({
    name: `Lanes: ${name}`,
    trigger,
    ...(matcher && { matcher }),
    action: { type: "command", command: relativeHookCommand(event, "kiro") },
    timeout,
  });
  const kept = ((file.hooks ?? []) as KiroHook[]).filter((h) => !ours(h));
  return {
    ...file,
    version: file.version ?? "v1",
    hooks: [
      ...kept,
      hook("session start", "SessionStart", "start", 5),
      hook("prompt", "UserPromptSubmit", "prompt", 15),
      hook("publish edit", "PostToolUse", "post", 40, "write"),
      hook("publish turn", "Stop", "stop", 90),
    ],
  };
}

export const kiroAdapter: FileAdapter = {
  agent: "kiro",
  file: ".kiro/hooks/lanes.json",
  add: withLanesKiroHooks,
  remove(json) {
    const list = (json.hooks ?? []) as KiroHook[];
    if (!Array.isArray(list) || !list.some(ours)) return undefined;
    const kept = list.filter((h) => !ours(h));
    const { hooks: _old, version, ...rest } = json;
    return kept.length > 0 ? { ...rest, version, hooks: kept } : rest;
  },
  note: "Kiro: each edit is published after it is made, and the rest at the end of the turn; Kiro blocks a tool when a pre-tool hook fails, so Lanes does not use one and cannot queue Kiro's edits behind a teammate's.",
  // https://kiro.dev/docs/mcp/configuration/: no add command, only mcp.json.
  mcp: (cli) => `Kiro: add to ~/.kiro/settings/mcp.json: ${JSON.stringify({ mcpServers: { lanes: { command: "node", args: [cli, "mcp"] } } })}`,
};
