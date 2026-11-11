# ADR-0018: Tasks are created automatically from prompts, and overlaps are detected up front

- **Status:** Accepted, amended 2026-10-24 (quiet heads-up removed), updated 2026-10-26 (task board shipped)
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [ADR-0014](0014-positioning-intent-visibility.md), [ADR-0016](0016-non-blocking-coordination.md)

## Context
The founder's requirement: *"some internal organisation between the different people collaborating so that tasks get created and there is comparison of overlapping tasks."* This is also the core of our positioning (ADR-0014): visibility of every agent's intent.

## Decision
- **Automatic tasks.** Each prompt a user gives their agent (`UserPromptSubmit` hook) becomes a **task** on the team board, with:
  - an owner;
  - a title: the first line of the prompt, at most 120 characters;
  - a status: active → done when the turn's work is published;
  - **predicted files:** paths and module names mentioned in the prompt, matched against the repository;
  - **touched files:** updated live as leases are granted.
- **Overlap comparison.**
  - When a task is created, it's compared with every active task. Two tasks overlap if their predicted or touched files intersect.
  - Overlaps are logged and (later) shown on the VS Code task board.
- **No heads-up for the agent.** *(Amended 2026-10-24.)* The original design gave the agent a short note about the overlapping task. In spike v3 the note made agents mention Lanes to their user, and one asked its user to confirm. Overlaps are now **server and UI only**: they are logged, shown on the task board, and never put in the agent's context. Queued leases and silent sync already keep the agents from clobbering each other. *(Amended 2026-11-01: in repositories that opt into multiplayer team context, the agent gets the overlap as a factual heads-up, see [ADR-0028](0028-agents-share-team-context.md).)*
- **Privacy.** Only the title and the predicted files are sent to the server. The full prompt is never stored.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Automatic from prompts (chosen)** | Zero effort; always up to date | Titles can be noisy; file prediction is heuristic |
| Manual tasks (Linear/Jira style) | Precise | Nobody will maintain them for every agent prompt |
| Ask a model to summarise each task | Better titles | Costs tokens and adds latency; maybe later, as an option |

## Consequences
- File prediction starts heuristic. LSP/symbol-based prediction (the paid feature) improves it later.
- The task board becomes the main VS Code view in the MVP.
- **Update 2026-10-26 (#60):** the Tasks view in VS Code shows each person's tasks and flags overlapping files; see the [extension design](../architecture/vscode-extension.md).
