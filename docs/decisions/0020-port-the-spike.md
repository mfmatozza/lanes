# ADR-0020: Port the spike code into the product packages

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** Phase 3 plan · [Repository structure](../engineering/repository-structure.md) · [Spike v3 report](../research/spike-v3-report.md)

## Context
The spike was planned as throwaway code. Three rounds later it is about 1,300 lines with more than 60 tests, and its behaviour is exactly what more than 150 real agent sessions validated:
- queued leases;
- version-aware sync;
- per-edit publish to a remote branch;
- never refusing an edit;
- a hook p95 under 100 ms.

## Decision
**Port, don't rewrite.** Each spike module moves into its package with its tests:

| Spike | Package |
|---|---|
| `repo.ts`, `types.ts`, `settings.ts` | `@lanes/core` |
| `coordinator.ts`, `server.ts`, `main.ts` | `@lanes/server` |
| `hook.ts`, `gitops.ts` | `@lanes/hook` (bundled to `hook.cjs`) |
| `runner/` | `tools/scenarios` (kept as the regression suite) |

Porting means: split the code into the packages, apply strict type-checking, remove spike-only switches (`observeShell`, `/v1/check`), and keep every test passing at every step. `spike/` is deleted once regression a.9 passes on the packages.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Port (chosen)** | Keeps validated behaviour and its tests; fastest | Spike shortcuts must be found and cleaned up |
| Rewrite from the docs | Clean slate | Weeks of work to re-learn what the spike already proved (e.g. git identity, Windows process trees, note wording) |

## Consequences
- **Positive:** stage 3a shrinks; the scenario runner becomes a permanent regression test.
- **Negative:** spike-era names and shortcuts need a deliberate clean-up pass during the port.
