# Design decisions

The decisions that shape how Lanes works, one paragraph each, with the reason and what it costs. Other documents refer to them by number (for example ADR-0019).

## Coordination

<a id="adr-0004"></a>

### ADR-0004: Git stays the source of truth
Agents keep working in normal checkouts and worktrees. Lanes prevents two agents from editing the same file at the same moment instead of merging their edits afterwards, and it never syncs file contents through its own server.
**Why:** it works with every existing tool and CI, and no code leaves the machine. **Cost:** this is not live co-editing; conflicts in different files can still happen and are left to git.

<a id="adr-0005"></a>

### ADR-0005: Leases are enforced by an agent hook
A command hook (`node .lanes/hook.cjs <event>`) runs before every edit tool call. It has local git access, so it can work out the repository and the repo-relative path, and it is committed once for the whole team.
**Why:** a tool the agent calls voluntarily can be skipped; a wrapper around the agent would mean owning the agent. **Cost:** Node must be on the PATH.

<a id="adr-0006"></a>

### ADR-0006: One lease per file, taken implicitly
An exclusive lease is taken on the first edit of a file, renewed by each edit and released when the edit is published. A lease whose session has gone quiet expires, and a person can release one by hand.
**Why:** agents need no special behaviour and nothing stays locked forever. **Cost:** two agents editing different functions of one file still take turns.

<a id="adr-0015"></a>

### ADR-0015: A lease is handed over only after a sync
When a lease changes hands, the server records the commit of the previous holder's last change. The next agent's checkout is brought up to that commit before its edit goes ahead.
**Why:** without it, the second agent edits a stale copy and the conflict reappears at merge time. **Cost:** releasing a lease depends on publishing the edit first.

<a id="adr-0016"></a>

### ADR-0016: Wait in a queue, never deny
When a file is held, the hook waits quietly in a first-come, first-served queue. A lease lasts one edit, so a wait is normally about a second. The agent is never told to stop or to ask its user.
**Why:** in early tests, 31% of agents whose edit was denied stopped and asked their user what to do. **Cost:** an agent sits idle while it waits.

<a id="adr-0019"></a>

### ADR-0019: Never refuse an edit
The hook never blocks an edit. If the wait runs out (240 s), the sync fails or the server is down, the edit goes ahead and is committed locally, so it cannot be lost. Coordination being paused shows in the status bar and the views, never in the agent's conversation.
**Why:** a refused edit means a person has to re-prompt. **Cost:** while the server is down, coordination stops for that agent.

## Git

<a id="adr-0021"></a>

### ADR-0021: A shared branch on your own remote
Edits are published to `lanes/main` on the repository's existing remote: commit locally, fetch, rebase, push. Git refuses a push that is not a fast-forward, so the push itself is the compare-and-swap; a refused push is retried after another fetch and rebase.
**Why:** your existing credentials and remote; the Lanes server never sees code. **Cost:** `lanes/main` must accept fast-forward pushes from team members.

<a id="adr-0017"></a>

### ADR-0017: Every edit is attributed to its person
Each checkpoint commit is authored by the person who owns the agent and carries `Lanes-Agent:` and `Lanes-Task:` trailers. `git log` and `git blame` show who edited each line, and history is never squashed on `lanes/main`.

<a id="adr-0022"></a>

### ADR-0022: Checkpoint commits stay on the agent's branch
Each edit becomes a commit on the agent's working branch. At session start the agent is told, and only the agent, that this is expected. `lanes pr` squashes a task's commits into one branch for review.
**Why:** sync and attribution are built on real commits. Without the note, 8 of 8 agents in a test were confused by commits they did not make; with it, 0 of 8.

## Team context

<a id="adr-0018"></a>

### ADR-0018: Every prompt becomes a task
The first line of each prompt, at most 120 characters with secrets redacted, becomes a task on the team board with its predicted and touched files. Tasks that touch the same files are flagged in the views. `LANES_NO_PROMPT_TEXT=1` replaces the title with "Agent task".

<a id="adr-0028"></a>

### ADR-0028: Agents share team context, as information
With team context on for a repository, each prompt gets a short brief (who is working on what, new chat that mentions you), and an agent gets a one-line heads-up before it reads or edits a file a teammate is changing. Text written by a teammate is always quoted as data with its author named, never phrased as an instruction, and capped in length. The rules of ADR-0019 still hold.
**Why:** a lease cannot stop an agent from calling a function a teammate is renaming. **Cost:** a few hundred tokens per prompt, and teammate text reaches another person's agent, which is why it is quoted and capped.

### Requests need a person to approve them
A request to a teammate's agent reaches that agent only after its own user approves it, and it may edit files only if the sender allowed that and the receiver approved it. The MCP server has no approve tool, so an agent can never approve on a person's behalf. An approved request runs on the receiver's machine and subscription.

## Server and app

<a id="adr-0010"></a>

### ADR-0010: Agents run on each person's own machine
Lanes never runs agents and never asks for a model API key. Every agent runs under its owner's login and subscription; Lanes carries metadata only.

<a id="adr-0011"></a>

### ADR-0011: The server broadcasts full snapshots
After a change the server sends one full snapshot of the team's state over a WebSocket to every open view, at most every 50 ms, and once on connect.
**Why:** trivial clients, and a reconnect is always consistent. **Cost:** bandwidth grows with the state; measured at 64 agents and 60 viewers in the scale test.

<a id="adr-0023"></a>

### ADR-0023: Security baseline
Every request carries a bearer token, even on localhost, and the server refuses unexpected `Host` headers and non-JSON posts. Lanes commits only the files its agent changed during the turn, never secret-looking files or files over 1 MB, and runs the repository's own commit hooks. Hook state lives in `~/.lanes`, created private. Inputs are bounded in size and count. See [security](architecture/security.md).

<a id="adr-0029"></a>

### ADR-0029: The app is served by your own server
The browser app is a static page at `/app` on the Lanes server; `lanes app` opens it signed in. The token travels in the URL fragment, which the browser never sends, and is kept in `sessionStorage`. A strict Content-Security-Policy allows nothing from other origins, and teammate text is only ever rendered as text.

<a id="adr-0030"></a>

### ADR-0030: Personal member tokens
`lanes invite <name>` gives a teammate a personal token; the server stores only its SHA-256 hash and sets the caller's name from it, so nobody can post, lock or approve as someone else. `lanes remove` revokes a token at once.

<a id="adr-0031"></a>

### ADR-0031: Sign in with GitHub
A teammate invited by GitHub handle runs `lanes login` and approves a device code on github.com. The server binds the GitHub account id to a member token and drops the GitHub access token after reading the profile. It needs only a public OAuth client id (`LANES_GITHUB_CLIENT_ID`), no secret, and works on a LAN.
