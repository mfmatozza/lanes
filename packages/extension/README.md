# Lanes

See every teammate's coding agents and the files they hold, live in VS Code.

![The Lanes sidebar in VS Code: Agents (each teammate's agents, what they are doing and the files they hold), Tasks, and the Team view with a request to approve, a reply from a teammate's agent and the team chat](https://trylanes.app/assets/shots/lanes-team-dark.webp)

Website and beta: [trylanes.app](https://trylanes.app)

- **Agents view:** who is working on what, grouped by person: what each agent is doing, the last file it touched (open it with one click), and the files it holds. Hover for details.
- **Tasks view:** each person's tasks (every prompt you give an agent becomes one). Tasks that touch the same files are flagged so you can talk before you collide. It is a heads-up: nothing is blocked.
- **Needs merge:** when an agent's edits could not be shared with the team yet, the view says so and **Lanes: Review and Merge** opens a side-by-side of the shared version and your copy. Lanes never merges for you and nothing is lost: the agent's edits stay saved on its branch.
- **Stuck file:** a file held by an agent that has gone quiet is marked; **Lanes: Release File** frees it.
- **Team view:** your inbox of requests from teammates (Approve or Decline), the requests you sent and their replies, and the team chat. **Lanes: Ask a Teammate's Agent** and **Lanes: Message the Team** are its title buttons; **Lanes: Open Team App** opens the same in your browser.
- **Explorer badges:** the initials of whoever's agent is editing a file: orange for a teammate's agent, blue for yours. Hover to see who holds it.
- **Status bar:** agents active and waiting and requests waiting for you, or "connecting", "offline" (coordination paused), "token refused" or "server error". It turns amber while an agent waits for a file and red when edits need merging; hover for who is doing what.
- **Colours you can read at a glance:** each person has their own colour, and every agent shows its state: green working, amber waiting for a file, grey idle, red needs merge. They follow your theme, light, dark or high contrast.
- Lanes **never blocks an edit**. Agents that want the same file queue up for a moment and then carry on.

## What's new in 0.3

- **Team context for agents.** Run **Lanes: Turn On Team Context** (or `lanes team on`) and commit `.lanes/team.json`. Agents in that repository then get a short team brief with each prompt: who is working on what, and new chat messages. Before an agent edits or reads a file a teammate is changing, it gets a one-line heads-up. For an edit, when both sides' changed lines are known, it comes only if they are within a few lines of each other. In Claude Code, at the end of a turn, if a file the agent read changed under it, or a teammate's new file imports a file it changed, the agent is told once so it can check its work. Edits are never blocked. Off until you turn it on.
- **Team view.** A new view in the Lanes sidebar: requests waiting for you, with Approve and Decline, the requests you sent and their replies, and the team chat. A notification with Approve and Decline appears for each new request.
- **Requests and chat.** **Lanes: Message the Team** posts to the team chat, and agents see it in their next brief. **Lanes: Ask a Teammate's Agent** sends a request; it reaches their agent only after they approve it. Add `--edit` from the command line to let it change files. `lanes approve <id> --run` runs an approved request now with Claude Code or Codex and sends the answer back; a request that may edit runs on its own branch, `lanes/request-<id>`.
- **Browser app.** **Lanes: Open Team App** (or `lanes app`) opens the same team, files, chat and requests in your browser, served by the Lanes server at `/app`. It has a Ctrl K command palette, file search and an activity timeline, and works at phone width.
- **Personal tokens and GitHub sign-in.** The server owner runs `lanes invite <name> --github <account>`, and the teammate runs `lanes login --server <url>` and enters a code on github.com. Without GitHub, `lanes invite <name>` prints a `lanes join` command to send privately. With personal tokens nobody can post or approve as someone else, and `lanes remove <name>` revokes a token at once. **Lanes: Copy Sign-In Command** copies the sign-in line. GitHub sign-in needs `LANES_GITHUB_CLIENT_ID` set on the server.
- **Other coding agents.** `lanes init --agents <names>` (comma-separated) installs hooks or a plugin for Codex, Gemini CLI, Cursor, GitHub Copilot, Kiro, Antigravity, Factory Droid, Qwen Code, opencode, Kilo Code and Amp, and prints how to add `lanes mcp`, an MCP server with the team tools. Cursor, Copilot and Kiro edits are shared right after the edit, not queued before it. Only Claude Code has been run against the real agent; the other adapters are built from each agent's docs.

### 0.2

- Coloured state icons in the Agents and Tasks views, and a colour per person.
- Explorer badges in their own theme colours (`lanes.heldByTeammate`, `lanes.heldByYou`; change them under `workbench.colorCustomizations`).
- A status bar that changes icon and colour with the team's state, with a hover that lists who is editing what, who waits, and links into the views.
- Hovers on agents, people and held files that say what each state means in plain words.

## Requirements

- VS Code 1.95 or later (or Cursor, Windsurf and other forks that install `.vsix` files), and `git` on your PATH. The folder you open must be a git repository.
- [Node.js](https://nodejs.org) 22.18 or newer on your PATH: the Lanes hook is a `node` command that Claude Code runs.
- [Claude Code](https://claude.com/claude-code) for the agents themselves. Lanes watches Claude Code sessions through its hooks; it does not run agents.
- Other agents (Codex, Gemini CLI, Cursor, GitHub Copilot, Kiro and more) work through `lanes init --agents <names>`, or as MCP clients of `lanes mcp`. These adapters are built from each agent's docs and have not yet been run against the real agents.

## Install

- **Marketplace** (once the listing is live): search "Lanes" in the Extensions view, or run `code --install-extension MicheleFMatozza.lanes`.
- **Beta file:** `code --install-extension lanes-0.3.0.vsix` In Cursor and Windsurf use the Extensions view, `...` menu, **Install from VSIX**.

## Get started (about two minutes)

1. Open your repository in VS Code. A notification offers **Get Started** (the walkthrough, any time: Command Palette: **Welcome: Open Walkthrough**) once, until a server answers. If VS Code asks whether you trust the folder, choose **Trust**: Lanes is off in Restricted Mode, because it runs git and a local server.
2. Run **Lanes: Set Up Repository**. It adds the Lanes hook to the repository and commits it. Push that commit so teammates get it.
3. Start Claude Code in the repository. The first session starts a local server by itself, and its agent appears in the **Lanes** view in the Activity Bar within a second. **Lanes: Start Local Server** starts one from VS Code if you want it earlier.
4. Optional: run **Lanes: Turn On Team Context** and commit `.lanes/team.json` so agents get a short team brief with each prompt. The **Team** view holds requests and the team chat, and **Lanes: Open Team App** opens the same in your browser.

Setup adds a `.lanes/` folder and a `.claude/settings.json` hook to the repository; both belong in the commit. Each prompt you give an agent becomes its task title: teammates see it in the Tasks view, and it is the message of the agent's checkpoint commits on `lanes/main`.

## A team

One person hosts the server: **Lanes: Copy Team Server Command**, paste the line into a terminal on that machine, then **Lanes: Copy Teammate Join Message** and send the message to the team (it holds the team token: only to them). Everyone else runs **Lanes: Join Team Server** and pastes the address and token. The same can be done by hand with the settings `lanes.serverUrl` and `lanes.token`.

## From a terminal or an AI agent

The extension carries the command line tool. It is not on your PATH: run it as `node <extensions folder>/michelefmatozza.lanes-<version>/dist/lanes.cjs <command>` (the extensions folder is `~/.vscode/extensions`; the forks use their own folder). `init` does what **Lanes: Set Up Repository** does, `server --host 0.0.0.0` starts a team server, `connect --server <url> --token <token>` is the terminal form of **Lanes: Join Team Server**, and `off` switches Lanes off in a repository (removes the hooks and the `.lanes` folder and commits that). `status`, `doctor` (checks this machine and repository and says what to fix) and `--help` work too.

## If something looks wrong

- **Start with `lanes doctor`** (see [From a terminal](#from-a-terminal-or-an-ai-agent) for how to run the command line tool): one line per check, Node, git, the hooks in this repository, team context, the server and your token, Claude Code, each with what to do next.
- **`Lanes: offline` in the status bar:** no server answers at `lanes.serverUrl`. Run **Lanes: Start Local Server**, or check the address. It is normal before the first Claude Code session. **Lanes: Show Log** says what failed.
- **`Lanes: token refused`:** the server did not accept your token. If your team uses personal tokens, run **Lanes: Copy Sign-In Command** and paste it in a terminal (Sign in with GitHub), or run the `lanes join` command your admin sent you. Otherwise open the setting from the view and paste the team's token.
- **No agent appears:** the repository needs **Lanes: Set Up Repository** (once per repository, by anyone, then pushed), and Claude Code must be started in that folder.
- Your edits always go ahead, whatever state Lanes is in.

## Commands

| Command | What it does |
|---|---|
| Lanes: Start Local Server / Stop Local Server | Runs the Lanes server on this machine |
| Lanes: Set Up Repository | Adds the Lanes hook to the open repository and commits it |
| Lanes: Copy Team Server Command | Copies the terminal line that starts a team server on this machine |
| Lanes: Copy Teammate Join Message | Copies a message with this server's address and the team token for teammates |
| Lanes: Join Team Server | Asks for a server address and token and saves them as settings |
| Lanes: Reconnect | Connects to the server again |
| Lanes: Show Log | Opens the Lanes log |
| Lanes: Release File | Frees a file held by an agent (button on the file in the view) |
| Lanes: Message the Team / Ask a Teammate's Agent | Posts to the team chat, or sends a request that reaches a teammate's agent once they approve it |
| Lanes: Approve Request / Decline Request | Answers a request from a teammate (buttons on the request in the Team view) |
| Lanes: Open Team App | Opens the Lanes app in your browser, signed in |
| Lanes: Turn On Team Context | Gives agents in this repository a short team brief with each prompt (commit `.lanes/team.json`) |
| Lanes: Turn Off Team Context | Stops the team brief for agents in this repository (commit `.lanes/team.json`) |
| Lanes: Copy Sign-In Command | Copies the terminal line that signs you in with GitHub, for teams that use personal tokens |
| Lanes: Open Agent's File | Opens the file an agent touched last (button on the agent) |
| Lanes: Open Overlapping File | Opens a file two tasks share (click on an overlap in the Tasks view) |
| Lanes: Review and Merge | Compares the shared version with your copy (button on a needs-merge item) |
| Lanes: Mark as Merged | Hides a needs-merge item once you have dealt with it |

## Settings

| Setting | Meaning |
|---|---|
| `lanes.serverUrl` | The Lanes server. Default `http://127.0.0.1:4317` (this machine), or the server `lanes join` / `lanes login` saved. Also written to `~/.lanes/config.json` so the agent hooks use it |
| `lanes.token` | Team token or personal token. Empty uses the personal token `lanes join` / `lanes login` saved, or the token in `~/.lanes/token` (a server on this machine) |
| `lanes.userName` | Name shown to teammates. Empty uses the name `lanes join` / `lanes login` saved, then `git config user.name` |

## Remote development

Lanes runs where your code is: with Remote - SSH, WSL or a Dev Container it is installed in the remote window, and the server and the agent hooks run there too. Claude Code must run in the same place as the folder you opened.

## Privacy

Only file paths, names and statuses are sent to the server. File contents never leave your machine. There is no telemetry.

Lanes keeps a small local file, `~/.lanes/ledger.jsonl`, that counts how coordination went (time, a hash of the repository, coordinated, queued or uncoordinated, milliseconds; never paths, contents, prompts or names). Run `lanes report` to see it. When some edits went ahead without the server this week, the status bar tooltip says how many. Nothing is sent anywhere unless you send it yourself.
