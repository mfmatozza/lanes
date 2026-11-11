# Multiplayer: requirements

Last updated: 1 November 2026 · Sources: competitors, agent integration, baseline, design

## The goal in one line
Every coding agent on a team knows what the others are changing, can hear the team, and can take a request from a teammate's agent once its owner approves. All of this keeps Lanes' guarantees: no edit is refused and no work is lost.

## Why we can win
agentmash (launched on Product Hunt on 1 Nov 2026, first build 28 Aug) warns agents but stops there: nothing is enforced by default, nothing saves work, the hook skips silently when their server is down, and the server is closed. Lanes already has real leases, a fair queue and checkpoint commits that never lose work, a free self-hosted server, and published lab evidence. What we lack is shared context, the number of agents we support, identity, and a hosted product. That is the list below.

## Must (slice 1 to 3)
| ID | Requirement | Beats agentmash because |
|---|---|---|
| M1 | **Team brief at each prompt.** A short, structured summary (≈400 tokens max): who is active, on what task, which files, plus @-mentions and requests for this person. Only for repositories that opt in. | Same idea, but enforced with leases behind it |
| M2 | **Heads-up before an edit.** When a teammate's active task touched or plans to touch the file, the agent is told who and what, factually, before it writes. The edit still goes ahead, through the lease queue. | Their warning is the only protection; ours sits on top of leases and checkpoints |
| M3 | **Team chat.** `lanes say`, the VS Code panel and an MCP tool post to the team. Agents see only @-mentions to their user or to `@team`, quoted as data. | Less noise in the agent's window (research: shorter context, better results) |
| M4 | **Ask a teammate's agent.** A request (read or edit scope, expires in 30 min) is delivered only after the receiving person approves it. Edit requests run under the normal leases. | Theirs runs outside any lock; ours can't overwrite anyone |
| M5 | **MCP server** (`lanes mcp`): tools `team_brief`, `team_say`, `team_ask`, `team_requests`. Gives every MCP-capable agent the team context, not just Claude Code. | Same breadth path, open protocol |
| M6 | **Fail open, visibly.** If the server is down, edits go ahead (ADR-0019) and the views and status say coordination is paused. Never silent. | Their hook skips silently |
| M7 | **Untrusted text handling.** Text from teammates (chat, requests, task titles, names, paths) is sanitised: control and invisible characters stripped, length capped, always quoted with the author named, and never phrased as a system instruction. | They inject raw prompts into other agents |

## Should (slice 4 to 6)
- S1 **Per-user identity:** personal member tokens issued by the server ([ADR-0030](../../docs/decisions/0030-personal-member-tokens.md)), later GitHub sign-in, so a request can't be approved by someone pretending to be the receiver. Needed before approvals leave a trusted team (baseline note 6).
- S2 **More agents:** Codex, Cursor, Gemini CLI and Copilot hook adapters, ranked by the agents.json tiers.
- S3 **Line-range overlap:** `git diff -U0` ranges, so two agents editing the same file in different places aren't flagged.
- S4 **End-to-end encryption** of room content (chat, requests, titles) with a room key the server never sees.
- S5 **Hosted relay and `npx lanes login`:** the same server image, hosted.
- S6 **Headless execution** of approved requests (`claude -p` in a separate worktree for edit scope).

- S7 **Lanes app in the browser** (`lanes app`): team, chat and approvals for people using any editor or agent ([ADR-0029](../../docs/decisions/0029-lanes-app-in-the-browser.md)).

## Could
- Symbol-level leases (tree-sitter) · a public benchmark with methodology · an open protocol spec · `lanes scan` funnel.

## Won't (now)
- Customer interviews (ADR-0012).
- Sharing file contents or diffs by default (ADR-0010).
- An Electron desktop app. Lanes is no longer VS Code only: the server serves a browser app ([ADR-0029](../../docs/decisions/0029-lanes-app-in-the-browser.md)).
- Agent-to-agent free chat: agents act on structured facts, and free text from people reaches them only as quoted data.
