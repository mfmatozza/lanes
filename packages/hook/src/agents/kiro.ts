// Kiro payloads and outputs (S3.5): https://kiro.dev/docs/hooks/types/ and /docs/hooks/actions/, read 2026-11-02.
import type { HookInput } from "../hook.ts";

/**
 * Kiro's payload is Claude-shaped (`session_id`, `cwd`, `tool_name`, `tool_input`); the prompt is in env `USER_PROMPT`.
 * shortcut: where a write tool puts its path is undocumented (the official read example uses `operations[].path`); this
 * tries `path`, `file_path`, then the first operation. Edits it can't place are published at Stop.
 */
export function fromKiro(raw: Record<string, any>, env: NodeJS.ProcessEnv = process.env): HookInput {
  const input = raw.tool_input && typeof raw.tool_input === "object" ? raw.tool_input : {};
  const op = Array.isArray(input.operations) ? input.operations[0] : undefined;
  const file = [input.path, input.file_path, op?.path].find((p) => typeof p === "string" && p !== "");
  return {
    session_id: raw.session_id,
    cwd: raw.cwd,
    prompt: raw.prompt ?? env.USER_PROMPT,
    ...(raw.tool_name && file && { tool_name: String(raw.tool_name), tool_input: { file_path: file } }),
  };
}

/** Exit-0 stdout becomes agent context as is: plain text, on the events Lanes registers. */
export function kiroContext(hookEventName: string, text: string): string | undefined {
  return ["SessionStart", "UserPromptSubmit", "PostToolUse"].includes(hookEventName) ? text : undefined;
}
