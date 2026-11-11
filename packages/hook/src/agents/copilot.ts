// GitHub Copilot payloads and outputs (S3.5): https://docs.github.com/en/copilot/reference/hooks-reference, read 2026-11-02.
import type { HookInput } from "../hook.ts";

// Documented file tools: `create` (new file) and `edit`.
const EDIT_TOOLS = new Set(["edit", "create"]);

/** The edited path in an edit tool's arguments, which Copilot may pass as an object or a JSON string. */
export function argsPath(args: unknown): string | undefined {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return undefined;
    }
  }
  if (!a || typeof a !== "object") return undefined;
  const o = a as Record<string, unknown>;
  // shortcut: the argument names are undocumented; these are the usual ones. Unplaced edits publish at agentStop.
  const p = o.path ?? o.file_path ?? o.filePath;
  return typeof p === "string" && p !== "" ? p : undefined;
}

/** Copilot's camelCase payload (`sessionId`, `cwd`, `prompt`, `toolName`, `toolArgs`) in Claude's field names. */
export function fromCopilot(raw: Record<string, any>): HookInput {
  const tool = raw.toolName ?? raw.tool_name;
  const file = EDIT_TOOLS.has(tool) ? argsPath(raw.toolArgs ?? raw.tool_input) : undefined;
  return {
    session_id: raw.sessionId ?? raw.session_id,
    cwd: raw.cwd,
    prompt: raw.prompt,
    ...(file && { tool_name: tool, tool_input: { file_path: file } }),
  };
}

/** Top-level additionalContext, on sessionStart and postToolUse only (userPromptSubmitted output is ignored). */
export function copilotContext(hookEventName: string, text: string): object | undefined {
  return hookEventName === "SessionStart" || hookEventName === "PostToolUse" ? { additionalContext: text } : undefined;
}

/**
 * A Claude-format (.claude/settings.json) hook run by Copilot, which reads those files too: its VS Code-compatible payload
 * has an ISO `timestamp` and no `transcript_path` outside Stop and PreCompact. Claude Code sends no `timestamp` and always a
 * `transcript_path`. Copilot's Stop slips through; a second turn-end publish finds nothing left to publish.
 */
export function isCopilotClaudeFormat(raw: Record<string, any>): boolean {
  return raw.timestamp !== undefined && raw.transcript_path === undefined;
}

/** The Copilot cloud agent (Linux runner) sets these; Lanes coordinates people's own checkouts only. */
export function isCopilotCloud(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GITHUB_COPILOT_API_TOKEN || env.COPILOT_AGENT_PROMPT);
}
