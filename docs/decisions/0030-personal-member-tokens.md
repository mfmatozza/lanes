# ADR-0030: Each teammate gets a personal token, and the server decides who is calling

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** @mfmatozza
- **Related:** extends [ADR-0023](0023-security-baseline.md) · [ADR-0028](0028-agents-share-team-context.md) · requirement S1 in [multiplayer/plan/requirements.md](../../multiplayer/plan/requirements.md) · issue #261

## Context
Every client sends its user name, and the server believes it. With one shared team token, anyone on the team can post chat as someone else or approve a request sent to someone else. That was acceptable for leases (a wrong name only mislabels a lock) but not for requests, which make one person's agent act on another person's behalf.

agentmash has the same hole in a worse form: anyone holding the room key is an admin. Fixing it in Lanes is a selling point, not just hygiene.

The plan named GitHub sign-in (device flow). That needs an OAuth app registered by the founder and a hosted callback, so it cannot be built or tested yet.

## Decision
The server issues personal **member tokens** now. GitHub sign-in can later issue the same kind of token.

- The admin is the server's own token used from the server's own machine ([ADR-0031](0031-sign-in-with-github.md)), so a teammate holding the shared LAN token is not an admin. The admin invites teammates: `lanes invite <name>` prints a one-time `lanes join` command with a new random token for that name.
- `lanes join` stores the server address, the token and the name in `~/.lanes/config.json`, the file the hook, the CLI and the extension already read.
- The server keeps only a SHA-256 hash of each member token, in a private file in its Lanes folder (`members.json`, mode 0600). A lost token is replaced, never recovered. `lanes remove <name>` revokes it at once.
- **A request with a member token is that member.** The server replaces the `user` field of every request with the member's name, so a teammate cannot speak, lock or approve as anyone else.
- **Once a team has members, the shared token cannot act as a person on team routes:** chat, requests, approvals and replies need a member token. The shared token keeps working for leases and checkpoints, so no edit is ever blocked by this (ADR-0019).
- A team with no members works exactly as before: names are self-declared.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Server-issued member tokens (chosen)** | Works today, self-hosted and offline; no third party; revocation is instant | The admin hands tokens over a side channel (chat, password manager); no single sign-on |
| GitHub device flow now | Real accounts, no token handover | Needs a registered OAuth app and a hosted callback; blocks on the founder |
| Signed requests with per-machine keys | Strongest, no shared secret on the server | Much more code; key management on every client |
| Keep self-declared names | No work | Anyone can approve as anyone: unacceptable for agent requests |

## Consequences
- **Positive:** approvals, chat and requests carry a name the server checked. The security story becomes "personal tokens, instant revocation, nothing stored in plain text", against a competitor whose room key is an admin key.
- **Negative / trade-offs:** an invite step for each teammate; tokens can still be copied, like any bearer token.
- **Follow-ups:** GitHub sign-in that issues member tokens (needs an OAuth app); roles beyond admin and member; showing "verified" next to names in the views.
