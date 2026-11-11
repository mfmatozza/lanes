# ADR-0021: The integration branch lives on the team's git remote

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [ADR-0004](0004-git-is-source-of-truth.md) · [ADR-0015](0015-lease-handoff-requires-sync.md) · [ADR-0019](0019-never-refuse-an-edit.md) · [Spike v3 report](../research/spike-v3-report.md)

## Context
In spike v2 the integration branch `lanes/main` was a local branch, which only works when everyone is on one machine. Real teams work on separate machines.

## Decision
- `lanes/main` lives on the repository's existing remote (`origin` by default).
- **Publishing an edit:**
  1. commit locally, signed as the human ([ADR-0017](0017-edit-attribution.md));
  2. fetch `lanes/main`, then rebase onto it;
  3. `git push`. Git refuses a push that isn't a fast-forward, so the push itself is the compare-and-swap. If it's refused, fetch, rebase and retry, up to 8 times.
- **Sync on handoff:** fetch, then rebase with `--autostash`.
- **Credentials:** the developer's existing git credentials. Lanes adds no secrets and no server-side git access, so the coordination server never sees code ([N2](../product/requirements.md)).
- **Remote unreachable:** the commit stays local and is pushed by the next publish. No edit is refused ([ADR-0019](0019-never-refuse-an-edit.md)).
- **Branch protection:** `lanes/main` must allow fast-forward pushes from team members. `lanes init` checks this and explains how to set it up if it can't push.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Remote branch on origin (chosen)** | Works across machines; native git; no new infrastructure | One push per edit (≈ 0.3–1 s, in the background) |
| The Lanes server stores and relays commits | One fewer git round trip | The server would hold code, which breaks the privacy promise and adds infrastructure |
| Peer-to-peer git between machines | No central remote | Network and firewall complexity |

## Consequences
- **Positive:** validated in spike v3. With 6 clones there were 0 failed publishes, 107 commits pushed and 0 attribution errors.
- **Negative:** the remote receives many small commits on `lanes/main`. Squash per task at PR time handles this (Phase 3, b.8).
- **Follow-ups:** test over a real network and with GitHub rate limits during dogfooding.
