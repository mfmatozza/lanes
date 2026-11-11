# Glossary

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-26
> [Docs](../README.md) › Product › Glossary · [← UX principles](ux-principles.md)

| Term | Definition |
|---|---|
| **Agent** | One running coding-agent session (for example one `claude` process), identified by its session ID. Always owned by exactly one **human**. |
| **Human / user** | A person on the team. Owns zero or more agents. |
| **Lease** | Temporary, exclusive permission for one **holder** to edit one file in one **repository**. It lasts **one edit** and is released when the edit is published; a TTL covers crashes. Requests for a held file wait in a fair **queue**. |
| **Holder** | The agent session (or, later, the human) that currently owns a lease. |
| **TTL (time-to-live)** | How long a lease survives if its holder crashes before publishing. A lease held during a manual edit approval lasts up to 30 minutes. |
| **Queue** | The fair, first-come order in which agents wait for a held file. A wait is typically under a second and never longer than 240 s. |
| **Needs merge** | An agent whose latest edits are committed on its own branch but could not be published to the shared branch (they depend on unshared commits, a git operation is in the way, or the branch stayed busy). Nothing is lost or refused. The view offers **Review and merge**, a read-only comparison ([journey 6](user-journeys.md#journey-6-some-edits-could-not-be-shared-needs-merge)). |
| **Publish** | Committing an edit and pushing it to the integration branch, which releases the lease. |
| **Sync** | Silently bringing the newest published content of a file into an agent's worktree before its edit. The agent gets a neutral re-read note that never names a teammate. |
| **Integration branch** | `lanes/main` on `origin`: where every published edit lands. The server decides the order; git holds the content. |
| **Overlap** | Two active tasks of different agents whose predicted or touched files intersect. Shown in the server and in the **Tasks** view (flagged with the shared files), never in the agent's conversation. It is a heads-up for people, not a block: both agents carry on. |
| **Task** | A group of edits detected automatically for one agent, used for overlaps and for squashing into one PR. |
| **Repository ID** | A stable identifier shared by every clone and worktree of a repository: the normalized `origin` URL, or the path of the shared `.git` directory if there's no remote. |
| **Repo-relative path** | A file's path relative to its checkout root, with forward slashes. Together with the repository ID, it identifies a file across machines and worktrees. |
| **Checkout / worktree** | One working copy of a repository. An agent often runs in its own git worktree. |
| **Coordination server** | The process that holds agents and leases and broadcasts state. Runs locally or on a teammate's machine in the MVP. |
| **Hook** | The script Claude Code runs at lifecycle events (before and after a tool runs, session start and end). This is how Lanes coordinates agents. It never blocks an edit. |
| **Fail open** | What Lanes does when the server is unreachable: the edit goes ahead and the views show "Lanes: offline". Lanes never fails closed ([ADR-0019](../decisions/0019-never-refuse-an-edit.md)). |
| **Lane** | Informal: the set of files an agent is currently working in. |
