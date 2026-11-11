# ADR-0019: Never refuse an agent's edit

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** supersedes [ADR-0007](0007-fail-closed.md) · extends [ADR-0016](0016-non-blocking-coordination.md) · [Spike v3 report](../research/spike-v3-report.md)

## Context
The founder's requirement: a user may *see* Lanes working, as status lines like "Lanes: coordinating with teammates…". But a user must **never** have an edit refused and have to send the prompt again.

In spike v1, 31% of agents whose edit was refused stopped and asked their user. Spike v2 replaced refusals with a queue, but the hook still refused an edit in three cases:
1. a queue wait longer than 90 s;
2. a failed automatic sync;
3. an unreachable server (fail closed, [ADR-0007](0007-fail-closed.md)).

## Decision
The `PreToolUse` hook **never denies or blocks an edit**:

| Case | Before | Now |
|---|---|---|
| File held by a teammate's agent | Wait ≤ 90 s, then refuse | Wait ≤ 240 s, **then go ahead**. Real waits are seconds, because leases last one edit (spike v2 max: 40 s, at lease expiry) |
| Automatic sync fails | Refuse, "try again shortly" | **Go ahead.** The edit is committed locally, so it can't be lost; the team views flag it |
| Server unreachable | Block (exit 2) and tell the agent to ask the user to start the server | **Go ahead** with coordination paused. The VS Code status bar shows "Lanes: offline" with a one-click restart |
| Integration remote unreachable | — | Commit locally; push with the next publish |

Every "go ahead" is recorded for the team views (when the server itself is down, the views show "offline" instead). It is never shown in the agent's conversation.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Never refuse (chosen)** | Users never have to re-prompt; matches the founder's requirement | When the server is down, coordination silently stops for that agent, so collisions are possible until it's back |
| Keep fail closed (ADR-0007) | No collision can slip through | The user sees a blocked edit and must act. This is exactly what the founder ruled out |
| Refuse only when the server is down | Fewer refusals | Still a refusal. It would also be the most confusing kind, because it's about infrastructure and not about teammates |

## Consequences
- **Positive:** the only things a user ever sees from Lanes are status lines and the VS Code views.
- **Negative / trade-offs:** while the server is down, two agents can edit the same file. The damage is limited: every edit is still committed and published, so the worst case is a rebase conflict that is reported in the views. No work is lost.
- **Follow-ups:**
  - the extension shows server health prominently (from ADR-0007);
  - the PRD's S5/S6 (fail-closed message, opt-in fail-open) are rewritten in Phase 3 stage 0;
  - implemented and tested in the spike (v3); the MVP hook carries it over.
- **Update 2026-10-23 (spike v3c):** the trade-off is smaller than first stated.
  - A local server that isn't running is now **started automatically** by the hook; it exits after 30 idle minutes.
  - Overlapping edits made while coordination is off no longer leave a conflict. The overlapping file moves to the newer shared content, the agent's version is kept in `refs/lanes/backup/…`, and the agent alone is told to re-apply its change.
