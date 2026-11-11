// Merges the Lanes hooks into a Claude Code settings object without touching other hooks.

export interface HookHandler {
  type: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookHandler[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

const LANES_MARKER = "--lanes";
const EDIT_TOOLS = "Edit|Write|MultiEdit|NotebookEdit";
// Codex reports every file edit as `apply_patch` (its `Edit`/`Write` matchers are aliases of it): https://developers.openai.com/codex/hooks
const CODEX_EDIT_TOOLS = "apply_patch";
// The script from the git root, for agents without Claude's project-dir variable: neither documents its hooks' working
// directory as the repository root. `$(...)` is command substitution in bash and sh and a subexpression in PowerShell.
export const ROOT_SCRIPT = "$(git rev-parse --show-toplevel)/.lanes/hook.cjs";

/**
 * The hook as a shell command line, not an exec-form {command, args} pair (#126). Claude Code runs a command without
 * `args` through the shell, so a missing `node` (not on PATH, a stale absolute path, another OS) ends in
 * `exit 0` instead of Claude's visible "Executable not found" hook error on every event.
 * `; exit 0` rather than `2>/dev/null || exit 0`: it parses the same in bash, sh, Windows PowerShell 5.1 and PowerShell 7.
 * Copilot reads .claude/settings.json too, runs commands through PowerShell on Windows and denies an edit on any non-zero
 * exit of a pre-edit hook; `||` is a parse error in PowerShell 5.1 (multiplayer/research/agent-integration.md, Round 2).
 * There `${CLAUDE_PROJECT_DIR}` is an empty PowerShell variable, so the hook doesn't start and the line still exits 0:
 * inert, never a refusal.
 * `--lanes` marks our entries exactly (the hook ignores it), so other tools' hooks are never touched.
 * shortcut: an absolute node (settings.local.json, node not on PATH) starts with a quoted path, which PowerShell won't
 * run without `&` (and bash won't run with it); Copilot on Windows without node on PATH would refuse edits. Fix if seen.
 */
function hookCommand(node: string, script: string, event: string, agent = ""): string {
  const exe = node === "node" ? "node" : `"${node.replace(/\\/g, "/")}"`;
  return `${exe} --no-warnings "${script}" ${event} ${LANES_MARKER}${agent && " " + agent}; exit 0`;
}

/**
 * @param node  executable that runs the hook: "node" in the committed settings; an absolute path only in a user's own, git-ignored settings.local.json
 * @param script  hook script path, e.g. "${CLAUDE_PROJECT_DIR}/.lanes/hook.cjs"
 * @param observeShell  spike-only: also report Bash commands, to detect workarounds
 * @param editTools  matcher for the agent's file-edit tools
 */
export function withLanesHooks(settings: ClaudeSettings, node: string, script: string, observeShell = false, editTools = EDIT_TOOLS): ClaudeSettings {
  const handler = (event: string, extra: Record<string, unknown> = {}): HookHandler => ({
    type: "command",
    command: hookCommand(node, script, event),
    ...extra,
  });
  const ours: Record<string, HookMatcher[]> = {
    UserPromptSubmit: [{ hooks: [handler("prompt", { timeout: 15 })] }],
    PreToolUse: [
      {
        matcher: editTools,
        // Waits quietly in the server's queue when a teammate's agent holds the file (ADR-0016).
        hooks: [handler("pre", { timeout: 300, statusMessage: "Lanes: coordinating with teammates…" })],
      },
      // Team context only (the hook exits at once otherwise): a heads-up when the agent reads a file a teammate is changing (M.2).
      // shortcut: Claude Code's Read tool only; other agents' read tools are a follow-up.
      ...(editTools === EDIT_TOOLS ? [{ matcher: "Read", hooks: [handler("read", { timeout: 5 })] }] : []),
      ...(observeShell ? [{ matcher: "Bash", hooks: [handler("observe", { timeout: 5 })] }] : []),
    ],
    // Fires when the user is asked to approve an edit: keeps the lease alive while they decide.
    PermissionRequest: [{ matcher: editTools, hooks: [handler("permission", { timeout: 5 })] }],
    // Commit hooks (husky, scanners) and a push over a real network run in here: the publish stops waiting for them
    // after 12 s and sends the lease release first (#81).
    PostToolUse: [{ matcher: editTools, hooks: [handler("post", { timeout: 40 })] }],
    SessionStart: [{ hooks: [handler("start", { timeout: 5 })] }],
    Stop: [{ hooks: [handler("stop", { timeout: 90 })] }],
    SessionEnd: [{ hooks: [handler("end", { timeout: 5 })] }],
  };

  return mergeHooks(settings, ours);
}

/** Our matchers replace any earlier Lanes entries of each event; everyone else's hooks stay in place. */
function mergeHooks(settings: ClaudeSettings, ours: Record<string, HookMatcher[]>): ClaudeSettings {
  const hooks: Record<string, HookMatcher[]> = { ...settings.hooks };
  for (const [event, matchers] of Object.entries(ours)) {
    const kept = (hooks[event] ?? [])
      .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isLanesHook(h)) }))
      .filter((m) => m.hooks.length > 0);
    hooks[event] = [...kept, ...matchers];
  }
  return { ...settings, hooks };
}

/**
 * The same hooks for a repository's `.codex/hooks.json`, which has Claude's shape, event names and output fields. Codex has no
 * project-dir variable and runs hooks in the session cwd, so the script is found from the git root, as its docs suggest.
 * Removal is withoutLanesHooks. The hook never outputs `permissionDecision` (Codex fails the hook run on `ask`).
 * shortcut: the shell Codex uses on Windows is undocumented (`commandWindows` exists); this bash form is unverified there.
 */
export function withLanesCodexHooks(settings: ClaudeSettings): ClaudeSettings {
  return withLanesHooks(settings, "node", ROOT_SCRIPT, false, CODEX_EDIT_TOOLS);
}
// Gemini CLI's file-edit tools (https://geminicli.com/docs/reference/tools/); both take `file_path`.
const GEMINI_EDIT_TOOLS = "write_file|replace";

/**
 * The hooks for a repository's `.gemini/settings.json` (https://geminicli.com/docs/hooks/reference/): Claude's shape, Gemini's
 * event names, timeouts in milliseconds. `gemini` after `--lanes` tells the hook which payload and output fields to use.
 * Gemini has no PermissionRequest event, so no lease is held while the user confirms a write.
 * shortcut: the shell Gemini CLI runs hooks with is undocumented (Windows above all); this bash form is unverified there.
 */
export function withLanesGeminiHooks(settings: ClaudeSettings): ClaudeSettings {
  const handler = (event: string, timeout: number): HookHandler => ({ type: "command", command: hookCommand("node", ROOT_SCRIPT, event, "gemini"), timeout });
  return mergeHooks(settings, {
    SessionStart: [{ hooks: [handler("start", 5_000)] }],
    BeforeAgent: [{ hooks: [handler("prompt", 15_000)] }],
    BeforeTool: [{ matcher: GEMINI_EDIT_TOOLS, hooks: [handler("pre", 300_000)] }],
    AfterTool: [{ matcher: GEMINI_EDIT_TOOLS, hooks: [handler("post", 40_000)] }],
    AfterAgent: [{ hooks: [handler("stop", 90_000)] }],
    SessionEnd: [{ hooks: [handler("end", 5_000)] }],
  });
}

/** `.cursor/hooks.json`: `{version, hooks: {event: [{command, timeout, ...}]}}`, one flat list of handlers per event. */
export interface CursorHooks {
  version?: number;
  hooks?: Record<string, HookHandler[]>;
  [key: string]: unknown;
}

/**
 * The hooks for `.cursor/hooks.json` (https://cursor.com/docs/hooks). preToolUse is left out: it is a permission hook, where
 * an empty or unexpected reply blocks the edit, and the one reply sure to let it through, `permission: "allow"`, would skip
 * the user's own approval (ADR-0019: never a permission decision). So Cursor edits are coordinated after the fact, at
 * afterFileEdit. No shell redirection: the desktop app runs hooks through PowerShell on Windows, where `$(...)` works too.
 * shortcut: not run against a real Cursor; check the command under PowerShell 5.1 and on macOS before claiming support.
 */
export function withLanesCursorHooks(file: CursorHooks): CursorHooks {
  const handler = (event: string, timeout: number): HookHandler => ({ type: "command", command: `node --no-warnings "${ROOT_SCRIPT}" ${event} ${LANES_MARKER} cursor`, timeout });
  const ours: Record<string, HookHandler[]> = {
    sessionStart: [handler("start", 5)],
    beforeSubmitPrompt: [handler("prompt", 15)],
    afterFileEdit: [handler("post", 40)],
    stop: [handler("stop", 90)],
    sessionEnd: [handler("end", 5)],
  };
  const hooks = { ...file.hooks };
  for (const [event, list] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []).filter((h) => !isLanesHook(h)), ...list];
  return { ...file, version: file.version ?? 1, hooks };
}

/** `file` without any Lanes hook; empty events are dropped, and so is a `version` left on its own. */
export function withoutLanesCursorHooks(file: CursorHooks): CursorHooks {
  const hooks: Record<string, HookHandler[]> = {};
  for (const [event, list] of Object.entries(file.hooks ?? {})) {
    const kept = list.filter((h) => !isLanesHook(h));
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, version, ...rest } = file;
  if (Object.keys(hooks).length > 0) return { ...rest, version, hooks };
  return Object.keys(rest).length > 0 ? { ...rest, version } : {};
}

export function isLanesHook(handler: HookHandler): boolean {
  if (handler.args?.includes(LANES_MARKER)) return true; // exec form, written before #126
  return typeof handler.command === "string" && handler.command.includes("hook.cjs") && /\s--lanes(?![\w-])/.test(handler.command);
}

/** `settings` without any Lanes hook; empty events are dropped. */
export function withoutLanesHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const kept = matchers.map((m) => ({ ...m, hooks: m.hooks.filter((h) => !isLanesHook(h)) })).filter((m) => m.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}
