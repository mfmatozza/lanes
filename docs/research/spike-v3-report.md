# Spike v3 report: no refusals, remote branch, fast hook, risks handled

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Research › Spike v3 report · Previous: [Spike v2 report](spike-v2-report.md) · Decision: [ADR-0019](../decisions/0019-never-refuse-an-edit.md) · Next: Phase 3 MVP plan

## Verdict: **ready for the MVP. All carry-overs are closed**

Spike v3 tested the open items from spike v2 and the founder's new rule from [ADR-0019](../decisions/0019-never-refuse-an-edit.md): a user may see Lanes working, but must never have an edit refused and have to send the prompt again.

**Final round:** 28 real Claude Code (Haiku) sessions across 9 runs. Teammates were on **separate clones of a shared remote**, as if each were on their own machine. The round produced:

| Error (target 0) | Round 1 (13 runs, 42 sessions) | **Round 2 (9 runs, 28 sessions)** |
|---|---|---|
| Refused edit (hook denial or block) | 0 | **0** ✅ |
| Asked the user to act or re-prompt | 1 | **0** ✅ |
| Merge conflict / failed publish | 0 | **0** ✅ |
| Failed sync | 0 | **0** ✅ |
| Task not done | 0 | **0** ✅ |
| Lost work (unpublished) | 0 | **0** ✅ |
| Broken syntax | 0 | **0** ✅ |
| Shell workaround attempts | 0 | **0** ✅ |
| *Mentions another person's change (allowed)* | *14* | *0* |

- **Tests:** 60 unit and integration tests pass.
- **Cost:** $0.26 for both rounds. The total for all spikes is $0.67 of the $20 cap.

## What changed, and what we learned

### 1. No refusals ([ADR-0019](../decisions/0019-never-refuse-an-edit.md))
The hook now never denies or blocks an edit:

| Situation | Before (v2) | Now |
|---|---|---|
| File held by someone else | Wait ≤ 90 s, then refuse | Wait ≤ 240 s, then go ahead |
| Sync fails | Refuse | Go ahead (work is committed locally) |
| Server down | Block (fail closed) | Go ahead (fail open); the views will show "offline" |
| Hook crashes or times out | Blocked the edit (`onFailure: block`) | Edit proceeds |

In practice nothing waited long. Most waits took 0.1–0.5 s. The longest was 41 s, in the scenario that kills a holder on purpose.

### 2. Re-read note: the spike v2 fix works, but its wording mattered
When a teammate's change lands in a file an agent is about to edit, the hook adds a note to the agent's context, which the user doesn't see.
- **Round 1 wording:** *"…was just updated with a teammate's latest changes."* The agents passed this on: 14 of 41 mentioned "a teammate" in their summary, and one asked its user to "confirm that the other change is still what you expect".
- **Round 2 wording:** *"…has new content since you last read it. This is expected and the new content should stay. Re-read it…"* This gave **0 mentions and 0 asks**.

Every one of the 31 syncs that changed a file triggered the note. The original spike v2 issue (an agent using `perl -i` after a silent sync) did not recur.

**Lesson:** any text we put in an agent's context can reach the user. Agent-facing text must be neutral, must not name anyone, and must say that the new state is expected.

### 3. Integration branch on a shared remote
- **Publishing:** commit, fetch, rebase, then `git push`. Git refuses a push that isn't a fast-forward, which makes the push itself the compare-and-swap. If someone else pushed first, the hook fetches and retries.
- **Results:** 0 failed publishes with up to 6 agents on 6 clones, and 107 commits pushed, all correctly attributed.
- **Repository identity:** clones of the same remote get the same lease key (N6). This is tested.
- **Remote unreachable:** the edit is committed locally first and pushed with the next publish. This is tested.
- **Credentials:** the hook uses each developer's existing git credentials, so there are no new secrets.

### 4. Hook latency: target met
| Variant | p50 | p95 |
|---|---|---|
| Source `.ts` (spike v2) | 166 ms | 172 ms |
| Bundled `.cjs` | 130 ms | 135 ms |
| **Bundled `.cjs` with the repository identity cached on disk** | **78 ms** | **84 ms** ✅ |

- **Measurement:** `runner/bench-hook.ts`, an allowed edit including process start, Windows, 50 runs. In real agent runs, hook start-up before the request was 31 ms p50 and 84 ms p95.
- **Where the time went:** two `git` sub-processes per edit just to identify the repository, at about 24 ms each on Windows. The cache is invalidated when the repository's git config changes (tested).

## 5. Spike v3b: the risks
After the founder approved the MVP plan (2026-10-22), the known risks were dealt with in the spike, and each fix was measured.

| Risk | Fix | Evidence |
|---|---|---|
| **Agents confused by automatic commits** | An agent-only note at session start says edits are committed automatically and that those commits are the agent's own ([ADR-0022](../decisions/0022-checkpoint-commits-on-the-agent-branch.md)) | New scenario V8, where agents inspect `git log` and `git status` after their task. Agents that told their user their own commits came from "another session" or "someone else": **8 of 8 without the note, 0 of 8 with it.** All other errors were 0 |
| **Lease expiring while the user approves an edit** | A `PermissionRequest` hook holds the lease for up to 30 min while the user decides. The publish or the end of the turn still releases it | Unit test; to be checked by hand in the [macOS guide](../engineering/macos-testing.md) §4 |
| **Same file, two leases** (found while writing the Mac guide) | Paths are resolved as they are on disk: symlinks followed (macOS `/var` → `/private/var`) and the stored letter case used | **The bug reproduced on Windows:** `SRC/A.TS` and `src/a.ts` got different leases, so two agents could have edited one file at once. Fixed and tested; the tests pass on Windows, Linux and macOS in CI |
| **Hook latency headroom** | The hook calls the server with `node:http` instead of `fetch`, which costs about 45 ms to load in every hook process | CI hook p95 (bundled): **Linux 104 → 39 ms · Windows 133 → 68 ms · macOS 79 ms** |
| **Linux and macOS untested** | CI runs the full suite and the latency benchmark on Ubuntu, Windows and macOS. A manual workflow runs real agents on Linux | 64 tests: Linux 62 pass (2 skipped: Windows-only, case-insensitive disk), Windows 63, macOS 63 (1 skipped: Windows-only) |

**V8 spend:** $0.07. **All spikes:** $0.74 of the $20 cap.

## 6. Spike v3c: risks closed, harder tests, security review
Founder request (2026-10-23): fix the remaining risks, test harder scenarios on the subscription (Sonnet as well as Haiku), and look for vulnerabilities.

### Risks closed
| Risk | Fix | Evidence |
|---|---|---|
| **Server down: coordination stops** | When a local server isn't running, the hook starts it in the background. A server started this way exits after 30 idle minutes, and parallel starts don't clash | Test: started on first use, requires the token, exits when idle |
| **Overlapping edits leave work unpublished** (e.g. while coordination is off) | The overlapping file moves to the newer shared content, the agent's version is kept in `refs/lanes/backup/…`, and the agent alone is told to apply its change again. At the end of a turn the agent continues instead of stopping, at most once | Tests, plus scenarios H4 and H5 (server down for everyone, 4 agents on the same lines): **5 re-applies, all completed by the agents; 12/12 tasks done; 0 lost** |

### Harder tests (70 sessions in total in this round, on the subscription)
These scenarios run **the final shared code** and check behaviour, not just text: for example, POST `/orders/discounted` with 100 must return 201 with a total of 109.8.

| Scenario | What it stresses | Result |
|---|---|---|
| H1 ×2 (Haiku), H2 (Sonnet) | 4 cross-cutting features (5 files each). Includes a **semantic conflict**: one agent renames `priceWithTax` everywhere while another writes new code that calls it | 12/12 tasks done, all behaviour checks pass |
| H3 (3 Sonnet + 3 Haiku) | 6 agents, 6 cross-cutting features at once | 6/6, 22 commits, all behaviour checks pass |
| H4 ×2 (Haiku), H5 (Sonnet) | Server down for everyone; 4 agents edit the same lines at the same time | 12/12, 5 automatic re-applies |
| S1 | A token and a password in the prompt; an untracked `.env` in every checkout | **0 leaks** on the shared branch (files, messages) and in the server log |
| V1 ×3, V7, V8 ×2 | Regression of the earlier scenarios on the hardened hook | 22/22 |

- **Semantic conflicts were resolved by the agents, in both orders.** When the rename landed first, the other agent's re-read showed the new name and it used `grossPrice` (H1, H3). When the new caller landed first (H2), the renaming agent's sync brought it in and it renamed that call too. Lanes coordinates files, but keeping every agent on fresh content was enough here.
- **One soft ask** in 52 sessions. After its task, an agent wrote "Please check that those edits are the ones you expect" about a teammate's change. The re-read note now says the new content is coordinated automatically and needs no checking. **V7 ×3 rerun: 18/18, 0 asks, 0 mentions.**
- **By model:** Haiku 41/41 and Sonnet 11/11 tasks done. On API-equivalent prices, Sonnet cost about 15× Haiku per session ($0.065 vs $0.0044). All runs used the founder's subscription; no money was charged.

### Security review
An independent review found 9 issues (4 high). All are fixed, with tests ([ADR-0023](../decisions/0023-security-baseline.md), [security model](../architecture/security.md)):

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | No authentication, even for web pages hitting localhost (CSRF, DNS rebinding) | High | A token on every request; Host check; JSON-only POSTs |
| 2 | Prototype pollution via `/v1/publish` (reproduced) | High | Null-prototype maps |
| 3 | Shared `/tmp` cache open to poisoning and symlinks by other local users | High | Private `~/.lanes` (0700, ownership checked) |
| 4 | `git add -A` plus `--no-verify` could publish `.env` files and the human's own work | High | Commit only files the agent edited; the repo's hooks (secret scanners) run |
| 5 | Shell commands and git errors sent to the server | Medium | Git errors redacted; shell logging is spike-only, removed in the MVP |
| 6 | Secrets in a prompt's first line reached commit messages | Medium | Redaction of credential patterns |
| 7 | Unbounded memory, queue and body size | Medium | Limits on body, strings, paths, waiters and tasks |
| 8 | Commit ids from the server passed to git unchecked | Low–medium | Hex check on both sides and `--end-of-options` |
| 9 | Settings merge could delete other tools' hooks | Low | Exact `--lanes` marker |

Writing these tests turned up two problems in my own new code, both fixed before any agent run:
- A test run **left a real auto-started server listening** on port 1. Tests now run with their own `~/.lanes` and with auto-start off unless a test turns it on.
- The **auto-started server didn't require the token.**

**Spend:** all spikes total $1.71 API-equivalent of the $20 cap, all on the founder's subscription.

## 7. Spike v3d: long tasks and files created by shell commands
Founder request (2026-10-23): test a long task and files created outside the edit tools. Testing on two machines comes later.

### Files created by shell commands (generators, scripts)
Scenario F1: an agent writes a generator, runs it with `node` to create `src/errors.ts`, then edits `orders.ts` to import it. A teammate edits the same handler.

| | Generated file | Shared branch | Teammate's task |
|---|---|---|---|
| **Before** (commit only edit-tool files) | Stayed on the agent's machine (2/2) | **Broken in 2/2 runs**: `orders.ts` imports a file that isn't there, so the app doesn't load | **Failed**: the whole app was down |
| **After** | Published at the end of the turn | Works | Done (6/6 tasks) |

**Fix** ([ADR-0023](../decisions/0023-security-baseline.md), refined):
- At the end of a turn Lanes also publishes files that changed *during the turn* outside the edit tools.
- Files already changed when the prompt arrived are the human's and are never published.
- `.env`-style and key files, and files over 1 MB, are never published.
- The commit names its paths, so anything the human staged stays out of it.

Tests cover all four rules.

### Long tasks
Agents are fast, so a "long task" has to be designed. Four rounds:

| Scenario | Long agent | Teammates | Result |
|---|---|---|---|
| L1 / L2 | One prompt: a 7-file inventory feature with tests and docs (Sonnet / Haiku), about 1 min | 4 at once | 10/10; the feature's own tests pass on the shared branch |
| L3 / L4 | One session, **4 prompts** (cart → checkout with discount codes → tests → docs), resumed with `--resume` | 8, arriving every 45 s | 24/24; behaviour checks and the agent's test suite pass; 41 commits from 9 people |
| L5 | A **test file for every module**, run and fixed until green (Sonnet) | 8, every 30 s | The first attempt failed because of a runner bug: the standard "don't run tests" suffix contradicted the task. After the fix, the suite failed on the *final* shared code because half the teammates' changes landed *after* the agent had finished. That is CI's job, not coordination's, so the check now runs at the agent's own last commit and reports later breakage separately |
| **L6 ×4** | Same as L5, about **2 min and 32–47 turns** each (Sonnet) | 8, every **8 s**, all landing *during* the task | **4/4: the suite passes on the shared branch, even after every later change.** 32/32 teammate tasks done |

**Stale knowledge (new):**
- In a long task an agent reads files once and keeps working from memory. Lanes keeps its *files* current, because each publish rebases the checkout, but the agent's *knowledge* goes stale.
- **Fix:** when a publish brings in other people's changes, the agent alone is told which files to re-read ("Newer content arrived for … This is expected and needs no checking").
- **L6 with the note:** 31 notes, 0 mentions or asks to the user. The long agent averaged 37 turns, 110 s and $0.39, against 45 turns, 125 s and $0.45 without it. That points the right way, but with 2 runs each it is **not yet significant**.
- What made L6 succeed either way was that the agent re-ran the whole suite at the end.

### Shell writes
Sonnet sometimes tries to write files with shell heredocs (`cat > file <<EOF`, `printf >> README.md`). Claude Code's own permission system blocked every attempt, and the agent switched to the Write and Edit tools, which Lanes coordinates. Where a team allows shell writes, the end-of-turn rule above publishes the result.

**Spend:** all spikes total $5.04 API-equivalent of the $20 cap, all on the founder's subscription (no money charged).

## Remaining risks for the MVP
1. **Shell writes aren't coordinated *during* a turn.** Files a turn creates through the shell are published at its end (spike v3d), but they don't take leases while they are being written. If two agents' shell commands write the same file, the later publish re-applies it.
2. **A LAN server that is down can't be restarted by the hook**; only a local one can. Edits still go ahead and are re-applied if they overlap.
3. **Still to test:**
   - truly long real sessions (hours, many prompts; the longest here was about 2 minutes and 47 turns);
   - real separate machines over a network;
   - a real Mac with a human approving edits (see the [macOS guide](../engineering/macos-testing.md));
   - Linux agent runs, which need the `ANTHROPIC_API_KEY` repository secret.
4. **Supply chain:** `hook.cjs` committed to the repository runs on every teammate's machine. The MVP installs it per user ([ADR-0023](../decisions/0023-security-baseline.md) follow-up).
