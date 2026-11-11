# ADR-0031: Teammates sign in with GitHub; agents run on each person's own subscription

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** @mfmatozza
- **Related:** extends [ADR-0030](0030-personal-member-tokens.md) · [ADR-0029](0029-lanes-app-in-the-browser.md) · [ADR-0023](0023-security-baseline.md) · issue #261

## Context
ADR-0030 gave each teammate a personal token, but the token has to be copied from the admin to the teammate by hand. The founder asked on 1 November 2026 that people can log in with their own account.

Two separate things get called "logging in":
1. **Who you are on the team.** Today: a name and a token.
2. **Which AI subscription your agent uses.** Claude Code, Codex, Gemini CLI, Cursor and Copilot each sign in with their owner's own account (Claude Pro/Max, ChatGPT, Google, GitHub). Lanes is not in that path.

## Decision
**Identity: Sign in with GitHub, through the Lanes server.**
- The admin invites by GitHub handle: `lanes invite <name> --github <login>`.
- The teammate runs `lanes login`, or clicks "Sign in with GitHub" in the browser app. The Lanes server runs GitHub's device flow: it shows a short code, the teammate approves it on github.com, and the server reads their GitHub login and numeric id.
- If that login was invited, the server issues the member token of ADR-0030 and binds the GitHub id to it, so a renamed or recycled handle cannot take the seat. Otherwise it refuses.
- The server never stores the GitHub access token: it is used once to read the profile and dropped. The device flow needs only a public OAuth client id (no secret), set per server (`LANES_GITHUB_CLIENT_ID`). Until one is set, sign-in is hidden and manual invites keep working.
- Admin actions (invite, remove) need the server's own token **and** a call from the server's own machine. A teammate who still holds the shared LAN token cannot invite themselves or act as someone else.

**Subscriptions: Lanes never asks for a model API key.**
- Every agent keeps running on its owner's own subscription and login.
- An approved request runs with the receiver's own agent (`claude -p`, `codex exec`), on the receiver's machine and subscription. The asker's subscription is never used to run code on someone else's machine.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **GitHub device flow via the Lanes server (chosen)** | No client secret; works for CLI and browser; no redirect URL, so it works self-hosted on a LAN | Needs one OAuth app registered by the founder; GitHub only |
| OAuth web redirect flow | Familiar button | Needs a client secret and a fixed callback URL per server; breaks on LAN addresses |
| Google / Microsoft sign-in too | More people covered | More apps to register; developers almost all have GitHub |
| Lanes proxies model calls on a Lanes subscription | One bill | We would hold everyone's code and prompts, and resell tokens; against ADR-0010 and our security story |

## Consequences
- **Positive:** joining a team is "run `lanes login`, approve on GitHub". Identity is a real account, revocable by the admin, with no secret to copy. The security story against agentmash gets sharper: real accounts, no shared admin key, no API keys.
- **Negative / trade-offs:** GitHub is required for sign-in (manual tokens remain). The founder must register an OAuth app with device flow enabled and give its client id.
- **Follow-ups:** a default Lanes client id built in once registered; invite a whole GitHub organisation or team; the hosted relay uses the same flow.
