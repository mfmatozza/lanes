# VS Code extension

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-28
> [Docs](../README.md) › Architecture › VS Code extension · [← Agent integration](agent-integration.md) · [Security →](security.md)

## 1. UI surfaces

```text
┌ Activity bar: Lanes ─────────────────────────┐   Explorer
│ AGENTS                               ⟳        │   src/
│ ▾ 👤 Ana (you)            2 agents            │     auth/
│   ▾ ⟳ app-wt-refresh   editing session.ts     │       session.ts      A   ← badge = holder initials
│       🔒 session.ts     src/auth               │     billing/
│   ▸ ○ app               idle                  │       plan.ts         B
│ ▾ 👤 Bea                  1 agent             │
│   ▾ ⚠ app              blocked on session.ts  │   Status bar:
│       🔒 plan.ts        src/billing      [🔓] │   $(pulse) 3 agents  $(warning) 1
└───────────────────────────────────────────────┘
```

| Surface | Contents | Story |
|---|---|---|
| **Agents view** (activity bar container `lanes`, view `lanes.agents`) | Humans (you first), then their agents (status icon, description with the state, last file and active task; a tooltip with everything in full sentences), then each agent's leases. Agents queued for a file show as *waiting*; agents whose edits could not be shared show as *needs merge*. Inline buttons: open the agent's last file, release a lease. Groups at the bottom: **Needs merge**, **Problems**, **Files held by no agent**. A lease whose holder has been quiet for over 2 minutes says so | V1, V2, V4, C5 |
| **Tasks view** (view `lanes.tasks`, under the Agents view) | The task board of [ADR-0018](../decisions/0018-automatic-tasks-and-overlap.md): per person (you first), their active tasks (newest first) and their last three finished ones. A task with files in common with another person's or agent's active task is flagged (*overlaps with Bea on 2 files*) and expands to one line per overlapping task with the shared files; clicking it opens the first shared file. Overlaps are computed from the snapshot (same rule as the server: predicted or touched files intersect, same repository, different agent). A heads-up only: nothing is blocked | ADR-0018 |
| **File decorations** | A badge with the holder's initials on leased files, in the contributed theme colours `lanes.heldByYou` (blue) and `lanes.heldByTeammate` (orange); tooltip "Held by Ana's agent — your agent will wait for it". Only files whose holder changed are refreshed on each snapshot. Tree icons use theme colours too: each person a stable `charts.*` colour (you always blue), agents green working, amber waiting, muted idle, red needs merge | V3 |
| **Status bar** | Connection state, agent count, blocked count; `$(pulse)` running, `$(watch)` with the warning background while agents wait, the error background only for needs merge; a Markdown tooltip with who edits what, who waits, held files and links into the views; click to open the Agents view. When some edits went ahead without the server this week, the tooltip adds "N edits went ahead uncoordinated this week" (from `Snapshot.uncoordinated`, [protocol](protocol.md#uncoordinated-edits)) | V5 |
| **Warning notification** | Once per lease, when a human edits a leased file | C6 |
| **Welcome view** (the view's states without content) | **Connecting** (first connection), **Offline** (*Start Local Server*, *Set Up Repository*, *Reconnect*), **Token refused** (opens the `lanes.token` setting), **Server error** (*Show Log*), and **Empty**: connected, but no agent is running yet. Every text says that edits still go ahead. The status bar and its tooltip say the same (`Lanes: connecting…`, `offline`, `token refused`, `server error`) | S1, S3 |

## 2. Commands

| Command ID | Title | Notes |
|---|---|---|
| `lanes.startServer` | Lanes: Start Local Server | Runs the bundled server with VS Code's own Node runtime (`ELECTRON_RUN_AS_NODE=1`); logs to the output channel |
| `lanes.stopServer` | Lanes: Stop Local Server | |
| `lanes.setupRepository` | Lanes: Set Up Repository | Same as `lanes init`: copies `.lanes/hook.cjs` and `server.cjs`, merges hooks into `.claude/settings.json`, commits only those files, then creates or fetches `lanes/main` (on `origin`, or locally without one) and reports which. Refuses a home folder and invalid settings JSON |
| `lanes.reconnect` | Lanes: Reconnect | Also a refresh icon in the view title |
| `lanes.showLog` | Lanes: Show Log | Opens the output channel; the *Server error* state offers it |
| `lanes.releaseLease` | Lanes: Release File | Inline action on lease items only. Says so if the server did not answer. Safe on a live agent: its edit is never blocked either way |
| `lanes.openAgentFile` | Lanes: Open Agent's File | Inline action on an agent that has touched a file; opens it from the open folder that is a checkout of the same repository |
| `lanes.reviewMerge` | Lanes: Review and Merge | The click and inline button on your own *needs merge* items. Opens a read-only side-by-side of the shared branch's version and this checkout's copy; lists the unshared files when the item names none. Writes nothing to the repository ([journey 6](../product/user-journeys.md#journey-6-some-edits-could-not-be-shared-needs-merge)) |
| `lanes.openTaskFile` | Lanes: Open Overlapping File | The click on an overlap line in the Tasks view; opens the first shared file from the open folder |
| `lanes.dismissMerge` | Lanes: Mark as Merged | Hides a needs-merge item until something newer happens |

## 3. Settings

| Setting | Default | Description |
|---|---|---|
| `lanes.serverUrl` | `http://127.0.0.1:4317` | Coordination server URL |
| `lanes.token` | `""` | Team token. Empty uses `~/.lanes/token` for a server on this machine (the server always requires one, ADR-0023). Both `lanes.serverUrl` and `lanes.token` are also saved to `~/.lanes/config.json` so the hooks use them (#123) |
| `lanes.userName` | `""` | Display name; empty means `git config user.name`, then the OS user name |

## 4. Internal design
- **`LanesClient`:**
  - WebSocket connection to `/v1/events` ([protocol](protocol.md#ws-v1events)) with exponential reconnect (1 s → 30 s), falling back to polling `GET /v1/state` (once a second, backoff to 15 s) whenever the stream is down.
  - Holds the latest snapshot, plus a lease index keyed by `repo + path`.
  - Exposes an `onDidChange` event.
- **Repository resolution:** shares the core library with the hook, so editor and agent map files to leases identically. Results are cached per checkout root, so git runs once per root, never per file.
- **No blocking work on the UI path.** Decorations are looked up in memory and git calls are cached.
- **Activation:** `onStartupFinished`.
- **Packaging:**
  - Bundled with esbuild into `dist/`: the extension, `server.js` and `hook.cjs`.
  - Packaged with `vsce package --no-dependencies`.
  - Published to the VS Code Marketplace **and** Open VSX (for Cursor and Windsurf).

## 5. Implementation status (2026-10-24)
- Built: agents view (with a Problems node for recent sync-failed / publish-blocked / publish-add-failed / publish-conflict / retries-exhausted / wait-overrun observations, and a node for files held by no agent that can be released; the status bar gets a warning count and tooltip lines for them, #130), explorer badges, status bar (online/offline, click to start the server), commands, the human-edit warning (C6), release from the view, `.vsix` packaging. View logic lives in `model.ts` (unit-tested); the bundle is smoke-tested against a stub of the VS Code API and a live server.
- **WebSocket first, polling as fallback (#48):** the client connects to the `/v1/events` stream of [ADR-0011](../decisions/0011-snapshot-broadcast.md) (Node's built-in `WebSocket` is missing in the Node 20 that VS Code 1.95 ships, so it uses the same small codec as the server). While the stream is open it does not poll; if it cannot connect or drops, it polls as before (backoff to 15 s when offline) and retries the stream with backoff. A stream that is silent for 50 s is treated as dead.
- **Agents view by person (#55):** state, last file, open file, release a stuck lease, and *needs merge* with a one-click read-only review (journey 6). *Needs merge* is what the hook reports as `publish-blocked`, `publish-conflict` or `publish-retries-exhausted`: edits saved on the agent's branch, not shared. It shows for 6 hours or until marked as merged. shortcut: "Mark as merged" is not remembered across restarts, and nothing detects that a merge happened.
- **Task board with overlaps (#60):** the Tasks view, with the same connecting, offline, token-refused, server-error and empty states as the Agents view (context key `lanes.tasksState`). shortcut: the board lists what the snapshot holds (the server keeps the last 1,000 tasks and forgets everything on a restart), and shows at most 3 finished tasks per person.
- Not yet: squash per task in the editor (b.8; `lanes pr` exists in the CLI).
