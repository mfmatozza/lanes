# ADR-0014: Position on intent visibility and early conflict warnings, not file locks

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** issue #16, Demand evidence, [ADR-0006](0006-file-level-leases-with-ttl.md)

## Context
Desk research found three things:
- **Same-file overlaps often merge cleanly.** The expensive collisions are about meaning: *"two agents can each be correct and jointly wrong."*
- **"File locking" competes with free alternatives.** Git worktrees and native features in Anthropic, GitHub and Zed tools already cover it.
- **The demand that exists is for awareness.** Teams want to know what everyone's agents are doing.

## Decision
- **Lead with this message:** *"See what every teammate's agent is working on, and get warned before their work collides."*
- **File leases ([ADR-0006](0006-file-level-leases-with-ttl.md)) stay the MVP enforcement mechanism.** We describe them as a safety net, not as the product.
- **Move conflict prediction earlier:** predicting conflicts before merge, at the function/class level and across files, moves up the roadmap and becomes the first paid feature.
- **The spike measures the premise:** it gains a baseline scenario without Lanes, to see whether same-file overlaps actually conflict.

## Consequences
- Update the product strategy's positioning and taglines. The vision keeps its three pillars: see, coordinate, integrate.
- If the spike shows that same-file overlaps nearly always merge cleanly, file leases may move from blocking edits to *warning* about them. That would need a new ADR.
