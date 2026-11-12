# Lanes command-line reference

The `lanes` command sets up a repository, runs or joins a team server, and gives people and agents the team tools: chat, requests to a teammate's agent, and the team's status. Everything the VS Code extension does can also be done from here.

## Running the CLI

The CLI and the MCP server run in any terminal. You do not need VS Code or any editor. During the beta there is no `lanes` on your PATH yet; you run one file with Node (22.18 or newer).

Clone and build once:

```sh
git clone https://github.com/mfmatozza/lanes
cd lanes && npm ci && npm run build
node dist/lanes.cjs <command>
```

An alias saves typing:

```sh
alias lanes="node /path/to/lanes/dist/lanes.cjs"
```

If you also installed the optional VS Code extension, it carries the same file, so you can skip the build and run `node ~/.vscode/extensions/michelefmatozza.lanes-<version>/dist/lanes.cjs <command>`. Cursor, Windsurf and other forks keep extensions in their own folder.

`npx lanes` is planned. It is not available yet.

In the examples below, `lanes` stands for whichever of these you use.

Help for every command, or for one:

```sh
lanes --help
lanes <command> --help
lanes help <command>
```

Most commands work on the repository that contains the current folder. Where a command takes `--dir <repo>`, it uses that folder instead.

Exit codes: `0` on success, `1` when a correct command fails (for example the server is offline for `lanes status`, or a `lanes doctor` check fails), `2` when the command line is wrong (an unknown command or option, a missing argument).

## Commands

| Group | Commands |
|---|---|
| Setup | [init](#init), [off](#off), [doctor](#doctor), [status](#status) |
| Team server | [server](#server), [connect](#connect), [invite](#invite), [join](#join), [login](#login), [members](#members), [remove](#remove) |
| Team context | [team](#team), [say](#say), [ask](#ask), [requests](#requests), [approve](#approve), [deny](#deny) |
| App and agents | [app](#app), [mcp](#mcp), [report](#report), [pr](#pr), [hosted](#hosted) |

## Setup

### init

```
lanes init [--dir <repo>] [--no-commit] [--server <url>] [--token <token>] [--user <name>] [--agents <names>]
```

Sets up Lanes in a repository. It copies the hook and the server into `.lanes/`, merges the hooks into `.claude/settings.json`, commits only those files and prepares the `lanes/main` branch. It is safe to run again. Run from a subfolder of a monorepo, it also writes `.claude/settings.json` in that subfolder, because Claude Code only reads the settings of the folder it starts in.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository to set up. Default: the current folder. |
| `--no-commit` | Write the files but do not commit them. |
| `--server <url>` | Save this server address in `~/.lanes/config.json`. |
| `--token <token>` | Save this token in `~/.lanes/config.json`. |
| `--user <name>` | Save the name teammates see. |
| `--agents <names>` | Comma-separated. Default `claude`. Also installs each agent's own hooks or plugin in the repository and prints how to add `lanes mcp` to it. Hooks or plugins: `claude`, `codex`, `gemini`, `cursor`, `copilot`, `kiro`, `antigravity`, `factory`, `qwen`, `opencode`, `kilo`, `amp`. MCP only: `augment`, `junie`, `jetbrains`, `continue`, `zed`, `goose`, `warp`. |

Only the Claude Code adapter has been run against the real agent. The other adapters are built from each agent's documentation.

```sh
lanes init --agents claude,codex
git push
```

### off

```
lanes off [--dir <repo>] [--no-commit]
```

Switches Lanes off in a repository. It removes the Lanes hooks from `.claude/settings.json` and `settings.local.json`, `.codex/hooks.json`, `.gemini/settings.json`, `.cursor/hooks.json`, `.github/hooks/lanes.json` and `.kiro/hooks/lanes.json`, deletes `.lanes/hook.cjs` and `.lanes/server.cjs`, and commits only those changes. Your own hooks and settings stay. The `lanes/main` branch and `~/.lanes` are left alone, and `lanes init` switches Lanes back on.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository. Default: the current folder. |
| `--no-commit` | Remove the files but do not commit. |

Claude Code sessions that are already open keep their hooks until they restart.

```sh
lanes off
git push
```

### doctor

```
lanes doctor [--dir <repo>] [--server <url>]
```

Checks this machine and repository and prints one line per check, with what to do next when a check fails. It checks Node, git, the hooks in this repository, team context, the server and your token, and Claude Code. The exit code is 1 when a check fails; a line starting with `–` is information, not a failure.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository to check. Default: the current folder. |
| `--server <url>` | Check this server instead of the saved one. |

```sh
lanes doctor --dir ~/code/shop
```

### status

```
lanes status [--server <url>] [--token <token>]
```

Shows whether the server answers, and how many agents, held files and active tasks it knows. The exit code is 1 when the server is offline. Without options it uses the same server and token as the hooks: the environment, then `~/.lanes/config.json`, then the defaults.

| Option | Meaning |
|---|---|
| `--server <url>` | Ask this server instead. |
| `--token <token>` | Use this token. |

```sh
lanes status
# Lanes is running at http://127.0.0.1:4317: 3 agents (1 waiting), 2 files held, 2 active tasks
```

## Team server

### server

```
lanes server [--port <n>] [--host <addr>]
```

Starts the coordination server on this machine and prints its token. The default address is `127.0.0.1:4317`, which only this machine can reach. Use `--host 0.0.0.0` to let teammates connect; the command then prints the addresses and the `lanes connect` line to send them. If a Lanes server already runs on the port, it says so and starts nothing.

| Option | Meaning |
|---|---|
| `--port <n>` | Port, 1 to 65535. Default `LANES_PORT`, else 4317. |
| `--host <addr>` | Address to listen on. Default `127.0.0.1`. |

Teammates can connect by IP address, by the machine's name or by `<name>.local`. Any other host name must be listed in `LANES_ALLOWED_HOSTS`.

```sh
lanes server --host 0.0.0.0
```

### connect

```
lanes connect --server <url> --token <token> [--user <name>]
```

Points the hooks and the CLI on this machine at a teammate's server, with the shared team token. The server and token are saved in `~/.lanes/config.json`. VS Code follows unless its `lanes.serverUrl` setting says otherwise.

| Option | Meaning |
|---|---|
| `--server <url>` | Required. The server address, for example `http://192.168.1.20:4317`. |
| `--token <token>` | Required. The token `lanes server` printed. |
| `--user <name>` | The name teammates see. |

```sh
lanes connect --server http://192.168.1.20:4317 --token 3f9c... --user "Ana Rossi"
```

### invite

```
lanes invite <name> [--github <login>]
```

Run on the server's machine. Gives a teammate a personal token and prints the `lanes join` command to send them privately. The token is shown once, and inviting the same name again replaces it. Once a team has members, chat and requests need a personal token, so nobody can post or approve as someone else.

| Option | Meaning |
|---|---|
| `--github <login>` | No token is printed. The teammate runs `lanes login` and approves on GitHub instead. Needs `LANES_GITHUB_CLIENT_ID` set on the server. |

```sh
lanes invite bea --github bea-dev
# Invited bea as GitHub @bea-dev.
# Ask bea to run: lanes login --server http://192.168.1.20:4317
```

### join

```
lanes join <url> <token> [--user <name>]
```

Uses the personal token a teammate's `lanes invite` gave you. It saves the server and token in `~/.lanes/config.json`, checks that the server accepts the token and stores the name the server has for it. `--user` is only used when the server cannot say (a shared token, or an older server).

| Option | Meaning |
|---|---|
| `--user <name>` | Fallback name, used only when the server has none for the token. |

```sh
lanes join http://192.168.1.20:4317 lanes_m_... --user "bea"
```

### login

```
lanes login [--server <url>] [--print]
```

Signs you in with GitHub to a server whose admin ran `lanes invite <name> --github <login>`. It shows a code to enter on github.com, waits for you to approve, then saves the server, your personal token and your name in `~/.lanes/config.json`. The hooks, the CLI and VS Code on this machine then use them.

| Option | Meaning |
|---|---|
| `--server <url>` | The server. Default: the saved one. |
| `--print` | Do not open the browser; only print the link and code. |

```sh
lanes login --server http://192.168.1.20:4317
```

### members

```
lanes members
```

Run on the server's machine. Lists the teammates who have a personal token, with the date they were invited and their GitHub account if they have one.

No options.

```sh
lanes members
# 2 teammates have a personal token
#   ana  invited 2026-11-03  GitHub @ana-r
#   bea  invited 2026-11-05
```

### remove

```
lanes remove <name>
```

Run on the server's machine. Revokes a teammate's personal token at once. Their open requests, sent or received, can no longer be approved.

No options.

```sh
lanes remove bea
```

## Team context

These commands work as the person at this terminal, in the repository that contains the current folder. Their agents see the results through the hooks and through `lanes mcp`.

### team

```
lanes team [on|off] [--dir <repo>]
```

Turns team context on or off for a repository (preview). When it is on, every agent there gets a short team brief with each prompt, and a one-line heads-up before it edits or reads a file a teammate is changing. Edits are never blocked. The setting lives in `.lanes/team.json`; commit it so teammates get it. With no argument, the command shows whether it is on.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes team on
git add .lanes/team.json && git commit -m "Turn on Lanes team context"
```

### say

```
lanes say <message> [--dir <repo>]
```

Posts to the team chat of this repository. Agents only see messages that @mention their user (the name without spaces) or `@team`, and they see them quoted, as information. Put the message in quotes: PowerShell drops a bare `@name`.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes say "@bea the payments schema changed, pull before you touch checkout"
```

### ask

```
lanes ask <teammate> <request> [--edit] [--dir <repo>]
```

Asks a teammate's agent to do something. Nothing reaches their agent until that teammate approves it with `lanes approve`. The request is read only unless you pass `--edit`, and it expires in 30 minutes.

| Option | Meaning |
|---|---|
| `--edit` | Their agent may change files. |
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes ask bea "Check whether the new rate limiter covers /v1/upload"
```

### requests

```
lanes requests [--dir <repo>]
```

Lists the open requests sent to you and by you in this repository: id, status, who it is from or to, scope, time left and the text. A reply from the other agent appears on its own line below the request.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes requests
```

### approve

```
lanes approve <id> [--run [--agent claude|codex]] [--dir <repo>]
```

Approves a request sent to you; your agent gets it with your next prompt. With `--run` it runs now instead, with your own Claude Code or Codex login, and sends the answer back to the person who asked. A read-only request runs in Claude Code's plan mode or Codex's read-only sandbox. A request that may edit runs in a separate worktree on the branch `lanes/request-<id>`, which you review and merge yourself.

| Option | Meaning |
|---|---|
| `--run` | Run the request now, headless, and send the answer back. |
| `--agent claude\|codex` | With `--run`: which agent. Default: Claude Code if it is installed, else Codex. |
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes approve 3fa9c21e --run --agent codex
```

### deny

```
lanes deny <id> [--dir <repo>]
```

Declines a request sent to you. The person who asked sees it as declined in their sent requests.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository. Default: the current folder. |

```sh
lanes deny 3fa9c21e
```

## App and agents

### app

```
lanes app [--print] [--dir <repo>]
```

Opens the Lanes app in your browser: who is working on what, the team chat, and requests to approve. It works with any editor or agent. The link holds your token in its fragment, which never reaches the server's logs; do not share it.

| Option | Meaning |
|---|---|
| `--print` | Only print the link. |
| `--dir <repo>` | The repository the app opens on. Default: the current folder. Outside a repository the page lets you pick one. |

```sh
lanes app --print
```

### mcp

```
lanes mcp [--dir <repo>]
```

Runs the Lanes team tools as an MCP server over stdio, for any agent that supports MCP. The tools are `team_brief`, `team_check_file`, `team_say`, `team_ask`, `team_requests`, `team_status` and `team_members`. They are information only, and there is no tool to approve or decline a request. See [docs/mcp.md](mcp.md) for each tool and the setup line for each agent.

| Option | Meaning |
|---|---|
| `--dir <repo>` | The repository the tools work on. Default: the folder the agent starts the server in. |

```sh
claude mcp add lanes -- node <path>/lanes.cjs mcp
```

### report

```
lanes report [--json] [--file <path>] [--days <n>] [--server <url>] [--token <token>]
```

Prints what coordination did for the edits on this machine: edits that went ahead uncoordinated because the server was down, the coordinated share, collisions handled and time spent queued. It reads `~/.lanes/ledger.jsonl`, which holds counts and times only, never file paths, prompts or names. Nothing is sent anywhere.

| Option | Meaning |
|---|---|
| `--json` | Print the same as JSON. |
| `--file <path>` | Write a text file with the report and optional blank notes, which you may email if you want to. |
| `--days <n>` | The period, 1 to 365 days. Default 28. |
| `--server <url>` | Also ask this server. |
| `--token <token>` | Token for that server. |

```sh
lanes report --days 7
```

### pr

```
lanes pr [--task <task id, session or part of the title>] [--branch <name>] [--base <branch>] [--no-gh]
```

Squashes one task's checkpoint commits from `lanes/main` into a new branch and opens a pull request with `gh`. The commit has one `Co-authored-by` line per contributor. Without `gh`, or with `--no-gh`, it prints the commands to run instead. The checkpoint commits on `lanes/main` are left untouched, and an existing branch is never overwritten.

| Option | Meaning |
|---|---|
| `--task <...>` | Which task: its id, its session or part of its title. Needed when more than one task is waiting. |
| `--branch <name>` | The new branch. Default `lanes/pr/<title>`. |
| `--base <branch>` | The branch to start from. Default: the remote's default branch, else `main` or `master`. |
| `--no-gh` | Do not run `gh`; print the commands. |

```sh
lanes pr --task "rate limiter"
```

### hosted

```
lanes hosted
```

Prints the email to join the waitlist for the hosted server. The hosted server is planned and not built yet. It is a waitlist, not a purchase, and nothing is sent from here.

No options.

```sh
lanes hosted
```

## Environment variables

Settings in the environment win over `~/.lanes/config.json`.

| Variable | Meaning |
|---|---|
| `LANES_HOME` | Folder for per-user Lanes files (config, token, ledger). Default `~/.lanes`. |
| `LANES_SERVER` | Server address the hooks and the CLI use. Default `http://127.0.0.1:4317`. |
| `LANES_TOKEN` | Token to send to the server. A local server also uses it as its own token instead of `~/.lanes/token`. |
| `LANES_USER` | Your name as teammates see it. Default: the saved name, then `git config user.name`, then the OS account. |
| `LANES_EMAIL` | Email for the author of the checkpoint commits on `lanes/main`. Default: the saved one, then `git config user.email`. |
| `LANES_PORT` | Port of the server. Default 4317. |
| `LANES_HOST` | Address the server listens on. Default `127.0.0.1`. |
| `LANES_ALLOWED_HOSTS` | Comma-separated extra host names the server accepts, besides IP addresses and the machine's own name. |
| `LANES_GITHUB_CLIENT_ID` | On the server: the GitHub OAuth app client id. Turns on Sign in with GitHub (`lanes login`). |
| `LANES_LOG` | On the server: a file to append a JSON line per request to. Chat and request text is never written. |
| `LANES_TTL_MS` | On the server: how long a file stays held without activity, in milliseconds. Default 10 minutes. |
| `LANES_IDLE_EXIT_MS` | On the server: exit after this many milliseconds without requests. The server the hooks start uses 30 minutes. |
| `LANES_AUTOSTART` | `0`: the hooks do not start a local server when none answers. |
| `LANES_OFF` | `1`: every Lanes hook exits at once and does nothing. `lanes approve --run` sets it for the agent it runs. |
| `LANES_NO_PROMPT_TEXT` | `1`: task titles are "Agent task" instead of the first line of the prompt, so prompt text stays out of commits and the server. |
| `LANES_REMOTE` | Git remote the hooks publish to. Default `origin` when there is one; empty means local only. |
| `LANES_INTEGRATION` | Name of the shared branch. Default `lanes/main`. |
| `LANES_WAIT_MS` | How long an edit waits for a teammate's agent to release a file, in milliseconds. Default 240000 (4 minutes). |
| `LANES_NET_TIMEOUT_MS` | Timeout for the hooks' git fetch and push, in milliseconds. Default 10000 for fetch, 20000 for push. |
| `NO_COLOR` | Any value: no colour in the CLI's output. |
