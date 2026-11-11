# ADR-0004: Git is the source of truth; no CRDT for agent writes

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Research: architecture](https://github.com/mfmatozza/multiplayer-agent-ide-research/blob/main/docs/03-architecture.md)

## Context
Real-time editors use CRDTs or operational transformation so that every copy of a document ends up identical. For agents that isn't enough. A CRDT will happily merge two agents' simultaneous refactors into code that is consistent but broken. Agents also make large edits across many files after long pauses to think, which suits character-level syncing poorly. Zed's DeltaDB takes the CRDT route; the research found nothing published on how it handles semantic conflicts.

## Decision
- **Git stays the single source of truth.** Agents keep working in normal checkouts and worktrees.
- **Lanes prevents concurrent edits** (with leases) instead of merging them.
- Lanes doesn't sync file contents in the MVP.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Git plus leases (chosen)** | Simple; compatible with every existing tool and CI; no code leaves the machine | Not "live co-editing"; conflicts in different files can still happen |
| CRDT shared workspace (Yjs/Loro) | Live character-level collaboration | Merges are only textually correct; heavy to build; Zed already does it |
| Branch per agent plus automatic merge | Familiar | Detects conflicts too late, at merge time |

## Consequences
- We don't offer character-level live co-editing, which is a deliberate non-goal.
- A future merge queue builds on git as well.
