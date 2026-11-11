# ADR-0022: Checkpoint commits stay on the agent's branch, and the agent is told so

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [ADR-0017](0017-edit-attribution.md) · [ADR-0019](0019-never-refuse-an-edit.md) · [ADR-0021](0021-remote-integration-branch.md) · [Spike v3 report §5](../research/spike-v3-report.md#5-spike-v3b-the-risks)

## Context
Lanes commits every edit automatically ([ADR-0017](0017-edit-attribution.md)). An agent that inspects git sees commits it didn't make by hand, and it tells its user something is wrong.

Scenario V8 asks 4 agents to run `git status` and `git log` after their task:

| | Agents that told their user their own edits were committed by "another session", "someone else" or "another process" |
|---|---|
| No explanation (baseline) | **8 of 8** |

That is a user-visible alarm on every inspection, which runs against the spirit of [ADR-0019](0019-never-refuse-an-edit.md).

## Decision
1. **Checkpoint commits stay on the agent's working branch.** Sync and publish are built on rebasing real commits, and per-line `git blame` attribution depends on them.
2. **At session start, the agent is told, and only the agent:** *"In this repository, each file edit you make is saved automatically as a commit on your branch, named after the current request. You don't need to commit. Those commits are your own edits; this is expected."* This text goes through `SessionStart` `additionalContext`. Like all agent-facing text, it names no one and says the state is expected (see the [spike v3 lesson](../research/spike-v3-report.md#2-re-read-note-the-spike-v2-fix-works-but-its-wording-mattered)).
3. **Many small commits are tidied at PR time** by squashing per task (Phase 3, b.8).

**Result with the note:** in V8, **0 of 8** agents were confused. All of them reported, for example, that "the session saves each edit as a commit automatically".

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Commits on the branch, and the agent is told (chosen)** | Measured fix (8/8 → 0/8); nothing in the git model changes | Branch history has one commit per edit until it's squashed |
| Commit to a hidden ref and leave HEAD alone | The agent's `git log` stays clean | `git status` would show "uncommitted" changes forever, which is just as confusing; it also breaks the rebase-based sync |
| Squash continuously into one commit per task | Tidy history | Rewrites history under a running agent and complicates publish |

## Consequences
- **Positive:** agents describe automatic commits correctly. The scenario runner now tracks the "Confused by automatic commits" metric.
- **Negative:** if a user tells their agent to "commit your work", there is nothing to commit. That is harmless, and the agent says so.
