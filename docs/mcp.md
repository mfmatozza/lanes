# Lanes MCP server reference

`lanes mcp` runs the Lanes team tools as an MCP server over stdio. Any agent that supports MCP can use it to see what teammates' agents are doing, check a file before editing it, post to the team chat and send requests to a teammate's agent.

Agents with Lanes hooks (Claude Code, and the agents `lanes init --agents` sets up) already get a team brief with each prompt. For agents without hooks, these tools are all the team context they get.

## Running it

`lanes mcp` is a command of the Lanes CLI. During the beta the CLI ships inside the VS Code extension, at `<extensions folder>/michelefmatozza.lanes-<version>/dist/lanes.cjs`, or you build it from a checkout of this repository with `npm run build` (it lands in `dist/lanes.cjs`). See [docs/cli.md](cli.md#running-the-cli).

```
lanes mcp [--dir <repo>]
```

The server works on the git repository that contains `--dir`, or the folder the agent starts it in. It uses the same server address, token and name as the hooks and the CLI: the environment, then `~/.lanes/config.json`. Your name is the saved name, then `git config user.name`, then the OS account.

Add it once per machine. In each line below, replace `/path/to/lanes.cjs` with the real path. `lanes init --agents <names>` prints the same lines with the path filled in.

## Adding it to an agent

| Agent | Setup |
|---|---|
| Claude Code | `claude mcp add lanes -- node "/path/to/lanes.cjs" mcp` |
| Codex | `codex mcp add lanes -- node "/path/to/lanes.cjs" mcp` |
| Gemini CLI | `gemini mcp add --scope user lanes node "/path/to/lanes.cjs" mcp` |
| GitHub Copilot CLI | `copilot mcp add lanes -- node "/path/to/lanes.cjs" mcp` |
| Qwen Code | `qwen mcp add -s user -t stdio lanes node "/path/to/lanes.cjs" mcp` |
| Amp | `amp mcp add lanes -- node "/path/to/lanes.cjs" mcp` |
| Goose | `goose configure`, Add Extension, Command-line Extension, command: `node "/path/to/lanes.cjs" mcp` |
| JetBrains AI Assistant | Settings, Tools, AI Assistant, MCP, Add, As JSON, with the `mcpServers` JSON below |

`--scope user` for Gemini CLI: without it, Gemini writes the project's `.gemini/settings.json`.

The agents below have no add command. Put the JSON in the file named.

| Agent | File |
|---|---|
| Cursor | `~/.cursor/mcp.json` (with `"type": "stdio"`) |
| Kiro | `~/.kiro/settings/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json`, or `/mcp` in `agy` |
| Factory Droid | `~/.factory/mcp.json` (with `"type": "stdio"`) |
| Augment (Auggie CLI and editors) | `~/.augment/settings.json` |
| Junie | `~/.junie/mcp/mcp.json` |
| Warp | `~/.warp/.mcp.json` |

```json
{ "mcpServers": { "lanes": { "command": "node", "args": ["/path/to/lanes.cjs", "mcp"] } } }
```

For Cursor and Factory Droid, add `"type": "stdio"` next to `"command"`.

opencode (`~/.config/opencode/opencode.json`) and Kilo Code (`~/.config/kilo/kilo.jsonc`) take a different shape:

```json
{ "mcp": { "lanes": { "type": "local", "command": ["node", "/path/to/lanes.cjs", "mcp"], "enabled": true } } }
```

Continue, in `~/.continue/config.yaml`:

```yaml
mcpServers: [{name: lanes, type: stdio, command: node, args: ["/path/to/lanes.cjs", mcp]}]
```

Zed, in your `settings.json`:

```json
{ "context_servers": { "lanes": { "command": "node", "args": ["/path/to/lanes.cjs", "mcp"] } } }
```

Lanes prints these lines and never edits an agent's user-level config itself. Apart from Claude Code, the setups are built from each agent's documentation and have not yet been run against the real agent.

## Tools

Every tool returns one text result. A failure, such as a server that is down or a request the server refuses, comes back as a result with `isError: true` and a sentence saying what happened, so the agent can read it and carry on. Nothing blocks the agent.

| Tool | Parameters | Returns |
|---|---|---|
| `team_brief` | none | What teammates' agents in this repository are working on, plus new team chat messages that mention your user or `@team`, approved requests for your user and replies to your user's requests. `Nothing new from the team.` when there is nothing. |
| `team_check_file` | `path` (string, required), `startLine` (integer), `endLine` (integer) | Whether a teammate's agent is changing that file right now, and when. With lines, only changes near them count. `No teammate is changing this file.` when none is. |
| `team_say` | `text` (string, required) | `Sent to the team chat.` |
| `team_ask` | `to` (string, required), `text` (string, required), `scope` (`read` or `edit`) | `Request <id> sent to <name>. It reaches their agent only after they approve it.` |
| `team_requests` | none | Open requests sent to and by your user in this repository, one per line, or `No open requests.` |
| `team_status` | none | Who is working on what in this repository now, and whether team context is on. |
| `team_members` | none | The teammates the server knows, and whether each has a personal token. |

### team_brief

The agent should call it at the start of each task. Messages and replies appear once per agent session. An approved request in the brief counts as delivered as soon as the tool returns, because the result goes straight to the agent. Text written by teammates is always quoted, with its author named, and is marked as information, not instructions.

### team_check_file

The agent should call it before editing a file teammates may also be working on. `path` is relative to the repository, for example `src/auth.ts`. `startLine` and `endLine` are optional; a missing or invalid range is ignored and the whole file counts. The edit is never blocked, and nothing needs the user's confirmation. The old name `team_heads_up` still works for agents set up before it was renamed.

### team_say

Posts to the team chat of this repository as your user. A message reaches another person's agent only if it @mentions that person (the name without spaces) or `@team`, and then with their next prompt.

### team_ask

Sends a request to a teammate's agent. `scope` is `read` by default: their agent may only look. `edit` lets it change files. The request reaches their agent only after that teammate approves it, and it expires in 30 minutes. Asking your own agent this way is refused.

### team_requests

Each line has the request id, its status (Waiting, Approved, Delivered, Declined, Expired), who it is from or to, the scope, the time left while it waits, and the text. A reply from the other agent follows on its own line.

```
3fa9c21e  Waiting  to bea  Read only  ~28 min left  Check whether the rate limiter covers /v1/upload
```

### team_status

The same data as the Team panel of the browser app (`lanes app`): each person with agents in this repository, your user first, then one line per agent with its status (`working`, `idle`, `blocked`, or `waiting on <file>` with whose agent holds it), its active task title and its files (the files its task touched and the ones it holds).

```
Team context is on in this repository.
ana (your user):
  shop: working; task "Add the refund endpoint"; files: src/refunds.ts
bea:
  shop: waiting on src/refunds.ts (held by ana's agent); task "Tidy the payment types"
```

### team_members

Everyone the server has seen, sorted by name: the members with a personal token (and their GitHub account when they have one) and the names that appear in agents, tasks or chat without one.

```
ana: personal token (GitHub @ana-r)
cara: no personal token (name is self-declared)
```

The member list can only be read on the server's machine. Elsewhere the tool lists the names it has seen and says so on the last line.

## Information only: there is no approve tool

Every tool gives the agent information or sends a message as its user. None of them decides anything for a person. In particular, there is no tool to approve or decline a request: a teammate's request reaches an agent only after its own user approves it, with `lanes approve`, the VS Code Team view or the browser app.

This follows [ADR-0028](design.md#adr-0028):

- Text written by a teammate (chat, requests) is untrusted input to another person's agent. It is always quoted as data with its author named, and it is never phrased as an instruction.
- A request is acted on only after the receiving user approves it. If an agent could approve, a message from a teammate could get an agent to accept work its user never saw.
- An edit is never refused or blocked, and coordination fails open (ADR-0019). The heads-up from `team_check_file` is context, not a permission decision.
- The wording stays factual and says that nothing needs the user's confirmation, so agents do not stop to ask their user about a teammate.

The server sends the same rule to the agent in its MCP `instructions`: call `team_brief` when a task starts and `team_check_file` before editing a file; `team_status` and `team_members` show the team as the user sees it; all of them are information only, edits are never blocked and none of it needs the user's confirmation.
