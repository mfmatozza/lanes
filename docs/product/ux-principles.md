# UX principles

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-11-01
> [Docs](../README.md) › Product › UX principles · [← User journeys](user-journeys.md) · [Glossary →](glossary.md)

1. **Ambient, not demanding.** Show state through quiet signals: file badges, the status bar, the tree view. Pop-up notifications are only for things a human must act on.
2. **Nothing is refused, everything is explained.** Agents are never refused and never told about Lanes ([ADR-0019](../decisions/0019-never-refuse-an-edit.md)). Exception: in a repository that turns on multiplayer team context, agents get a short factual team brief ([ADR-0028](../decisions/0028-agents-share-team-context.md)); they are still never refused. Humans can always see in the views *who* holds a file, *how long* it has been held, and *what Lanes is doing about it*.
3. **Agents belong to people.** Always show an agent as "Ana's agent", never as an anonymous session ID. Ownership drives trust and responsibility.
4. **One glance, one answer.** The status bar answers "is anything wrong?". The Agents view answers "who is doing what?". The explorer answers "can I touch this file?".
5. **Humans are never blocked by Lanes.** We warn people; we only queue agents.
6. **Recoverable by default.** Every lease can be released by hand, and every lease expires on its own. Nothing gets permanently stuck.
7. **Zero-config for teammates.** After one person runs setup and commits it, everyone else only installs the extension.
8. **Consistent vocabulary.** Use the terms in the [Glossary](glossary.md), and nothing else, in UI text, docs and code.

## UI text style
- Sentence case, no exclamation marks, no emoji in product UI.
- Name people and files: *"Ana's agent holds `session.ts`"*, not *"Resource locked"*.
- For time, prefer relative values ("~4 min", "8 min ago").
