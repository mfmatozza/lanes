# ADR-0006: File-level leases with a time-to-live

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Coordination model](../architecture/coordination-model.md)

## Context
Cursor reported that plain locks failed: "agents would hold locks for too long, or forget to release them," and 20 agents slowed to the throughput of 2–3. Claim Plane showed that checking each agent's declared intent improves correctness, but that declared scopes are always incomplete. We need something simple, safe and able to recover on its own.

## Decision
- An **exclusive lease per file**, taken **implicitly** on the first allowed edit.
- The lease is **renewed by each edit** and **expires after 10 minutes** of inactivity (the time-to-live, or TTL).
- It is released when the session ends, and any human can release it manually.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Implicit file leases with a TTL (chosen)** | Agents need no special behaviour; nothing stays locked forever; easy to explain | Coarse: two agents editing different functions in one file get blocked |
| Explicit claims (agents declare scope up front) | Better planning | Scopes are incomplete; needs cooperation from the agent |
| Symbol-level leases | Finer-grained | Needs parsing; more complex. **Planned for after the MVP** |
| Plain locks with no TTL | Simple | A crashed agent leaves the file locked forever |

## Consequences
- Some false blocking on large shared files (routers, config). We'll measure it as a counter-metric.
- The TTL value may need tuning per team.
