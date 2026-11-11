# ADR-0005: Enforce leases through Claude Code hooks

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Agent integration](../architecture/agent-integration.md)

## Context
For leases to mean anything, an agent's edit has to be checked *before* it happens. Claude Code's `PreToolUse` hook can deny a tool call with a reason the agent reads, and `onFailure: "block"` makes a hook that fails also block the call. These hooks are configured in `.claude/settings.json`, which can be committed to the repository.

## Decision
- Enforce leases with a **command hook** (`node .lanes/hook.cjs <event>`) on `PreToolUse` for the edit tools: `Edit`, `Write`, `MultiEdit` and `NotebookEdit`.
- Use further hooks to report activity and the session lifecycle.
- The hook never returns `allow`. It either denies or says nothing.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Command hook (chosen)** | Has local git access to work out file identity; reads per-user config; committed once for the whole team | Requires Node on `PATH` |
| `http` hook straight to the server | No script | Can't work out repo-relative paths or the repository ID; puts the server URL and identity in committed settings |
| An MCP tool the agent calls voluntarily | Cooperative | Not enforced, so agents can skip it |
| Wrapping or proxying the agent (Agent SDK) | Full control | We'd have to own the agent runtime; conflicts with bring-your-own-agent |

## Consequences
- Shell commands (Bash) that write files aren't covered. Worktrees are the backstop.
- We depend on the hook API staying stable. We pin and test Claude Code versions (risk R6).
