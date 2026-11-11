# Testing strategy

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Engineering › Testing strategy · [← Repository structure](repository-structure.md) · [Release process →](release-process.md)

## Test pyramid

| Level | What | Tooling | Runs |
|---|---|---|---|
| **Unit** | Coordinator lease rules L1–L9 (with an injected clock), repo ID normalization, settings merging | `node --test` | Every PR |
| **Integration** | HTTP and WebSocket server; hook script against a real server and a temporary git repo with a worktree | `node --test` + temporary directories | Every PR, on Windows, macOS and Linux |
| **Extension** | Activation, commands, tree contents against a fake server | `@vscode/test-electron` | Every PR (Linux, using xvfb) |
| **End-to-end** | Real Claude Code sessions with hooks installed: Journey 2 (collision prevented) | Scripted `claude -p` runs | Nightly, plus before each release |
| **Manual** | UX review of the views and warnings | Checklist in the release issue | Each release |

## Must-have test cases
- Every [lease rule](../architecture/coordination-model.md#3-lease-rules) has at least one test.
- The same file reached through a worktree and through the main checkout gives the same lease.
- Windows paths: drive-letter case, backslashes, paths with spaces.
- A file that doesn't exist yet (a `Write` creating a new file) still resolves to its repository.
- Hook: server down → exit 2 with a message. With `failOpen`, exit 0. A deny prints valid JSON.
- Merging settings is idempotent and keeps hooks that aren't ours.
- Denial reasons are cleaned (no control characters or backtick injection).

## Compatibility matrix
- **Node:** 22 LTS, 24.
- **OS:** Windows 10/11, macOS (latest), Ubuntu LTS.
- **VS Code:** minimum supported (1.95) and stable.
- **Claude Code:** the minimum version that supports `onFailure` (2.1.295), and the latest.
