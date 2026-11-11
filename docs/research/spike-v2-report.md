# Phase 2b report: Spike v2 (smooth collaboration)

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Research › Spike v2 report · Plan: Phase 2b · Previous: [Spike v1 report](spike-report.md) · Issue #30

## Verdict: **ready for Phase 3**

After one round of fixes, **42 real Claude Code (Haiku) sessions across 13 runs, with up to 6 agents at once, produced:**
- 0 merge conflicts;
- 0 unfinished tasks;
- 0 lost work;
- 0 broken files;
- 0 user-visible interruptions.

Every edit is signed with the person who made it, and every real task overlap was detected. One minor issue remains. It has an understood fix, which is carried into the MVP (see [Remaining issue](#remaining-issue)).

**Cost:** $0.41 in total for every spike run so far (v1, plus both v2 rounds). That's 2% of the $20 cap, and it ran on the founder's existing Claude subscription.

## What was tested
The four mechanisms from [ADR-0015](../decisions/0015-lease-handoff-requires-sync.md) to [ADR-0018](../decisions/0018-automatic-tasks-and-overlap.md):

- **Background coordination.** Edits wait quietly in a fair queue instead of being refused. The user only ever sees Claude Code's status line.
- **Version-aware handoff.** Before an agent edits a file a teammate just changed, Lanes merges that change into the agent's copy automatically.
- **Signed edits.** Every edit becomes a commit authored by the human, with `Lanes-Agent`, `Lanes-Task` and `Co-authored-by: Claude` trailers, published to the team's integration branch.
- **Automatic tasks.** Every prompt becomes a task with predicted files. Overlapping tasks are detected on the server.

| Scenario | Runs | Setup |
|---|---|---|
| V1 | 3 | 2 agents, same hot file |
| V2 | 3 | 4 agents, 2 hot files |
| V3 | 2 | 4 agents, multi-file tasks with heavy overlap (route, handler and config) |
| V4 | 2 | One person's 2 agents, same file |
| V5 | 1 | Control: 4 agents, no overlap |
| V6 | 1 | Holder killed mid-edit; the waiter is served when the lease expires |
| V7 | 1 | **6 agents at once**, mixed tasks |

## Results

### Errors (target 0)
| Error | First attempt | **After fixes** |
|---|---|---|
| Merge conflict / failed publish | 16 | **0** ✅ |
| Failed sync | 0 | **0** ✅ |
| Task not done | 17 | **0** ✅ |
| Lost work (unpublished) | 16 | **0** ✅ |
| User-visible interruption | 9 | **0** ✅ |
| Broken syntax | 0 | **0** ✅ |
| Shell write attempts | 0* | **1** ⚠️ (blocked by Claude Code's permissions; see below) |

\* The first attempt's classifier counted only reads (`ls`, `cat`) and missed `perl -i`. It was corrected before the final count.

### Smoothness
- **87% of edits never waited.** 80 edit requests; only 10 waited at all; **0 wait timeouts**.
- **Typical wait: 0.5 s.** Outside the lease-expiry test (V6), waits ranged from 0.3 s to 22 s. In V6 the waiter got the file after 40 s, as designed (45 s expiry).
- **19 automatic syncs** brought teammates' changes into an agent's copy, with no failures.
- **Hook start-up** is 119 ms (p50) and 136 ms (p95). This is still over the 100 ms target; the MVP fix is to bundle the hook into one `.cjs` file, as in the v1 report.

### Attribution (ADR-0017)
- **66 of 66 commits** on the integration branch were authored by the right person, with the right email and the Lanes trailers.
- The server's file → editors index matched `git log` exactly.
- The commit tree shows who did what. From V7 (6 agents):

```text
* 2035b64 carl: Add a GET /metrics route: create src/handlers/metrics.ts...
* b6c9f53 bea: In src/routes.ts, add a GET /version route...
* c7f41e9 ana: In src/routes.ts, add a GET /health route...
* a967780 eve: Change the currency in src/config.ts from "EUR" to "USD"...
* 4013e46 finn: Add an applyDiscount(price: number, percent: number)...
* 975019b dan: Add a requestTimeoutMs setting with value 5000...
```

### Overlap detection (ADR-0018)
- **Recall 100%:** every pair of tasks that really touched the same file was flagged up front.
- **Precision 68%:** some flagged pairs only *mentioned* a shared module, e.g. "version" reads `config.ts` without editing it. That's acceptable for a heads-up. Better prediction (LSP/symbols) is the planned paid feature.

## What the first attempt found, and what fixed it

| Problem | Cause | Fix |
|---|---|---|
| 16 publish "conflicts", even with no overlap at all (V5) | Rebasing needs a committer identity; this machine has none, so every publish after the first failed | Pass the human's identity to every git operation that writes. Failures now include git's error text |
| Deadlocks and long waits | Leases lasted a whole turn, so two agents could each hold one file while waiting for the other's | **Publish after every edit.** A lease now lasts one edit, so waits take seconds and deadlock is impossible |
| A holder queued behind someone waiting for its own file | The no-queue-jumping rule ignored existing holders | Paths the requester already holds are exempt |
| Agents mentioned "Lanes" or "another agent" to their user | The overlap heads-up and the wait messages put Lanes in the agent's words | Overlaps stay on the server (for the UI); sync is silent; wait wording is neutral |
| Runner hung or left processes behind | Windows doesn't kill child process trees; leftover hooks kept pipes open | `taskkill /T`; finish on process exit |

All fixes have tests: **54 tests pass**, including concurrent publishes with no git identity, and abandoned waits.

## Remaining issue
**One agent in 42 sessions tried to rewrite a file with `perl -i`.**

- **What happened** (V7, carl-3):
  1. The agent read files with `cat` instead of Claude Code's Read tool.
  2. A teammate's change was then synced in silently.
  3. Claude Code's "modified since read" check only tracks its own Read tool, so it didn't fire. The agent's edits failed with "text not found".
  4. The agent guessed it was a Windows line-ending problem and tried `perl -i`.
  5. Claude Code's permission system blocked the command. The agent re-read the files properly and completed its task.
- **Fix for the MVP:** when a sync changes the file the agent is about to edit, allow the edit **with an agent-only note** (PreToolUse `additionalContext`): *"This file was just updated with a teammate's latest changes; re-read it before editing."* The user still sees nothing.
- **Related known risk:** shell commands that write files (R3) aren't coordinated by edit hooks. Teams that allow Bash writes rely on the end-of-turn publish to pick them up.

## Carried into the Phase 3 MVP
1. Per-edit publish to an integration branch, queued leases, silent sync with the agent-only re-read note, signed commits, automatic tasks. All validated here.
2. Bundle the hook into one `.cjs` file and re-measure start-up (target p95 < 100 ms).
3. The integration branch becomes a real remote branch (push/fetch) for multi-machine teams. The spike used a local branch on one machine.
4. Commit hygiene: per-edit commits are many and small. Offer "squash per task" when opening a PR, keeping a `Co-authored-by` line per contributor.
5. Not yet tested: larger models, long real tasks, multiple machines. Cover these during MVP dogfooding.
