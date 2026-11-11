# ADR-0010: Local-first, bring your own agent

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** Business model, [Security](../architecture/security.md)

## Context
Anthropic doesn't allow third-party products to offer claude.ai login or subscription rate limits without prior approval. Hosting agents would mean either reselling tokens or handling customers' API keys and code, which brings cost, compliance and trust problems. Users already have their agents set up the way they like them.

## Decision
- Agents run **on each developer's own machine**, under **their own login and subscription**.
- Lanes only coordinates them: it carries metadata and never file contents or model traffic.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Local, bring your own agent (chosen)** | No token costs; no licensing issue; code never leaves the machine; easy security review | No always-on cloud agents; we depend on users' local setup |
| Hosted agent runners | Agents keep running when laptops are closed | Token resale or key custody; compute costs; Anthropic approval needed |

## Consequences
- Cloud agents may become an optional add-on later, running in the customer's own infrastructure.
- The setup experience on users' machines (Node, git) has to be robust.
