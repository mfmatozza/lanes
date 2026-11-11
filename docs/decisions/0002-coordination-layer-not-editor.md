# ADR-0002: Build a coordination layer, not an editor

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** Product strategy, Competitive positioning

## Context
The original idea was a "Zed for agents": a full shared IDE. Research found several close competitors in that space:
- **Zed Delta**, in public beta since September 2026, with a CRDT-based multiplayer editor and Sequoia funding;
- Coshell, AQ, Conductor Cloud and Replit Agent 4.

Building an editor is expensive: language servers, terminals, debugging. It also forces users to migrate. Meanwhile the clearest gap, collision avoidance across humans, doesn't depend on owning the editor.

## Decision
Build Lanes as an **editor-neutral coordination layer**: a server, an agent integration, and thin editor clients. The first client is VS Code. We don't build an editor.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Coordination layer (chosen)** | Small scope; no migration for users; works with any editor and agent; differentiated | Less control over the UX; depends on the host editor's extension APIs |
| Fork VS Code or Zed | Full UX control | Huge maintenance burden; head-on competition with Zed Delta; users must migrate |
| Web IDE | Zero install | Have to rebuild LSP, terminal and debugging; competes with Replit and cloud tools |

## Consequences
- Our UX is limited to what the VS Code extension API exposes (tree views, decorations, notifications, webviews).
- We can later ship clients for Zed, JetBrains and the terminal without changing the core.
- The moat must come from the coordination intelligence, not from the editor.
