# ADR-0017: Every edit is signed with the person (and agent) who made it

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [ADR-0015](0015-lease-handoff-requires-sync.md), [ADR-0004](0004-git-is-source-of-truth.md)

## Context
The founder's requirement: *"signatures need to be added to files like who edited (even multiple people allowed) so you know who edited what, and show it in the commit tree."* Git is our source of truth, so attribution belongs in git, where every tool (GitHub, `git log`, `git blame`, IDEs) already shows it.

## Decision
- Lanes **checkpoints** each agent's work at the end of every turn as a commit:
  - **author:** the human who owns the agent (their git name and email);
  - **trailers:**
    ```text
    Lanes-Agent: claude-code (session 8f2c1a9b)
    Lanes-Task: Add GET /health route
    Co-authored-by: Claude <noreply@anthropic.com>
    ```
- **Several people on one file:** each person's changes are separate commits by that person, so `git log` / `git blame` show per line who edited what, and the commit tree shows each contributor. The server also keeps a **file → editors** index, which the VS Code UI will show (e.g. "`routes.ts`: Ana, Bea").
- Merges into the team's integration branch keep these commits; history is never squashed.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Commits per person, with trailers (chosen)** | Native to git and GitHub; `blame` works; nothing new to learn | Many small commits; teams may want to squash at PR time |
| Signature comments inside files | Visible in the file itself | Pollutes code; breaks diffs; easy to fake |
| Lanes-only database | Flexible | Invisible outside Lanes; duplicates git |

## Consequences
- Checkpoint commits need a clear naming convention and should be easy to squash at PR time if the team wants.
- The hook needs each user's git identity, taken from git config or the Lanes config.
- **"Signed" means authored as the human, not cryptographically signed** *(clarified 2026-10-24, bug hunt #88)*. Checkpoint commits are made with `commit.gpgsign=false`: a signer that prompts, needs a hardware key or has no agent fails inside a non-interactive hook, and every publish would be lost silently. shortcut: sign when a non-interactive signer is configured.
