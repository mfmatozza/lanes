# ADR-0023: Security baseline: a token on every request, and Lanes commits only what its agent edited

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** @mfmatozza
- **Related:** [Security model](../architecture/security.md) · [ADR-0019](0019-never-refuse-an-edit.md) · [ADR-0021](0021-remote-integration-branch.md) · [Spike v3 report §6](../research/spike-v3-report.md#6-spike-v3c-risks-closed-harder-tests-security-review)

## Context
On the founder's request, an independent security review of the spike (2026-10-23) found 9 issues, 4 of them high:
1. **No authentication on localhost.** Any web page open in a teammate's browser could change the server's state (CSRF, via `text/plain` POSTs) or read it (DNS rebinding). That includes task titles and absolute paths.
2. **Prototype pollution** through `/v1/publish`, reproduced: one crafted request corrupted the whole server process.
3. **A shared `/tmp/lanes-hook` cache** on multi-user machines. Another local user could poison it to make the hook run git in a folder they control, or plant symlinks the hook would write through.
4. **`git add -A` and `--no-verify`.** Every checkpoint swept in *any* file in the folder: an un-ignored `.env`, the human's unrelated work. It skipped secret scanners and pushed everything to the shared remote.

Lower-severity issues:
- secrets in a prompt's first line ended up in commit messages;
- unbounded memory and queues;
- commit ids from the server reached git unchecked;
- the settings merge could delete other tools' hooks.

## Decision
1. **Every request carries a bearer token, even on localhost.** The local server and the hooks share a per-user token in `~/.lanes/token` (0600, created on first use). A LAN server uses a team token.
   - The server also refuses unexpected `Host` headers (DNS rebinding) and non-JSON POSTs (CSRF).
   - Only `/health` is open.
2. **Lanes commits only what its agent changed during the turn**, as literal pathspecs, and the commit names those paths so nothing else the human staged is swept in:
   - after each edit: the file the edit tool changed;
   - at the end of a turn: also files that changed *during the turn* outside the edit tools (generators, scripts). Files already changed when the prompt arrived are the human's and are never included. Secret-looking files (`.env*`, keys, `credentials`, `.npmrc`…) and files over 1 MB are never included either. *(Refined 2026-10-23, spike v3d: without this, a generated file that a published edit imported was left behind, and the shared branch broke for everyone in 2 of 2 runs.)*
   - The repository's own commit and push hooks run (no `--no-verify`), so secret scanners still apply. *(Confirmed 2026-10-28, #211: `lanes pr`'s squash commit had been using `--no-verify`, against this rule; it now runs the hooks. When one rejects the commit it prints the hook's output and leaves the scratch worktree, with the task's changes staged on the branch, and the exact command to continue; a hook that fails only because the scratch worktree has no `node_modules` gets a message saying so. The alternative, keeping `--no-verify` because the content already passed the hooks as checkpoints, was rejected: a checkpoint that was published before a hook was installed or fixed would never be scanned.)*
   - Rebases use `--autostash`, so files Lanes doesn't own ride along untouched. *(Refined 2026-10-24, bug hunt #79: a rebase or sync is skipped, not attempted, when a file the human has uncommitted changes in is also changed by the incoming commits, because `--autostash` exits 0 while leaving conflict markers.)*
   - **Only Lanes' own commits are published** (those with the `Lanes-Agent:` trailer). The human's earlier local commits on the checked-out branch stay local: when they sit under the agent's checkpoint, Lanes replays its own commits onto the shared tip in memory (`git merge-tree`) and pushes that. A checkpoint that depends on the human's unpublished commits is kept local and reported. *(Added 2026-10-24, bug hunt #78.)*
   - Paths are read NUL-separated (`-z`) everywhere, so non-ASCII names are byte-exact; paths that git ignores, or that no longer exist and were never tracked, are dropped one by one before committing (#76, #82).
3. **Hook state lives in `~/.lanes`.** The directory is created 0700 and refused if it is a symlink or owned by someone else. Nothing goes in shared temp folders. A directory or token file that already exists with group/other permissions is tightened to 0700/0600, and the token is written to a temp file and linked into place so no process can read it half-written or empty. `LANES_HOME` decides the location for every per-user file, `config.json` included. *(Added 2026-10-24, bug hunt #87, #91, #93.)*
4. **Inputs are bounded and typed:**
   - bodies ≤ 64 KB, strings ≤ 512 characters, ≤ 50 paths;
   - at most 1,000 waiters (4 per session); past that the edit goes ahead ([ADR-0019](0019-never-refuse-an-edit.md));
   - tasks are capped;
   - maps keyed by request data have no prototype;
   - commit ids must be 40–64 hex characters, checked on the server and in the hook, and passed after `--end-of-options`.
5. **Secrets are redacted** from task titles (and so from commit messages) and from git error text sent to the server. This covers API-key, GitHub, AWS and Slack token patterns, `password=`-style pairs, credentials in URLs and long opaque strings.
6. **No absolute paths leave the machine.** Only the folder name is sent as the label.
7. **Lanes' entries in `.claude/settings.json` carry an exact `--lanes` marker.** Other tools' hooks are never matched or removed.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Token everywhere, commit only what the turn changed (chosen)** | Closes every high finding; generated files still reach teammates; invisible to users | A file a shell command changes that the human had *also* already changed stays local (never lost) |
| Token only for LAN servers | Zero setup locally | Leaves localhost open to any web page |
| Keep `git add -A` but add a deny-list (`.env`, keys) | Publishes shell-created files too | A deny-list always misses something; it still sweeps the human's own work |

## Consequences
- **Positive:** every finding is fixed and has a test: 73 tests on Windows, Linux and macOS. Scenario S1 checks end to end that secrets planted in a prompt and in an untracked `.env` never reach the shared branch or the server log.
- **Negative:** a file both the human and the agent's shell commands changed in the same turn stays local, for normal git. The agent integration doc will describe the rule (stage 0, issue #44).
- **Follow-ups (MVP):**
  - install `hook.cjs` per user rather than from the repository, to close the supply-chain path through a shared branch;
  - rotate the server log;
  - remove the spike-only `/v1/observe` shell-command logging.
