# ADR-0007: Fail closed when the server is unreachable

- **Status:** Superseded by [ADR-0019](0019-never-refuse-an-edit.md)
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza

## Context
If the hook can't reach the server, it can either allow the edit (fail open) or block it (fail closed). By default, a Claude Code hook that times out or errors does **not** block the tool call. That would quietly switch off coordination.

## Decision
- **Fail closed by default.** The `PreToolUse` hook uses `onFailure: "block"` and exits with code 2, with a clear explanation telling the agent how to recover.
- Users can opt in to failing open with `failOpen: true` in `~/.lanes/config.json` or `LANES_FAIL_OPEN=1`.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Fail closed (chosen)** | No collisions slip through unnoticed; trustworthy | Annoying when the server is down; risk of uninstalls (R7) |
| Fail open | Never gets in the way | Coordination silently disappears |

## Consequences
- The extension must make server health very visible and easy to fix (status bar, a one-click restart).
- Only repositories that have been set up are affected, so solo projects aren't touched.
