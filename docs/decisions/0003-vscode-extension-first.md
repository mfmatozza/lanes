# ADR-0003: VS Code extension as the first client

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza

## Context
We need one first editor client. VS Code and its forks (Cursor, Windsurf) have the largest share of developers. Microsoft has put Live Share into maintenance mode, so nobody is offering real-time multi-human features inside VS Code. Claude Code already integrates with VS Code.

## Decision
The first client is a **VS Code extension**, published to the VS Code Marketplace **and Open VSX** so that Cursor and Windsurf users can install it too.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **VS Code extension (chosen)** | Biggest audience; mature API; forks covered by Open VSX | API limits on custom UI |
| Zed extension | Aligned with ACP | Smaller audience; competes with Zed's own Delta |
| JetBrains plugin | Enterprise reach | Smaller agent-first audience today |
| Terminal UI only | Simplest | Weak at visualisation; not where users look at files |

## Consequences
- Requires VS Code ≥ 1.95. We test on VS Code stable and on Cursor.
- Zed and JetBrains clients are post-MVP and reuse the same protocol.
