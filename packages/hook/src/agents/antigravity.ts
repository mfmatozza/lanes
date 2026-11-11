// Google Antigravity (app, IDE and `agy` CLI) hook payloads and output, from https://antigravity.google/docs/hooks (read 2026-11-02).
// Not run against a real Antigravity.

// The tools that write a file; each takes `TargetFile`. write_to_file writes the whole file, like Claude's Write.
export const ANTIGRAVITY_EDIT_TOOLS = "write_to_file|replace_file_content|multi_replace_file_content";

/**
 * camelCase stdin to Claude's field names: `conversationId` is the session, `toolCall: {name, args}` the tool call.
 * shortcut: the hooks' working directory is undocumented; the first of `workspacePaths` stands in for cwd (the edited path is absolute).
 */
export function fromAntigravity(raw: Record<string, any>): { session_id?: string; cwd?: string; tool_name?: string; tool_input?: { file_path?: string } } {
  const call = raw.toolCall ?? {};
  const file = typeof call.args?.TargetFile === "string" ? call.args.TargetFile : undefined;
  return {
    session_id: raw.conversationId,
    cwd: raw.workspacePaths?.[0],
    ...(typeof call.name === "string" && { tool_name: call.name === "write_to_file" ? "Write" : call.name, tool_input: { file_path: file } }),
  };
}

/**
 * Context only at SessionStart (`injectSteps`; PreToolUse and PostToolUse take none). The PreToolUse and Stop replies
 * (`decision` is required there) are echoed by the hook command itself, so they are printed even when node can't start.
 */
export function antigravityContext(hookEventName: string, text: string): object | undefined {
  return hookEventName === "SessionStart" ? { injectSteps: [{ ephemeralMessage: text }] } : undefined;
}
