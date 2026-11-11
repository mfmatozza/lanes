# Decision log (ADRs)

> [Docs](../README.md) › Decisions

We record every significant product or technical decision as an **Architecture Decision Record**, using the [template](template.md). See [ADR-0001](0001-record-architecture-decisions.md) for why and how.

**Statuses:** `Proposed` → `Accepted` | `Rejected` · later `Superseded by ADR-XXXX` | `Deprecated`

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record decisions as ADRs | Accepted | 2026-10-22 |
| [0002](0002-coordination-layer-not-editor.md) | Build a coordination layer, not an editor | Accepted | 2026-10-22 |
| [0003](0003-vscode-extension-first.md) | VS Code extension as the first client | Accepted | 2026-10-22 |
| [0004](0004-git-is-source-of-truth.md) | Git is the source of truth; no CRDT for agent writes | Accepted | 2026-10-22 |
| [0005](0005-claude-code-hooks-enforcement.md) | Enforce leases through Claude Code hooks | Accepted | 2026-10-22 |
| [0006](0006-file-level-leases-with-ttl.md) | File-level leases with a time-to-live | Accepted | 2026-10-22 |
| [0007](0007-fail-closed.md) | Fail closed when the server is unreachable | Superseded by [0019](0019-never-refuse-an-edit.md) | 2026-10-22 |
| [0008](0008-typescript-monorepo.md) | TypeScript monorepo (npm workspaces, esbuild) | Accepted | 2026-10-22 |
| [0009](0009-working-name.md) | "Lanes" as a working name | Accepted | 2026-10-22 |
| [0010](0010-local-first-byo-agent.md) | Local-first, bring your own agent | Accepted | 2026-10-22 |
| [0011](0011-snapshot-broadcast.md) | Broadcast full state snapshots | Accepted | 2026-10-22 |
| 0012 | Proceed on founder conviction, without upfront customer validation | Accepted | 2026-10-22 |
| [0013](0013-open-core.md) | Open core, made public at the private beta | Accepted | 2026-10-22 |
| [0014](0014-positioning-intent-visibility.md) | Position on intent visibility and early conflict warnings, not file locks | Accepted | 2026-10-22 |
| [0015](0015-lease-handoff-requires-sync.md) | Lease handoff requires sync (version-aware leases) | Accepted | 2026-10-22 |
| [0016](0016-non-blocking-coordination.md) | Coordination happens in the background and never interrupts the user | Accepted | 2026-10-22 |
| [0017](0017-edit-attribution.md) | Every edit is signed with the person (and agent) who made it | Accepted | 2026-10-22 |
| [0018](0018-automatic-tasks-and-overlap.md) | Tasks are created automatically from prompts, and overlaps are detected up front | Accepted | 2026-10-22 |
| [0019](0019-never-refuse-an-edit.md) | Never refuse an agent's edit (fail open; supersedes 0007) | Accepted | 2026-10-22 |
| [0020](0020-port-the-spike.md) | Port the spike code into the product packages | Accepted | 2026-10-22 |
| [0021](0021-remote-integration-branch.md) | The integration branch lives on the team's git remote | Accepted | 2026-10-22 |
| [0022](0022-checkpoint-commits-on-the-agent-branch.md) | Checkpoint commits stay on the agent's branch, and the agent is told so | Accepted | 2026-10-22 |
| [0023](0023-security-baseline.md) | Security baseline: a token on every request; Lanes commits only what its agent edited | Accepted | 2026-10-23 |
| [0024](0024-opt-in-telemetry.md) | Usage telemetry is opt-in, off by default, and minimal | Proposed | 2026-10-26 |
| [0025](0025-prompt-title-default.md) | Task titles from prompts are opt-in per repository | Proposed | 2026-10-26 |
| [0026](0026-protected-open-core-licence.md) | Protected open core: Apache-2.0 clients, source-available server, closed paid product | Proposed | 2026-10-28 |
| 0027 | Willingness to pay is read from behaviour and voluntary written signals, never from conversations | Proposed | 2026-10-28 |
| [0028](0028-agents-share-team-context.md) | On the multiplayer track, agents are told what their teammates are doing (amends 0016, 0019) | Proposed | 2026-11-01 |
| [0029](0029-lanes-app-in-the-browser.md) | Lanes gets an app in the browser, served by the Lanes server | Proposed | 2026-11-01 |
| [0030](0030-personal-member-tokens.md) | Each teammate gets a personal token, and the server decides who is calling | Proposed | 2026-11-01 |
| [0031](0031-sign-in-with-github.md) | Teammates sign in with GitHub; agents run on each person's own subscription | Proposed | 2026-11-01 |
| [0032](0032-apache-2-for-everything.md) | Apache-2.0 for everything in the public repository | Accepted | 2026-11-11 |

**Open decisions (not yet written up):** hosted-tier persistence store · contributor agreement (DCO for the Apache parts, CLA for the server: see ADR-0026) · name confirmation after the clearance search (Phase 4, #156).
