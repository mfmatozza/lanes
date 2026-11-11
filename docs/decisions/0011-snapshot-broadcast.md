# ADR-0011: Broadcast full state snapshots

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Protocol](../architecture/protocol.md)

## Context
Editors need live state. The state is small: tens of agents and hundreds of leases per team, which is a few kilobytes. Sending only the changes (deltas) would need sequence numbers, logic to replay missed changes on reconnect, and careful ordering.

## Decision
After any change, the server pushes the **full snapshot** over WebSocket, at most once every 50 ms, and once more when a client connects.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Full snapshots (chosen)** | Trivial client logic; reconnects are automatically consistent | Wasted bandwidth as state grows |
| Event deltas | Efficient | More complex; reconnect and ordering bugs |
| Clients poll `/v1/state` | Simplest | Laggy; wasted load |

## Consequences
- Revisit when a team's snapshot exceeds about 100 KB or there are more than about 50 clients. Switch to deltas with a version number.
