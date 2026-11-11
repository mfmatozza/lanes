# ADR-0015: Lease handoff requires sync (version-aware leases)

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Spike report](../research/spike-report.md#key-finding-leases-serialize-editing-but-worktrees-still-diverge), [ADR-0006](0006-file-level-leases-with-ttl.md), [ADR-0014](0014-positioning-intent-visibility.md)

## Context
The spike showed that file leases stop *simultaneous* edits. They don't stop merge conflicts when agents work in separate worktrees. After agent A releases `routes.ts`, agent B gets the lease, but it edits its own copy, which is missing A's change. Merging then conflicts (S1: 2 of 3 runs; S2: 5 conflicting merges).

## Decision (proposed)
Make leases **version-aware**:
1. **On release**, the server records the file's latest version: the commit SHA of the holder's last change to that path. The holder's change must be committed and published, meaning pushed to or merged into the integration branch, before the lease is fully released. Until then the lease stays in a **"releasing"** state.
2. **On acquire**, the hook sends the version of the file in the requester's checkout. If that's older than the recorded version, the server **denies with a sync instruction** that tells the agent exactly how to bring in the change.
3. **Optional auto-sync:** if the sync is a clean fast-forward or rebase, the hook can do it itself before allowing the edit.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Version-aware leases (proposed)** | Fixes the conflicts the spike found; builds on our existing hooks; leads naturally to the merge queue | More protocol and git logic; release now depends on integration |
| All agents share one checkout, without worktrees | Edits happen one after another on the same files, so no divergence | Agents interfere with each other's builds, tests and half-finished work; worktrees are the norm |
| Leases only warn; conflicts are left to merge time | Simple | Doesn't solve the problem; weak value proposition |

## Consequences
- The MVP grows: the hook needs git operations, and the protocol needs a file `version` field.
- "Merge to main often" becomes part of the product flow, which fits the future verified merge queue.
- This needs the founder's acceptance before the MVP starts.
