# User journeys

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-26
> [Docs](../README.md) › Product › User journeys · [← Requirements](requirements.md) · [UX principles →](ux-principles.md)

## Journey 1: First-time team setup
**Actor:** Sam (setup owner) · **Stories:** S1–S4

1. Sam installs the Lanes extension from the Marketplace.
2. Sam runs **`Lanes: Start Local Server`**. The status bar shows `Lanes: 0 agents`.
3. Sam runs **`Lanes: Set Up Repository`** (or `lanes init`). Lanes checks push access to `lanes/main`, then:
   - adds `.lanes/hook.cjs` to the repository;
   - merges the Lanes hooks into `.claude/settings.json`, keeping any existing hooks;
   - writes Sam's personal settings (server URL, name) to `~/.lanes/config.json`.
4. Sam commits both files and opens a PR: *"Set up Lanes"*.
5. Sam runs **`Lanes: Copy Team Server Command`**, pastes it in a terminal on the host machine, then **`Lanes: Copy Teammate Join Message`** and sends the message. Teammates pull and run **`Lanes: Join Team Server`** (or `lanes connect --server <url> --token <token>`, or set `lanes.serverUrl` and `lanes.token`: all save them for the hooks too). Exact commands: [install-verified.md](install-verified.md).

**Success:** within 5 minutes, every teammate's status bar shows the same agent count.

## Journey 2: A collision is handled without anyone noticing
**Actors:** Ana and Bea · **Stories:** V1–V3, C1–C3

```mermaid
sequenceDiagram
    actor Ana
    participant AA as Ana's agent
    participant L as Lanes server
    participant BA as Bea's agent
    actor Bea
    AA->>L: PreToolUse: Edit src/auth/session.ts
    L-->>AA: go ahead (lease granted for this edit)
    L-->>Bea: (VS Code) session.ts shows Ana's badge
    BA->>L: PreToolUse: Edit src/auth/session.ts
    Note over BA,L: waits in the queue (typically under 1 s)
    AA->>L: PostToolUse: publish (commit, push to lanes/main)
    L-->>BA: go ahead; hook syncs the new content silently
    BA->>BA: neutral note: "session.ts changed, re-read it"
    BA->>L: publish its own edit on top of Ana's
```

**Success:** both edits land on `lanes/main` with no conflict. Bea's agent was never refused and never asked Bea anything. Bea's Agents view showed "waiting on session.ts" for a moment, and her agent's conversation never mentions Ana or Lanes.

## Journey 3: A human edits a file an agent holds
**Actor:** Theo · **Story:** C6
1. Theo opens `session.ts` and starts typing.
2. A notification appears once: *"Ana's agent is editing src/auth/session.ts right now. Your changes may conflict."*
3. Theo either stops and messages Ana, or carries on knowingly. Lanes doesn't block humans.

## Journey 4: A stuck lease
**Actor:** Ana · **Story:** C5
1. Ana's laptop went to sleep mid-edit, so her agent's lease on `api.ts` is still live.
2. Bea's agent waits in the queue. Bea sees in the Agents view that `api.ts` is held by Ana's agent, last active 8 minutes ago.
3. Either the lease expires on its own (TTL) and Bea's agent goes ahead, or Bea right-clicks it → **Release lease**. The release is logged in the output channel.
4. If the two edits overlap, the file moves to the newer content, the older version is kept in `refs/lanes/backup/...`, and only the agent is told to re-apply its change. Nothing is lost.

## Journey 5: The server is down
**Actor:** Ana · **Stories:** S5, S6
1. Ana's agent tries to edit a file and the hook can't reach the server.
2. For a local server, the hook starts it automatically. Otherwise the edit **goes ahead** with coordination paused; the agent is told nothing and nothing is blocked.
3. The status bar shows **`Lanes: offline`**. One click restarts the server.
4. Every edit made meanwhile is still committed (and pushed once the remote is reachable), so the worst case is a rebase conflict that the views flag.

## Journey 6: Some edits could not be shared ("needs merge")
**Actor:** Bea · **Story:** C5

*When it happens.* After an edit, Lanes commits it on the agent's branch and publishes it to `lanes/main`. Sometimes it cannot publish: the edit depends on a commit Bea has not shared, a git operation (a rebase, a merge) is in progress in her checkout, or the shared branch stayed busy. The edit is **never refused and never lost**: it stays committed on the agent's branch, only not shared yet.

1. Bea's Agents view shows her agent as **needs merge**, and a **Needs merge** group lists what is waiting: who, how many files and why, in plain words ("Edits kept local: they depend on unshared commits"). The status bar shows a warning count.
2. Bea clicks **Review and merge** (the item, or its inline button). Lanes opens, for the file, a side-by-side comparison: the shared version on the left, the file as it is in Bea's checkout (with her agent's edit) on the right. If the item names no file (a busy branch, a git operation in progress) Lanes lists the files that differ from the shared branch and Bea picks one.
3. Bea merges as she would any change: edits the right-hand side, saves, commits and pushes in her usual way. **Lanes changes nothing for her.** It never merges, rewrites history, resets or discards anything, and it never blocks an edit while she decides.
4. Bea clicks **Mark as merged**. This only hides the flag in her view. A newer problem of the same kind shows it again.

**What one click does, and does not do**

| Does | Does not |
|---|---|
| Open a read-only comparison of the shared version and her copy | Write to the repository, the index or any branch |
| Hide the flag when Bea says it is done | Delete the agent's commits (they stay on its branch, so the work is safe even if Bea never merges) |
| Work only for Bea's own agents, in a folder she has open | Act on a teammate's checkout (their items are shown, read-only, so Bea knows why a file is behind) |

**Success:** nothing the agent wrote is lost, no edit was refused, and Bea needed one click to see exactly what differs.

## Journey 7: Two tasks are about to overlap
**Actors:** Ana and Bea · **Story:** ADR-0018 (Should)

1. Ana asks her agent to "refactor `src/auth/session.ts`". The prompt becomes a task: the title is its first line and the files it mentions are *predicted*.
2. A little later Bea asks hers to "add rate limiting to `src/auth/session.ts` and `src/api.ts`".
3. Bea's **Tasks** view lists tasks per person. Her task shows a warning, *overlaps with Ana on 1 file*, and expands to *Ana: "refactor session.ts" · session.ts*. Ana sees the same on hers. Clicking the overlap opens the shared file.
4. They may talk, reorder their work, or ignore it. **Nothing is blocked and neither agent is told**: the queue and silent sync still keep the edits apart ([ADR-0018](../decisions/0018-automatic-tasks-and-overlap.md), [ADR-0019](../decisions/0019-never-refuse-an-edit.md)).
5. When a task is done the warning goes away. Done tasks stay listed for a while (the last three per person, greyed).

**Empty, offline and error states:** with no tasks the view says *No tasks yet. Each prompt you give an agent becomes a task here.* Offline, a refused token and a server error show the same messages as the Agents view, and say that edits still go ahead.
