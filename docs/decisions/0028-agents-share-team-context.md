# ADR-0028: On the multiplayer track, agents are told what their teammates are doing

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** @mfmatozza
- **Related:** amends [ADR-0016](0016-non-blocking-coordination.md) and [ADR-0019](0019-never-refuse-an-edit.md) for the multiplayer track only · [ADR-0023](0023-security-baseline.md) · issue #261 · multiplayer/

## Context
Until now, Lanes coordinated agents without the agents knowing. ADR-0016 kept coordination in the background, and the hook's wording stayed neutral: when an agent was told about a teammate, it reported this to its user, and one agent asked its user to confirm (spike v3).

On 1 November 2026 a competitor (agentmash.dev) launched the opposite approach:
- agents get a heads-up about teammates' uncommitted work before an edit;
- a team chat reaches every agent;
- a person can send a request to a teammate's agent, which runs once the teammate approves.

That is also our own vision slide: agents that coordinate directly with each other, not just take turns on files.

## Decision
A new multiplayer layer, opt-in per repository at first, may put team context into an agent's conversation:
1. **Team brief at each prompt:** who is working on what, and new chat messages, kept to a small fixed budget.
2. **Heads-up before an edit:** a teammate's active work on that file.
3. **Approved requests:** a teammate's request, only after this agent's own user has approved it.

What does not change:
- The rules of ADR-0019 still hold: an edit is never refused or blocked, coordination fails open, and work is never lost.
- The heads-up is context, not a permission decision.
- Wording stays factual and says that nothing needs the user's confirmation, to avoid the spike v3 failure.

Text written by a teammate (chat, requests) is **untrusted input** to another person's agent:
- It is always quoted as data, with its author named.
- It is never phrased as an instruction from the system.
- A request is acted on only after the receiving user approves it.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Opt-in team context, untrusted text quoted (chosen)** | Matches the competitor's feature set and our vision; keeps fail-open and never-lose-work | Agents may mention teammates to their user; prompt-injection surface |
| Keep agents unaware (ADR-0016 as is) | No new risk | Cannot build shared context, chat or agent requests; the competitor already ships them |
| Turn it on for everyone at once | Fastest adoption | Changes shipped beta behaviour without evidence; spike v3 showed wording risks |

## Consequences
- **Positive:** Lanes becomes a shared-context layer, not only a lock manager. It builds on leases, tasks and presence the server already has.
- **Negative / trade-offs:**
  - Prompt-injection risk across people, mitigated by quoting, approval and per-repository opt-in.
  - Spending context tokens, mitigated by a hard budget.
  - Some agents may mention teammates to their user.
  - Lanes' own wording may point the agent at a re-check ("re-read it and make your code match the new version", and a one-time turn-end block when a file it depends on changed under it, M.2). Teammate text never becomes an instruction: it stays quoted data.
- **Follow-ups:**
  - Measure with the soak harness whether the heads-up changes agent behaviour (stops, questions to the user).
  - Revisit the default (opt-in or on) once that is measured.
