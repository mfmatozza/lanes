# Changelog

All notable changes to the Lanes extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semver](https://semver.org) (`0.x` during the beta).

## 0.3.0 - 2026-11-11

### Added
- Team context for agents, off until turned on per repository with **Lanes: Turn On Team Context** or `lanes team on` (writes `.lanes/team.json`; commit it). Agents get a short team brief with each prompt and a one-line heads-up before they edit or read a file a teammate is changing. Edits are never blocked.
- The heads-up for an edit uses line ranges: when both sides' changed lines are known, it comes only if they are within a few lines of each other.
- In Claude Code, with team context on, a one-time note at the end of a turn when a file the agent read changed under it, or a teammate's new file imports a file it changed.
- Team view in the Lanes sidebar: requests waiting for you (Approve, Decline), the requests you sent and their replies, and the team chat. A notification for each new request.
- Commands: **Lanes: Message the Team**, **Lanes: Ask a Teammate's Agent**, **Lanes: Approve Request**, **Lanes: Decline Request**, **Lanes: Turn On Team Context**, **Lanes: Turn Off Team Context**, **Lanes: Open Team App**, **Lanes: Copy Sign-In Command**. The palette shows only the team context command that applies, and the Team view says when team context is off.
- **Lanes: Open Team App** checks that the server answers first, and offers **Lanes: Start Local Server** when it does not.
- Requests between agents: a request reaches a teammate's agent only after the teammate approves it. `lanes approve <id> --run [--agent claude|codex]` runs it now and sends the answer back; a request that may edit runs on branch `lanes/request-<id>`.
- Browser app at `/app` on the Lanes server, opened with **Lanes: Open Team App** or `lanes app`: team, files, chat and requests, a Ctrl K palette, file search, an activity timeline and opt-in notifications.
- Personal member tokens: `lanes invite`, `lanes join`, `lanes members`, `lanes remove`. With a member token the server sets the caller's name, so nobody can post or approve as someone else.
- Sign in with GitHub: `lanes login --server <url>`, for a seat made with `lanes invite <name> --github <account>`. Needs `LANES_GITHUB_CLIENT_ID` on the server.
- Other agents with `lanes init --agents <names>`: hooks or a plugin for Codex, Gemini CLI, Cursor, GitHub Copilot, Kiro, Antigravity, Factory Droid, Qwen Code, opencode, Kilo Code and Amp, and printed MCP setup for Augment, Junie, JetBrains AI Assistant, Continue, Zed, Goose and Warp. Built from each agent's docs; only Claude Code has been run against the real agent.
- `lanes doctor`: one line per check (Node, git, the hooks in this repository, team context, the server, your token, Claude Code) with what to do next, for when something looks wrong.
- `lanes mcp`: an MCP server with the team tools (`team_brief`, `team_check_file`, `team_say`, `team_ask`, `team_requests`). It has no approve tool, so only a person can approve.

### Changed
- The status bar also counts requests waiting for you.
- "Release Lease" is now **Lanes: Release File**, and the views use plainer wording.
- `lanes.serverUrl`, `lanes.token` and `lanes.userName` fall back to what `lanes join` or `lanes login` saved.
- The committed hook line ends `; exit 0`, so Windows PowerShell 5.1 can parse it.
- The server sends one snapshot per change to all viewers and accepts up to 128 live connections (browser app and VS Code windows).

### Fixed
- Another session's git operations no longer touch a file an agent is writing.
- A `~/.lanes/config.json` that is not a JSON object no longer breaks every hook and command.
- Hidden format characters are stripped from names and chat, mentions match Unicode names, and chat floods are capped.
- Removing a member closes their open requests.

## 0.2.0 - 2026-11-01

### Added
- Coloured state icons in the Agents and Tasks views, and a colour per person.
- Explorer badges in their own theme colours (`lanes.heldByTeammate`, `lanes.heldByYou`; change them under `workbench.colorCustomizations`).
- A status bar that changes icon and colour with the team's state, with a hover that lists who is editing what, who waits, and links into the views.
- Hovers on agents, people and held files that say what each state means in plain words.

