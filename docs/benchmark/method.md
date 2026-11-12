# Multiplayer benchmark: method

Last updated: 1 November 2026 · Status: **protocol, published before any run** · Task: M.1 in tasks.json · Design: shared-context-design.md §6

We publish how we measure before we measure. No number from this benchmark goes on the site, in a deck or in an email unless it comes with this method, the raw logs and the script that produced it.

## Question
Does Lanes team context (the brief, the heads-up and requests, [ADR-0028](../design.md#adr-0028)) change what happens when several coding agents work on one repository at once, compared with Lanes leases alone?

## Arms
Same model, prompts, budgets and starting commit in every arm.

| Arm | Setup |
|---|---|
| B | Shared branch, no Lanes |
| C | Lanes leases and checkpoints (the shipped beta) |
| D | C plus team context (`lanes team on`) |

Arm A (separate worktrees, merge at the end) and a competitor arm wait for the full run. We only run a competitor if its terms allow benchmarking.

## Phases
1. **Pilot (this protocol).**
   - Uses the existing runner (`scripts/runner/run.ts`, `--team` for arm D) on the spike testbed: scenarios V2 and H1, arms C and D, 3 runs each.
   - Its purpose is to check the harness and the metrics, so pilot numbers are reported as a pilot.
   - It needs no customers.
2. **Full.**
   - CooperBench two-agent tasks (arXiv:2601.13295) plus a Lanes set with 3, 5 and 10 agents on hot files.
   - At least 3 runs per task and arm.
3. **CI subset.**
   - One cheap scenario per pull request, to catch regressions.

## Pilot scenarios
The pilot reuses two frozen spike scenarios, so arm C can be compared with the spike's published results:
- **V2:** 4 agents, 2 hot files.
- **H1:** 4 agents, cross-cutting features with a semantic conflict: one renames a function another starts calling.

Requests between agents need a person to approve them, so the pilot measures only the brief and the heads-up. A hand-off scenario with a scripted approval comes in the full run.

## Intent scenarios (added 3 November 2026, before any run)
The pilot hit a ceiling: in H1, the new caller is written in the file the renamer also edits, so the lease sync hands the caller the renamed code and arm C passes. These scenarios put the new caller in a **new file the other agent never touches**. Leases and syncs then have nothing to act on, and the only signal is team context. Defined in [scenarios.json](scenarios.json), same template and runner (`node scripts/runner/run.ts I1 I2 I3 --runs 3`, then with `--team`).

| ID | Agent 1 | Agent 2 | Fails when |
|---|---|---|---|
| I1 | ana renames `priceWithTax` to `grossPrice` | bea, 8 s later, adds `POST /invoices` in a new `src/handlers/invoices.ts` calling `priceWithTax` | bea's new file still imports `priceWithTax` (the app no longer loads, so both tasks fail) |
| I2 | bea adds `POST /invoices` first | ana renames, 8 s later | ana's rename misses bea's new file |
| I3 | ana changes `addOrder(total)` to `addOrder({ net, total })` | bea, 8 s later, adds `POST /refunds` in a new `src/handlers/refunds.ts` calling `addOrder` | bea calls the old signature (the refund's total is wrong) |

Each check was run by hand against a correct tree (passes) and a stale-caller tree (fails) before any agent run. Primary metric: **task success** per arm, C versus D. A difference counts only if it shows across all three runs; with 3 runs we report the raw runs, not intervals.

### Result of the first round, and arm D2 (pre-registered 9 November 2026, before any D2 run)
The 3 November runs ([intent-2026-11-03.md](intent-2026-11-03.md)): C failed I1 in 3 of 3 runs, and D did not fix it (I1 1/3, I3 0/3). The heads-up fired only before an *edit* of a teammate's file, the turn-end note about newer content was dropped at Stop, and every note said it "needs no action".

**Arm D2** is D plus four changes (task M.2), all off unless team context is on, so arm C is unchanged:
1. A heads-up when the agent *reads* a file a teammate touched or is expected to touch (Claude Code `Read` tool).
2. At turn end, a one-time Stop block when a file the turn read or imports changed under it, or when a teammate's new file imports a file the turn changed.
3. Heads-up wording asks the agent to write code that matches the teammate's change; the brief stays awareness only.
4. Runner: `--strict-mcp-config` in every arm (no account connectors), and per-run counts of heads-ups, read heads-ups and stale blocks.

**Success bar, fixed now:**
- D2 passes I1 and I3 in **at least 9 of 10** runs each.
- C stays at **2 of 10 or fewer** on I1 (the conflict is real).
- D2 asks the user nothing (`asksUser` = 0 in every run).
- Median extra turns in D2 versus C: **2 or fewer**.

**Runs, all reported:** I1, I2, I3 x C, D, D2 x 10 runs (Haiku). Then a timing sweep (I1, I3, the second agent starting 0, 4, 16 and 30 s later, C vs D2, 5 runs each), a false-alarm check (pilot V2 and H1 in D2, 5 runs: stale blocks and extra turns where no conflict exists), and a model check (I1, I3 with Sonnet, C vs D2, 3 runs). If D2 misses the bar, the write-up says so and names which layer failed (no read heads-up, block ignored, or the wrong fix).

## Metrics (definitions fixed now)
| Metric | Definition |
|---|---|
| Lost lines | Added lines missing from the final tree that their author did not delete. Target: 0 in C and D. |
| Integration conflicts | Conflicted files from `git merge-tree` when each agent's work is integrated. |
| Overlap caught before write | Recall: overlaps preceded by a heads-up to the second writer, divided by all overlaps. An overlap is two agents' writes to the same file within 3 lines of each other while both are uncommitted to `lanes/main`. Precision: heads-ups followed by a real overlap. |
| Task success | The scenario's checks pass on the final tree. |
| Disruption | Assistant messages that ask the user to decide or confirm (spike v3 failure), counted with the fixed `ASKS_USER` pattern in `scripts/runner/run.ts` (field `asksUser` per agent). |
| Cost | Tokens and API-equivalent dollars per run, plus context tokens Lanes added (sum of brief and heads-up lengths). |
| Time | Wall-clock minutes to the last agent's finish. |

## Rigour
- **Pinned setup:** model id and date, Claude Code version, Lanes commit.
- **Reporting:** the mean and a bootstrap 95% confidence interval for each metric and arm. With 3 runs, intervals will be wide and we say so.
- **Every run is reported,** including failed and excluded runs, with the reason.
- **Published alongside:** the harness, the raw agent streams, the server logs (which never contain chat or request text) and the scripts behind every table.
- **Budget:** the runner's `LANES_CAP_USD` stops a run that goes over its guard.
- **Sandboxing:** every agent runs with a temporary `LANES_HOME` and `LANES_AUTOSTART=0`, so nothing touches a real home folder.

## What would change our plan
- **D no better than C** on overlap recall or conflicts: the brief is cost without value, so we shrink it and make the heads-up the product.
- **D raises disruption:** the wording fails the spike v3 test, so we change the phrasing before anything ships on by default.
- **Any lost line in C or D:** a bug. Fix it before anything else.
