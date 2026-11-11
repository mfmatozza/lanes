# ADR-0029: Lanes gets an app in the browser, served by the Lanes server

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** @mfmatozza
- **Related:** amends the "Won't: a separate desktop app" line of [multiplayer/plan/requirements.md](../../multiplayer/plan/requirements.md) · [ADR-0028](0028-agents-share-team-context.md) · [ADR-0023](0023-security-baseline.md) · issue #261

## Context
Until now, people saw Lanes only in VS Code. Every agent other than Claude Code inside VS Code was invisible to the rest of the team, and so were the people behind those agents: someone using Codex in a terminal, Cursor, or JetBrains could not see the team, read the chat, or approve a request.

The founder decided on 1 November 2026 that Lanes moves beyond being a VS Code extension. agentmash ships a desktop "lobby" app (Electron) for the same reason.

## Decision
The Lanes server serves a small web app at `/app`. `lanes app` opens it in the default browser.

What the app shows and does:
- who is working, on which task and files, and who is waiting for whom;
- whether coordination is running or paused (fail-open is never silent: requirement M6);
- the team chat, with a box to post;
- requests: Approve and Decline for the ones sent to you, and the status and reply of the ones you sent.

How it stays safe:
- The page holds no data, so `/app` itself needs no token. Its script reads the token from the URL fragment (`#token=`), which the browser never sends to the server, stores it in `sessionStorage`, and removes it from the address bar.
- Every data call is the normal API: `Authorization: Bearer` on `fetch`, and `?token=` on the `/v1/events` WebSocket, which already checks `Origin`. The page's own origin is the server, so no CORS is opened.
- A strict Content-Security-Policy: scripts, styles and connections only from the server itself; no inline script; nothing from a CDN.
- Teammate text is rendered with `textContent`, never as HTML.

It is a plain HTML page with no framework and no build step beyond the existing bundle, so it ships inside `server.cjs`.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Web app served by the Lanes server (chosen)** | Works with any editor and any OS; nothing new to install; one codebase; the same server already holds the data | Lives in a browser tab, not a dock icon; no OS notifications yet |
| Electron desktop app, like agentmash | Dock icon, native notifications | A second product to build, sign and update on three OSes; 100+ MB download |
| Stay VS Code only | No new work | Locks out Codex, Cursor and JetBrains users, the breadth agentmash leads on |
| Terminal UI | Fits CLI agents | Hard to approve requests and read chat comfortably; still one more surface |

## Consequences
- **Positive:** every teammate can see the team and approve requests, whatever editor or agent they use. The same page can later be served by the hosted relay.
- **Negative / trade-offs:** one more surface to keep in line with the VS Code views; a browser tab is easier to forget than an editor panel.
- **Follow-ups:** browser notifications for new requests (opt-in); a desktop wrapper only if teams ask for it.
