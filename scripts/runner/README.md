# Scenario runner against the packages

The spike's runner (`spike/runner/run.ts`) drives the frozen spike code in `spike/src`. This copy drives the product:
the coordinator and server from `packages/server`, the hook settings from `packages/core`, and the **bundled**
`dist/hook.cjs` that `npm run build` produces. It reads the scenarios and the template repo from `spike/testbed`
and writes nothing under `spike/`.

```bash
npm run build                                  # dist/hook.cjs
node scripts/runner/run.ts V1 V2 --runs 1      # real agents: uses the logged-in claude (subscription)
node scripts/runner/run.ts H1 --dry            # set up repos only (free)
LANES_MODEL=sonnet node scripts/runner/run.ts L1   # default model is haiku; scenarios may pin their own
```

| Env | Meaning |
|---|---|
| `LANES_RUNNER_OUT` | Output folder (default `scripts/runner/results`, git-ignored): `runs/<run>/summary.json`, agent streams, `ledger.json` |
| `LANES_CAP_USD` | Budget guard, API-equivalent (default 40). The ledger is `<out>/ledger.json`, separate from the spike's |
| `CLAUDE_BIN` | claude executable (default `claude` on PATH) |
| `LANES_MODEL` | Model for agents that do not pin one |

Each agent runs with `LANES_HOME` pointing at a temp folder and `LANES_AUTOSTART=0`, so nothing touches `~/.lanes` or `~/.claude`.
Per run the summary lists task checks, tool errors, unpublished work, re-applies and leaks (planted secrets on `lanes/main` or in the server log).
