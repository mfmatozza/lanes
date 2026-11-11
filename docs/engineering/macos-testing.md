# Testing on macOS

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Engineering › macOS testing · [Testing strategy](testing-strategy.md) · [Spike v3 report](../research/spike-v3-report.md)

How the founder verifies Lanes on a Mac. CI already runs the automated tests on macOS (`.github/workflows/spike.yml`). This guide covers the parts CI can't do:
- real agents on a real Mac;
- a human approving edits;
- Mac-specific file-system behaviour.

**Time:** about 45 minutes. **Cost:** about $0.10 of Claude usage (Haiku), on your subscription.

## 0. One-time setup
Open **Terminal** and run:

```bash
# Homebrew (skip if `brew --version` works)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node git gh      # Node must be ≥ 22.18: check with `node --version`
npm install -g @anthropic-ai/claude-code
claude                        # log in once with your Claude account, then type /exit
gh auth login                 # to clone the private repository

git clone https://github.com/mfmatozza/lanes.git ~/lanes
cd ~/lanes/spike
```

## 1. Automated tests (2 min, free)
```bash
npm test
```
✅ **Pass:** the last lines say `ℹ fail 0`.
❌ **Fail:** copy everything from the first `✖` line onwards.

## 2. Build the hook and measure its speed (1 min, free)
```bash
npx --yes esbuild@0.24.0 src/hook.ts --bundle --platform=node --format=cjs \
  --outfile=dist/hook.cjs --define:import.meta.main=true --log-level=warning
node --no-warnings runner/bench-hook.ts 50
```
✅ **Pass:** the `dist/hook.cjs` line shows **p95 under 100 ms**. On Windows it is 84 ms; a Mac is usually faster.

## 3. Real agents, automated (about 20 min, about $0.10)
Teammates' agents run side by side on separate clones of a shared repository:

```bash
node runner/run.ts V1 V8 H1 S1 --remote
node runner/analyze.ts v3
```

✅ **Pass:** in the **Errors** table that `analyze` prints, every row with a ✅/❌ shows **0 ✅**.

## 4. A human approving edits (about 10 min, free)
This test only a person can do. It checks that a lease is held while you decide whether to approve an edit, and that the other agent then gets the file without anything being refused (spike v3 risks 3 and 1).

1. **Create two checkouts and leave them on disk:**
   ```bash
   node runner/run.ts V1 --runs 1 --dry --remote --keep
   ```
   The output ends with two `cd` lines, one each for `ana` and `bea`.
2. **Terminal A: start the coordination server:**
   ```bash
   cd ~/lanes/spike && node src/main.ts
   ```
3. **Terminal B (Ana):** paste Ana's `cd` line, then:
   ```bash
   export LANES_USER=ana LANES_EMAIL=ana@example.com LANES_REMOTE=origin
   claude --model haiku
   ```
   If Claude Code asks whether to trust the folder or its hooks, answer **yes**.
4. **Terminal C (Bea):** paste Bea's `cd` line, then:
   ```bash
   export LANES_USER=bea LANES_EMAIL=bea@example.com LANES_REMOTE=origin
   claude --model haiku
   ```
   Answer **yes** to trust as well.
5. **In Ana's session**, type:
   *In src/routes.ts, add a GET /health route that returns status 200 with body { ok: true }.*
   When Claude asks for permission to edit, **wait about 2 minutes before approving.**
6. **While Ana's approval is pending, in Bea's session**, type:
   *In src/routes.ts, add a GET /version route that returns status 200 with body { version: "1.0" }.*
7. **What should happen:**
   - Bea's session shows **"Lanes: coordinating with teammates…"** while it waits. There is no error and no refusal.
   - After you approve Ana's edit, Bea's edit goes ahead within a few seconds.
   - Neither agent's final message asks you to do anything or re-send the prompt.
8. **Check the shared result** in Terminal A. Stop the server with Ctrl+C first, then:
   ```bash
   cd "$(dirname "<Ana's path from step 1>")/origin.git"
   git log --format='%an: %s' lanes/main
   git show lanes/main:src/routes.ts
   ```
   ✅ **Pass:** the log shows both an `ana` commit and a `bea` commit, and `routes.ts` has both routes.
9. **Ask each agent:** *Run git log --oneline -5 and tell me what it shows.* ✅ **Pass:** neither agent says the commits belong to "another session" or someone else.

## 5. Server down never blocks you (2 min, free)
1. Keep Ana's session open and leave the server stopped (Ctrl+C in Terminal A).
2. Ask Ana's agent to make another small edit.

✅ **Pass:**
- the edit happens normally, with no error and no request to start anything ([ADR-0019](../decisions/0019-never-refuse-an-edit.md));
- Lanes has restarted the local server by itself. `curl -s localhost:4317/health` prints `{"ok":true}`, and the server exits on its own after 30 idle minutes.

## 6. Mac-specific checks (included above)
These are covered automatically by steps 1 and 3, so no extra work is needed:
- **Temp folders through `/private`:** macOS reaches temporary folders through a symlink (`/var` → `/private/var`). The same file must map to the same lease either way.
- **Case-insensitive file names:** the default Mac disk treats `Routes.ts` and `routes.ts` as the same file.

## Reporting back
Open a GitHub issue titled **"macOS test run (date)"**. For each numbered step, write ✅ or ❌, and paste the output of steps 2 and 3. Mention the Mac model and the macOS version (Apple menu ›  About This Mac).

When you're done, clean up the checkouts from step 1:
```bash
rm -rf "$(dirname "<Ana's path from step 1>")"
```
