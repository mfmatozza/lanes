# ADR-0016: Coordination happens in the background and never interrupts the user

- **Status:** Accepted, amended 2026-10-24 (items 1, 2 and 4)
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Spike report](../research/spike-report.md), [ADR-0015](0015-lease-handoff-requires-sync.md), [UX principles](../product/ux-principles.md)

## Context
In the spike, 4 of 13 denied agents stopped and told their user "another agent holds this file". That puts Lanes in the user's face. The founder's requirement: *"all those decisions and timings to be taken in the background without blocking the user's prompts… everything needs to be quite smooth."*

## Decision
1. **Queue instead of deny.** When a file is held, the `PreToolUse` hook **waits quietly** in a fair first-come, first-served queue on the server, for up to **90 s** (amended: **240 s**, then the edit goes ahead). Meanwhile Claude Code shows a status line: *"Lanes: coordinating with teammates…"*. When the lease frees up, the edit simply goes ahead.
2. **Shorter leases.** A lease lasts for **one agent turn** (amended: **one edit**). It's released when the edit is published, right after the commit and push ([ADR-0015](0015-lease-handoff-requires-sync.md)). Spike v2 showed that turn-long leases still queued for minutes and risked deadlock. Queues therefore move in seconds, not minutes.
3. **Silent sync.** On handoff, the hook brings the previous holder's changes into the agent's copy automatically. If the file changed under the agent, the agent is asked to re-read it (agent-facing only).
4. **The agent-facing text never says "stop" or "tell the user".** (Amended: when the wait runs out the edit simply goes ahead, and the agent is told nothing. See [ADR-0019](0019-never-refuse-an-edit.md).)
5. **The user sees Lanes only through:** the status line while waiting, the VS Code views, and notifications for real exceptions (sync failure, server down).

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Wait in a queue (chosen)** | Smooth; no user-visible refusals; fair order | Agent sits idle while waiting; risk of deadlock between two holders (bounded by the 90 s timeout) |
| Deny and let the agent re-plan (spike v1) | Agent can keep working | 31% of agents stopped and asked the user |
| Leases held until the session ends | Fewer handoffs | Long waits; this caused most of the spike's queuing |

## Consequences
- The server needs long-poll requests and per-file queues.
- Hook `timeout` goes up to 300 s for `PreToolUse` (amended from 150 s).
- The success metric changes: **0 user-visible interruptions caused by Lanes.**
