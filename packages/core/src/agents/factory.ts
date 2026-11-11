// `.factory/hooks.json` for Factory Droid: https://docs.factory.com/reference/hooks-reference (read 2026-11-02).
// Claude's event names, stdin fields (session_id, cwd, tool_name, tool_input.file_path) and output (hookSpecificOutput), but the
// standalone file is the event map itself, with no `hooks` wrapper. Not run against a real Droid.
import { ROOT_SCRIPT, withLanesHooks, withoutLanesHooks, type HookMatcher } from "../settings.ts";

export type FactoryHooks = Record<string, HookMatcher[]>;

/**
 * Edit (partial) and Create (whole file, merged like Claude's Write). No PermissionRequest event in Droid.
 * shortcut: ApplyPatch is left out, its tool_input fields are undocumented (its files are published at Stop); the shell Droid
 * runs hooks with is undocumented, so the script is found with `$(git rev-parse --show-toplevel)` as for Codex.
 */
export function withLanesFactoryHooks(file: FactoryHooks): FactoryHooks {
  const { PermissionRequest: _none, ...hooks } = withLanesHooks({ hooks: withoutLanesFactoryHooks(file) }, "node", ROOT_SCRIPT, false, "Edit|Create").hooks!;
  return file.PermissionRequest ? { ...hooks, PermissionRequest: file.PermissionRequest } : hooks;
}

export const withoutLanesFactoryHooks = (file: FactoryHooks): FactoryHooks => withoutLanesHooks({ hooks: file }).hooks ?? {};
