# Product requirements: MVP

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-24
> [Docs](../README.md) › Product › Requirements · [User journeys →](user-journeys.md)

## 1. Goal
Let a team of 2–10 people, each running Claude Code in VS Code on the same git repository:
1. **see** every teammate's agents live; and
2. **prevent** two agents from clobbering each other's edits to the same file, without ever refusing an edit or asking a user to re-prompt,

with setup taking under 5 minutes.

## 2. Personas

| Persona | Description | Main need |
|---|---|---|
| **Ana, the agent-heavy engineer** | Runs 2–3 Claude Code sessions all day, usually in worktrees | "Don't let my agents and my teammates' agents clobber each other." |
| **Theo, the tech lead** | Reviews PRs, plans the work, runs an agent part-time | "Show me what everyone's agents are doing right now." |
| **Sam, the setup owner** | The person who installs tools for the team (often Theo) | "Set-up must be one command, and it must not break anyone's workflow." |

## 3. User stories
Priority uses **MoSCoW**: **M**ust / **S**hould / **C**ould / **W**on't (in the MVP).

### Visibility
| ID | Story | Priority |
|---|---|---|
| V1 | As Ana, I see a list of every active agent on my team, grouped by person, so I know who's working on what | M |
| V2 | As Ana, I see each agent's state (working / idle / blocked) and the file it last touched | M |
| V3 | As Ana, I see which files are leased, and by whom, directly in the VS Code file explorer | M |
| V4 | As Ana, I can open any leased file from the agents view | S |
| V5 | As Theo, I see a status-bar summary (agents active, agents blocked) without opening a panel | S |
| V6 | As Theo, I can see today's coordination history: waits, overlaps and offline periods | C |

### Coordination
| ID | Story | Priority |
|---|---|---|
| C1 | As Ana, when my agent tries to edit a file another agent holds, the edit **waits in a fair queue** (up to 240 s, typically under a second) and then goes ahead on the latest shared content. It is **never refused** ([ADR-0019](../decisions/0019-never-refuse-an-edit.md)) | M |
| C2 | As Ana, a lease is taken automatically for each edit and released when the edit is published, so a lease lasts one edit; my agent doesn't need to do anything special | M |
| C3 | As Ana, leases expire on their own (TTL) if an agent crashes or stops, so nothing stays locked. A lease held while the user decides on a manual approval lasts up to 30 min | M |
| C4 | As Ana, my agent's leases are released when its session ends | M |
| C5 | As Ana, I can manually release a stuck lease from the agents view, and resolve a "needs merge" state with one click | M |
| C6 | As Ana, I'm warned when I hand-edit a file that an agent currently holds | S |
| C7 | As Ana, two of *my own* agents also can't edit the same file at once | M |
| C8 | As Ana, my agent can ask who holds a file *before* trying to edit it (via an MCP tool) | C |
| C9 | Symbol-level (function/class) leases | W |

### Setup & operations
| ID | Story | Priority |
|---|---|---|
| S1 | As Sam, one VS Code command sets a repository up for Lanes (installs the hook and Claude Code settings) | M |
| S2 | As Sam, I commit the setup so every teammate and every new worktree gets it automatically | M |
| S3 | As Ana, I can start a local coordination server from VS Code with one command | M |
| S4 | As Theo, I can run the server on one machine and teammates on the same network connect to it with a URL and token | M |
| S5 | As Ana, if the server is unreachable my edits **go ahead** (fail open, [ADR-0019](../decisions/0019-never-refuse-an-edit.md)); a local server is started automatically, and the status bar shows "Lanes: offline" until it is back | M |
| S6 | As Ana, with one click in the status bar I can restart the server when it is offline | S |
| S7 | Hosted server, accounts, SSO | W |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| N1 | **Latency:** the hook adds < 100 ms p95 per edit on localhost, and < 300 ms on a LAN. What is measured, precisely (#132): the wall-clock time of one `PreToolUse` hook process (`pre`), from spawn to exit, as the agent waits for it before an edit, on a warm server with nothing to wait for (a lease queue is not latency), a local origin (no network time; a real remote adds one `ls-remote` round trip to a `pre` that syncs and to every `post`, plus one push to a `post`) and a repository of 300 files, with the repository identity cached or not. It includes Node's own start-up (about 35 ms on a laptop, a floor). `post` (`PostToolUse`, which commits and publishes) and `start` are reported separately and are **not** held to the 100 ms: `post` runs git (status, add, commit, ls-remote, a replay and a push) and is bounded by process launches (25-60 ms each on Windows, 3-8 ms on Linux and macOS), so it is minimised, not bounded. Reproduce with `npm run build && npm run bench` ([`scripts/bench-hook.ts`](../../scripts/bench-hook.ts)) |
| N2 | **Privacy:** file **contents** never leave the user's machine. Only repo-relative paths, user names, session IDs and statuses are sent |
| N3 | **Platforms:** Windows, macOS and Linux. VS Code ≥ 1.95 and compatible forks (Cursor, Windsurf) via Open VSX |
| N4 | **Resilience:** extension reconnects automatically; server restart loses only in-memory leases (acceptable for the MVP) |
| N5 | **Footprint:** the extension doesn't noticeably slow down VS Code (no blocking work on the UI thread) |
| N6 | **Correctness:** the same file reached from different worktrees or clones of one repository maps to the **same lease** |
| N7 | **Observability:** a "Lanes" output channel logs connection events and errors |
| N8 | **Never refuse:** zero refused edits and zero "ask the user" events caused by Lanes, in every failure mode (server down, remote down, sync failure) |
| N9 | **No lost work:** every edit is committed and published, or committed locally when the remote is unreachable. Zero data-loss bugs |
| N10 | **Security:** token on every request, even on localhost; private `~/.lanes`; secrets never published ([ADR-0023](../decisions/0023-security-baseline.md)) |

## 5. Out of scope for the MVP (non-goals)
- Agents other than Claude Code. The protocol is designed for them, but there are no adapters yet.
- Editors other than VS Code-compatible ones.
- Merge queue, conflict prediction, symbol leases.
- Persistent storage, accounts, hosted service.
- Blocking shell commands (Bash). Files an agent creates through the shell are published at the end of its turn instead ([ADR-0022](../decisions/0022-checkpoint-commits-on-the-agent-branch.md)).

## 6. Acceptance: MVP is done when
- [ ] All **Must** stories pass their acceptance tests (in each story's GitHub issue).
- [ ] The scenario in [Journey 2](user-journeys.md#journey-2-a-collision-is-handled-without-anyone-noticing) works end to end on Windows and macOS.
- [ ] The MVP metrics are met during 2 weeks of dogfooding.
