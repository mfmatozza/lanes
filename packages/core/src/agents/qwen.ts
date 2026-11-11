// `.qwen/settings.json` for Qwen Code: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md (read 2026-11-02).
// Claude's shape, event names (PermissionRequest included), stdin fields and hookSpecificOutput; edit tools write_file and edit,
// both with tool_input.file_path. Project hooks load only in a trusted folder. Not run against a real Qwen Code.
// Removal is withoutLanesHooks, as for Claude's settings.
import { ROOT_SCRIPT, withLanesHooks, type ClaudeSettings } from "../settings.ts";

/** shortcut: the default shell is undocumented (a `shell` field exists); `$(...)` and `; exit 0` parse in bash and PowerShell. */
export const withLanesQwenHooks = (settings: ClaudeSettings): ClaudeSettings => withLanesHooks(settings, "node", ROOT_SCRIPT, false, "write_file|edit");
